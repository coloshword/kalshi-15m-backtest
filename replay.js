#!/usr/bin/env node
// Replay simple price-band × time-left rules over Kalshi's settled 15-minute markets.
//
//   node replay.js --series KXBTC15M --from 2026-10-12 --to 2026-10-27 --band 70-88 --minutes 6
//
// A rule is "with M minutes left, buy the side whose ask is in [A, B]¢ (the cheaper
// side if both are), one order per market, hold to settlement". Quotes are the close of
// Kalshi's 1-minute candles (yes bid / yes ask); buying NO costs 100 − the yes bid. The
// taker fee comes from fees.js with the series' own fee multiplier. Markets whose
// bid/ask spread is wider than --max-spread at that minute are skipped (as in the
// back-tests this ports). The "coin flip" row buys a random side of every quoted market
// at the same minute (seeded, --seed): a rule with no edge should land near it, about
// the fee and half the spread below zero.
//
// Public data only: Kalshi's trade API, no key. Candle closes are not fills: a real
// order can pay more than the ask it saw, so treat any positive result with suspicion.

import { tradeFeeCenticents } from "./fees.js";

const API = "https://api.elections.kalshi.com/trade-api/v2";
const WINDOW_S = 15 * 60;
const GAP_MS = 120; // space requests: unauthenticated reads get 429s above ~10 a second

// ---- arguments -------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { series: "KXBTC15M", band: "70-88", minutes: "6", "max-spread": "12", contracts: "1", seed: "1" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "-h" || k === "--help") a.help = true;
    else if (k.startsWith("--")) a[k.slice(2)] = argv[++i];
  }
  return a;
}

const USAGE = `usage: node replay.js --series KXBTC15M --from YYYY-MM-DD --to YYYY-MM-DD [--band 70-88[,50-60]] [--minutes 6[,3]] [--max-spread 12] [--contracts 1]
  --from/--to   UTC dates, inclusive (markets closing on those days)
  --band        entry price band on the side's ask, cents; comma-separate several
  --minutes     minutes left in the window at entry (1-14); comma-separate several
  --max-spread  skip a market whose yes spread is wider than this at entry, cents (default 12)
  --contracts   contracts per order; the fee is rounded per order (default 1)
  --seed        seed for the coin-flip control (default 1)`;

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// ---- Kalshi's public API ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;

async function get(path, query = {}) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== ""));
  const url = `${API}${path}${qs.size ? `?${qs}` : ""}`;
  for (let attempt = 1; ; attempt++) {
    await sleep(GAP_MS);
    requests++;
    let res;
    try {
      res = await fetch(url, { headers: { accept: "application/json" } });
    } catch (e) {
      throw new Error(`could not reach ${API} (${e.cause?.code ?? e.message})`);
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * attempt);
      continue;
    }
    const body = (await res.text()).slice(0, 200);
    throw new Error(`Kalshi answered HTTP ${res.status} for ${path}: ${body}`);
  }
}

/** A field the script needs, or a clear error naming what came back instead. */
function need(obj, key, what) {
  const v = obj?.[key];
  if (v === undefined || v === null) {
    const keys = obj && typeof obj === "object" ? Object.keys(obj).slice(0, 12).join(", ") : typeof obj;
    throw new Error(`unexpected API shape: ${what} has no "${key}" (got: ${keys}). Kalshi may have changed its API; see https://docs.kalshi.com`);
  }
  return v;
}

/** "0.7300" → 7300 centicents; an empty side ("0.0000" bid, "1.0000" ask, missing) → null. */
function centicents(s) {
  if (typeof s !== "string" || !/^\d+(\.\d{1,4})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const v = Number(w) * 10000 + Number(f.padEnd(4, "0"));
  return v >= 1 && v <= 9999 ? v : null;
}

async function seriesFee(series) {
  const s = need(await get(`/series/${encodeURIComponent(series)}`), "series", `GET /series/${series}`);
  const type = need(s, "fee_type", "the series");
  if (type !== "quadratic" && type !== "quadratic_with_maker_fees") throw new Error(`series ${series} has fee_type "${type}"; fees.js models the quadratic fee only`);
  return { type, multiplier: s.fee_multiplier ?? 1 };
}

/** Settled (finalized, yes/no) markets of a series closing in [fromS, toS). */
async function settledMarkets(series, fromS, toS) {
  const out = [];
  let cursor;
  do {
    const page = await get("/markets", { series_ticker: series, min_close_ts: fromS, max_close_ts: toS - 1, limit: 1000, cursor });
    for (const m of need(page, "markets", "GET /markets")) {
      if (m.status === "finalized" && (m.result === "yes" || m.result === "no")) {
        const close = Date.parse(m.close_time) / 1000;
        const open = m.open_time ? Date.parse(m.open_time) / 1000 : close - WINDOW_S;
        if (Number.isFinite(close)) out.push({ ticker: m.ticker, open, close, result: m.result, quotes: [] });
      }
    }
    cursor = page.cursor || undefined;
  } while (cursor);
  return [...new Map(out.map((m) => [m.ticker, m])).values()].sort((a, b) => a.close - b.close);
}

/** 1-minute candles for every market, in batches the venue accepts (≤ 10,000 market-minutes a request). */
async function loadCandles(markets, onProgress) {
  for (let i = 0; i < markets.length; ) {
    const group = [markets[i]];
    while (i + group.length < markets.length) {
      const next = markets[i + group.length];
      const span = (next.close - group[0].open) / 60;
      if ((group.length + 1) * span > 10_000 || group.length >= 100) break;
      group.push(next);
    }
    const batch = await get("/markets/candlesticks", {
      market_tickers: group.map((m) => m.ticker).join(","),
      start_ts: group[0].open,
      end_ts: group[group.length - 1].close,
      period_interval: 1,
    });
    const byTicker = new Map(group.map((m) => [m.ticker, m]));
    for (const row of need(batch, "markets", "GET /markets/candlesticks")) {
      const m = byTicker.get(row.market_ticker);
      if (!m) continue;
      m.quotes = (row.candlesticks ?? [])
        .map((c) => ({ t: c.end_period_ts, bid: centicents(c.yes_bid?.close_dollars), ask: centicents(c.yes_ask?.close_dollars) }))
        .sort((a, b) => a.t - b.t);
    }
    i += group.length;
    onProgress(i, markets.length);
  }
}

// ---- the rules -------------------------------------------------------------------------

/** The quote in force at t: the newest candle that ended at or before it, inside the window. */
function quoteAt(m, t) {
  let best = null;
  for (const q of m.quotes) if (q.t <= t && q.t > m.open) best = q;
  return best;
}

const feePer = (ask, n, mult) => tradeFeeCenticents({ role: "taker", countHundredths: n * 100, priceCenticents: ask, multiplier: mult }) / n;
const pnl = (side, ask, m, fee) => (side === m.result ? 10000 : 0) - ask - fee;

/** P&L per contract (centicents) of each bet a rule makes over the markets. */
function runRule(markets, { lo, hi, minutes }, opt) {
  const bets = [];
  const flips = [];
  for (const m of markets) {
    const q = quoteAt(m, m.close - minutes * 60);
    if (!q || q.bid === null || q.ask === null || q.ask - q.bid > opt.maxSpread) continue;
    const sides = [["yes", q.ask], ["no", 10000 - q.bid]];
    const [fs, fa] = sides[opt.rand() < 0.5 ? 0 : 1];
    flips.push({ pnl: pnl(fs, fa, m, feePer(fa, opt.contracts, opt.mult)), won: fs === m.result });
    const fits = sides.filter(([, ask]) => ask >= lo * 100 && ask <= hi * 100).sort((a, b) => a[1] - b[1]);
    if (!fits.length) continue;
    const [side, ask] = fits[0];
    bets.push({ pnl: pnl(side, ask, m, feePer(ask, opt.contracts, opt.mult)), won: side === m.result });
  }
  return { bets, flips };
}

/** A small seeded generator, so a run can be repeated exactly. */
function lcg(seed) {
  let x = seed >>> 0;
  return () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
}

/** n, win rate, mean ¢ a contract and its 95% interval (normal approximation; bets are treated as independent). */
function summarize(pnls, wins) {
  const n = pnls.length;
  if (!n) return { n, win: "-", mean: "-", ci: "-" };
  const mean = pnls.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const h = (1.96 * sd) / Math.sqrt(n);
  const c = (x) => (x / 100).toFixed(2);
  return { n, win: `${((100 * wins) / n).toFixed(1)}%`, mean: c(mean), ci: n > 1 ? `[${c(mean - h)}, ${c(mean + h)}]` : "-" };
}

function printTable(rows) {
  const head = ["rule", "bets", "win rate", "net ¢/contract", "95% CI (¢)"];
  const cells = [head, ...rows.map((r) => [r.rule, String(r.n), r.win, r.mean, r.ci])];
  const w = head.map((_, i) => Math.max(...cells.map((c) => c[i].length)));
  for (const [k, c] of cells.entries()) {
    console.log(c.map((x, i) => (i === 0 ? x.padEnd(w[i]) : x.padStart(w[i]))).join("  "));
    if (k === 0) console.log(w.map((x) => "-".repeat(x)).join("  "));
  }
}

// ---- main ------------------------------------------------------------------------------

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) return console.log(USAGE);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.from ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(a.to ?? "")) die(`--from and --to are required, as YYYY-MM-DD\n${USAGE}`);
  const fromS = Date.parse(`${a.from}T00:00:00Z`) / 1000;
  const toS = Date.parse(`${a.to}T00:00:00Z`) / 1000 + 86400;
  if (!(toS > fromS)) die("--to must be on or after --from");
  const bands = a.band.split(",").map((b) => {
    const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(b.trim());
    if (!m || +m[1] > +m[2] || +m[1] < 1 || +m[2] > 99) die(`bad --band "${b}" (want e.g. 70-88, cents between 1 and 99)`);
    return [+m[1], +m[2]];
  });
  const minutes = a.minutes.split(",").map((x) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1 || n > 14) die(`bad --minutes "${x}" (whole minutes, 1 to 14)`);
    return n;
  });
  const maxSpread = Number(a["max-spread"]) * 100;
  const contracts = Number(a.contracts);
  if (!Number.isInteger(contracts) || contracts < 1) die("--contracts must be a whole number ≥ 1");

  const series = a.series.toUpperCase();
  const fee = await seriesFee(series);
  const markets = await settledMarkets(series, fromS, toS);
  if (!markets.length) die(`no settled ${series} markets closed between ${a.from} and ${a.to} (is it a 15-minute series? does the range lie in the past?)`);
  const tty = process.stderr.isTTY;
  await loadCandles(markets, (i, n) => tty && process.stderr.write(`\rcandles ${i}/${n}`));
  if (tty) process.stderr.write("\n");
  const quoted = markets.filter((m) => m.quotes.length).length;

  const rows = [];
  const stats = (bets) => summarize(bets.map((b) => b.pnl), bets.filter((b) => b.won).length);
  for (const mins of minutes) {
    let flips = [];
    for (const [lo, hi] of bands) {
      const opt = { maxSpread, contracts, mult: fee.multiplier, rand: lcg(Number(a.seed) || 1) }; // same flips for every band
      const r = runRule(markets, { lo, hi, minutes: mins }, opt);
      flips = r.flips;
      rows.push({ rule: `${lo}-${hi}¢ side, ${mins} min left`, ...stats(r.bets) });
    }
    rows.push({ rule: `coin flip, ${mins} min left`, ...stats(flips) });
  }

  console.log(`${series}, markets closing ${a.from} to ${a.to} UTC: ${markets.length} settled, ${quoted} with candles`);
  console.log(`fee: ${fee.type} × ${fee.multiplier}, taker, ${contracts} contract(s) per order; max spread ${a["max-spread"]}¢; ${requests} requests\n`);
  printTable(rows);
  console.log("\nOne bet per market per rule, held to settlement, at the 1-minute candle's close ask. The interval ignores");
  console.log("that neighbouring windows are correlated, so it is too narrow. Not a forecast.");
}

main().catch((e) => die(e.message));
