// Expected values come from Kalshi's own sources: the fee-schedule PDF (formulas,
// effective 2026-07-07) and the fee-rounding doc's worked examples, as it read on
// 2026-10-06 (https://docs.kalshi.com/getting_started/fee_rounding).
// Prices are centicents (50¢ = 5000); fees and balances are µ$ (1 centicent = 100 µ$);
// counts are hundredths of a contract.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BALANCE_PRECISION_MICROS, breakeven, revenueMicros, settleFill, takerFeeCents, tradeFeeCenticents, tradeFeeMicros } from "./fees.js";

const FCM = BALANCE_PRECISION_MICROS.fcm;
const like = (actual, expected) => {
  for (const [k, v] of Object.entries(expected)) assert.equal(actual[k], v, k);
};

describe("tradeFeeMicros: the PDF formulas, rounded up to $0.000001", () => {
  it("taker peak: 100 contracts @ 50¢ = $1.75 exactly", () => {
    assert.equal(tradeFeeMicros({ role: "taker", countHundredths: 10000, priceCenticents: 5000 }), 1_750_000);
  });

  it("ceils to the µ$, not the centicent: the doc's model fee $0.00363825 → $0.003639", () => {
    assert.equal(tradeFeeMicros({ role: "taker", countHundredths: 100, priceCenticents: 550 }), 3639);
    assert.equal(tradeFeeMicros({ role: "taker", countHundredths: 100, priceCenticents: 2500 }), 13125);
  });

  it("is symmetric in P ↔ 1−P", () => {
    for (const p of [1, 550, 2500, 3301, 4999]) {
      assert.equal(
        tradeFeeMicros({ role: "taker", countHundredths: 700, priceCenticents: p }),
        tradeFeeMicros({ role: "taker", countHundredths: 700, priceCenticents: 10000 - p }),
      );
    }
  });

  it("maker: free by default (M 0); at M 1 the 0.0175 coefficient, a quarter of the taker's", () => {
    assert.equal(tradeFeeMicros({ role: "maker", countHundredths: 10000, priceCenticents: 5000 }), 0);
    assert.equal(tradeFeeMicros({ role: "maker", countHundredths: 10000, priceCenticents: 5000, multiplier: 1 }), 437_500);
  });

  it("multiplier 0.5 (a half-fee series) stays exact", () => {
    assert.equal(tradeFeeMicros({ role: "taker", countHundredths: 100, priceCenticents: 5000, multiplier: 0.5 }), 8750);
    assert.equal(tradeFeeMicros({ role: "maker", countHundredths: 100, priceCenticents: 5000, multiplier: 0.5 }), 2188);
  });

  it("scales with hundredths: 0.03 contract @ 33.01¢ → 465 µ$", () => {
    assert.equal(tradeFeeMicros({ role: "taker", countHundredths: 3, priceCenticents: 3301 }), 465);
  });

  it("tradeFeeCenticents is the µ$ fee ceiled to the centicent", () => {
    assert.equal(tradeFeeCenticents({ role: "taker", countHundredths: 100, priceCenticents: 550 }), 37);
    assert.equal(tradeFeeCenticents({ role: "taker", countHundredths: 10000, priceCenticents: 5000 }), 17500);
  });
});

describe("revenueMicros: exact, signed", () => {
  it("is count × price with no rounding, even for a fraction of a contract", () => {
    assert.equal(revenueMicros("buy", 100, 550), -55_000);
    assert.equal(revenueMicros("sell", 3, 3301), 9903);
  });
});

describe("settleFill: the doc's worked examples (FCM-cleared, $0.01 precision)", () => {
  it("revenue −$0.055, trade fee $0.003639 → balance −$0.06, fees exactly $0.005", () => {
    assert.deepEqual(settleFill({ revenueMicros: -55_000, tradeFeeMicros: 3639, precisionMicros: FCM }), {
      netFeeMicros: 5000,
      balanceChangeMicros: -60_000,
      roundingFeeMicros: 1361,
      rebateMicros: 0,
      accumulatorMicros: 1361,
    });
  });

  it("accumulator across fills: three fills each adding $0.004 → $0.010 rebate on the third, $0.002 carried", () => {
    const fill = (acc) => settleFill({ revenueMicros: -50_000, tradeFeeMicros: 6000, accumulatorMicros: acc, precisionMicros: FCM });
    const f1 = fill(0);
    const f2 = fill(f1.accumulatorMicros);
    const f3 = fill(f2.accumulatorMicros);
    assert.deepEqual([f1.accumulatorMicros, f2.accumulatorMicros], [4000, 8000]);
    assert.deepEqual([f1.rebateMicros, f2.rebateMicros, f3.rebateMicros], [0, 0, 10_000]);
    assert.equal(f3.accumulatorMicros, 2000);
    assert.equal(f3.netFeeMicros, 0);
  });

  it("the rebate is capped so the fill's net fee cannot be negative", () => {
    let acc = 0;
    for (let i = 0; i < 4; i++) {
      const f = settleFill({ revenueMicros: -55_000, tradeFeeMicros: 0, accumulatorMicros: acc, precisionMicros: FCM });
      assert.equal(f.rebateMicros, 0);
      assert.equal(f.netFeeMicros, 5000);
      acc = f.accumulatorMicros;
    }
    assert.equal(acc, 20_000);
    const big = settleFill({ revenueMicros: -500_000, tradeFeeMicros: 17_500, accumulatorMicros: acc, precisionMicros: FCM });
    like(big, { roundingFeeMicros: 2500, rebateMicros: 20_000, netFeeMicros: 0, accumulatorMicros: 2500 });
  });

  it("rebates when the carry reaches exactly one increment", () => {
    const f1 = settleFill({ revenueMicros: -500_000, tradeFeeMicros: 15_000, precisionMicros: FCM });
    const f2 = settleFill({ revenueMicros: -500_000, tradeFeeMicros: 15_000, accumulatorMicros: f1.accumulatorMicros, precisionMicros: FCM });
    like(f2, { rebateMicros: 10_000, accumulatorMicros: 0, netFeeMicros: 10_000 });
  });

  it("sell side: positive revenue floors the same way", () => {
    like(settleFill({ revenueMicros: 550_000, tradeFeeMicros: 17_325, precisionMicros: FCM }), { balanceChangeMicros: 530_000, netFeeMicros: 20_000 });
  });
});

describe("settleFill: a direct member ($0.0001, the default)", () => {
  const netFee = (action, countHundredths, priceCenticents, role = "taker", multiplier) =>
    settleFill({
      revenueMicros: revenueMicros(action, countHundredths, priceCenticents),
      tradeFeeMicros: tradeFeeMicros({ role, countHundredths, priceCenticents, multiplier }),
    }).netFeeMicros;

  it("1 contract @ 50¢ pays 1.75¢, not 2¢; @ 95¢ 0.34¢, not 1¢", () => {
    assert.equal(netFee("buy", 100, 5000), 17_500);
    assert.equal(netFee("buy", 100, 9500), 3400);
  });

  it("a whole-contract fill pays the formula fee ceiled to the centicent, buy or sell, at every price", () => {
    for (let p = 1; p <= 9999; p++) {
      for (const c of [1, 3, 7, 100]) {
        for (const action of ["buy", "sell"]) {
          const expected = tradeFeeCenticents({ role: "taker", countHundredths: c * 100, priceCenticents: p }) * 100;
          if (netFee(action, c * 100, p) !== expected) throw new Error(`${action} ${c} @ ${p}cc`);
        }
      }
    }
  });

  it("the doc's sub-penny buy (1 @ 5.5¢) costs $0.0587, fee $0.0037", () => {
    like(settleFill({ revenueMicros: -55_000, tradeFeeMicros: 3639 }), { balanceChangeMicros: -58_700, roundingFeeMicros: 61, netFeeMicros: 3700 });
  });

  it("a fractional fill's revenue is not rounded: 0.03 @ 33.01¢ + 465 µ$ fee → −$0.0104", () => {
    like(settleFill({ revenueMicros: revenueMicros("buy", 3, 3301), tradeFeeMicros: 465 }), { balanceChangeMicros: -10_400, netFeeMicros: 497 });
  });

  it("an order split into pieces pays what one fill would, give or take the last centicent", () => {
    let acc = 0;
    let total = 0;
    for (let i = 0; i < 4; i++) {
      const f = settleFill({ revenueMicros: -500_000, tradeFeeMicros: 17_500, accumulatorMicros: acc });
      acc = f.accumulatorMicros;
      total += f.netFeeMicros;
    }
    assert.equal(total, 70_000);
    acc = 0;
    total = 0;
    const rebates = [];
    for (let i = 0; i < 3; i++) {
      const f = settleFill({ revenueMicros: -550_000, tradeFeeMicros: 17_325, accumulatorMicros: acc });
      acc = f.accumulatorMicros;
      total += f.netFeeMicros;
      rebates.push(f.rebateMicros);
    }
    assert.deepEqual(rebates, [0, 100, 100]);
    assert.equal(total, 52_000); // one 3-contract fill: ceil(5.1975¢) = 5.20¢
  });
});

// The rounding doc implemented a second time, separately, and run against settleFill
// over random orders of 1–8 fills; also pins: net fee never negative, balance on the grid.
function referenceOrder(fills, precision) {
  let carry = 0;
  return fills.map(({ rev, fee }) => {
    const raw = rev - fee;
    const aligned = raw - (((raw % precision) + precision) % precision);
    const rounding = raw - aligned;
    carry += rounding;
    let rebate = 0;
    while (carry - rebate >= precision && rebate + precision <= fee + rounding) rebate += precision;
    carry -= rebate;
    return { balance: aligned + rebate, net: fee + rounding - rebate, carry };
  });
}

describe("settleFill ≡ the doc, over random orders", () => {
  it("200,000 orders × both precisions: identical fill by fill; net ≥ 0; balance on grid", () => {
    let seed = 211;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const int = (n) => Math.floor(rnd() * n);
    for (let i = 0; i < 200_000; i++) {
      const grid = [100, 10, 1][int(3)];
      const fractional = rnd() < 0.25;
      const multiplier = [0, 0.5, 1][int(3)];
      const action = rnd() < 0.5 ? "buy" : "sell";
      const fills = Array.from({ length: 1 + int(8) }, (_, k) => {
        const countHundredths = fractional ? 1 + int(500) : 100 * (1 + int(rnd() < 0.5 ? 3 : 60));
        const priceCenticents = grid * (1 + int(Math.floor(9999 / grid)));
        const role = k > 0 && rnd() < 0.4 ? "maker" : "taker";
        return { rev: revenueMicros(action, countHundredths, priceCenticents), fee: tradeFeeMicros({ role, countHundredths, priceCenticents, multiplier }) };
      });
      for (const precision of [BALANCE_PRECISION_MICROS.direct, FCM]) {
        const ref = referenceOrder(fills, precision);
        let acc = 0;
        fills.forEach((f, k) => {
          const s = settleFill({ revenueMicros: f.rev, tradeFeeMicros: f.fee, accumulatorMicros: acc, precisionMicros: precision });
          acc = s.accumulatorMicros;
          const r = ref[k];
          if (s.balanceChangeMicros !== r.balance || s.netFeeMicros !== r.net || s.accumulatorMicros !== r.carry || s.netFeeMicros < 0 || s.balanceChangeMicros % precision !== 0) {
            throw new Error(`order ${i} fill ${k} @ ${precision}: ${JSON.stringify({ fills, s, r })}`);
          }
        });
      }
    }
  });
});

describe("cents helpers", () => {
  it("takerFeeCents: 1.75¢ @ 50¢, 0.34¢ @ 95¢, $1.75 for 100 @ 50¢ (the cases above)", () => {
    assert.equal(takerFeeCents(50), 1.75);
    assert.equal(takerFeeCents(95), 0.34);
    assert.equal(takerFeeCents(50, 100), 175);
  });

  it("breakeven: one contract at 95¢ costs 95.34¢ in all, so it needs a 95.34% win rate", () => {
    assert.equal(breakeven(95), 0.9534);
    assert.equal(breakeven(50), 0.5175);
  });
});
