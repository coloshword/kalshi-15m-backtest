// Kalshi trading fees, as a paper-trading engine books them.
//
// Schedule: Kalshi's fee schedule "last updated and effective July 7, 2026",
// plus Kalshi's fee-rounding doc (https://docs.kalshi.com/getting_started/fee_rounding)
// as it read on 2026-10-06. Check both before relying on this: fees are
// per-series market data (GET /series/{ticker}: fee_type, fee_multiplier) and can change.
//
// Formula, per fill, in dollars (P = price in dollars, C = contracts):
//   taker  M × 0.07   × C × P × (1 − P)   (M defaults to 1)
//   maker  M × 0.0175 × C × P × (1 − P)   (M defaults to 0: makers are free unless
//                                           the series' fee_type is quadratic_with_maker_fees)
//
// Rounding (the doc's "Rounding Mechanics"):
//   1. trade fee = the formula fee rounded UP to $0.000001 (one micro-dollar, µ$);
//   2. the fill's signed cash change (revenue − trade fee) is floored to the
//      account's balance precision: $0.0001 for a direct member (an account with
//      Kalshi itself, the API default), $0.01 for an FCM-cleared account;
//   3. what the floor took is a "rounding fee", collected per ORDER in an accumulator;
//   4. the accumulator is rebated in whole increments of the precision, capped so a
//      fill's net fee is never negative.
// For a direct member, one fill of whole contracts therefore pays the formula fee
// rounded up to the hundredth of a cent ($0.0001), not to the whole cent: 1 contract
// at 50¢ pays 1.75¢, at 95¢ pays 0.34¢. Rounding up to the whole cent is the
// FCM-cleared case (BALANCE_PRECISION_MICROS.fcm).
//
// Units: prices in centicents ($0.0001; 50¢ = 5000), counts in hundredths of a
// contract (1 contract = 100), fees and cash in micro-dollars (1 centicent = 100 µ$).
// All arithmetic is integer; no float reaches a money value.

/** µ$ per centicent. */
export const MICROS_PER_CENTICENT = 100;

/** The two balance precisions Kalshi's rounding doc names, in µ$. */
export const BALANCE_PRECISION_MICROS = Object.freeze({ direct: 100, fcm: 10_000 });

// 0.07 × (h/100) × (p/10⁴) × ((10⁴−p)/10⁴) dollars × 10⁶ µ$/dollar = 7·h·p·(10⁴−p) / 10⁶;
// the maker's 0.0175 is a quarter of that.
const COEFF_DEN = { taker: 1_000_000, maker: 4_000_000 };

/**
 * Trade fee for one fill, in µ$, rounded up to the µ$.
 * @param {{role: "taker"|"maker", countHundredths: number, priceCenticents: number, multiplier?: number}} fill
 */
export function tradeFeeMicros(fill) {
  const m = fill.multiplier ?? (fill.role === "taker" ? 1 : 0);
  const raw = (m * 7 * fill.countHundredths * fill.priceCenticents * (10000 - fill.priceCenticents)) / COEFF_DEN[fill.role];
  return Math.ceil(raw);
}

/** The trade fee rounded up to the centicent: what a direct member pays for one fill of whole contracts. */
export function tradeFeeCenticents(fill) {
  return Math.ceil(tradeFeeMicros(fill) / MICROS_PER_CENTICENT);
}

/** A fill's signed revenue in µ$ (negative for buys), exact: hundredths × centicents. */
export function revenueMicros(action, countHundredths, priceCenticents) {
  const notional = countHundredths * priceCenticents;
  return action === "buy" ? -notional : notional;
}

/**
 * Kalshi's rounding pipeline for one fill (steps 2–4 above). Pass the returned
 * accumulatorMicros to the same order's next fill.
 * @param {{revenueMicros: number, tradeFeeMicros: number, accumulatorMicros?: number, precisionMicros?: number}} fill
 */
export function settleFill(fill) {
  const precision = fill.precisionMicros ?? BALANCE_PRECISION_MICROS.direct;
  const change = fill.revenueMicros - fill.tradeFeeMicros;
  const aligned = Math.floor(change / precision) * precision;
  const roundingFee = change - aligned;
  const gross = fill.tradeFeeMicros + roundingFee;

  let accumulator = (fill.accumulatorMicros ?? 0) + roundingFee;
  // whole increments of the precision, never more than this fill's own fee
  const rebate = Math.floor(Math.min(accumulator, gross) / precision) * precision;
  accumulator -= rebate;

  return {
    netFeeMicros: gross - rebate,
    balanceChangeMicros: aligned + rebate,
    roundingFeeMicros: roundingFee,
    rebateMicros: rebate,
    accumulatorMicros: accumulator,
  };
}

// ---- convenience, in cents ------------------------------------------------------------

const toCenticents = (priceCents) => {
  const p = Math.round(priceCents * 100);
  if (!(p >= 1 && p <= 9999)) throw new RangeError(`price must be between 0.01 and 99.99 cents, got ${priceCents}`);
  return p;
};

/**
 * Taker fee in cents for one order of whole contracts filled at one price (direct member).
 * takerFeeCents(50) → 1.75; takerFeeCents(95) → 0.34; takerFeeCents(50, 100) → 175.
 */
export function takerFeeCents(priceCents, contracts = 1, multiplier = 1) {
  const c = tradeFeeCenticents({ role: "taker", countHundredths: contracts * 100, priceCenticents: toCenticents(priceCents), multiplier });
  return c / 100;
}

/**
 * The win rate (0–1) a taker needs at `priceCents` to break even after the fee:
 * (price + fee per contract) / 100¢. breakeven(95) → 0.9534.
 */
export function breakeven(priceCents, contracts = 1, multiplier = 1) {
  const p = toCenticents(priceCents);
  const fee = tradeFeeCenticents({ role: "taker", countHundredths: contracts * 100, priceCenticents: p, multiplier });
  return (p + fee / contracts) / 10000;
}
