# kalshi-15m-backtest

Two small, dependency-free Node scripts for Kalshi's 15-minute markets (KXBTC15M, KXETH15M and the like):

- **`fees.js`**: Kalshi's trading fee, with Kalshi's rounding, in integer arithmetic. Also `takerFeeCents()` and `breakeven()`.
- **`replay.js`**: replays simple rules ("with 6 minutes left, buy the side priced 70–88¢, hold to settlement") over settled markets, using Kalshi's public API (no key), and prints bets, win rate, net ¢ per contract after fees, and a 95% interval, next to a coin-flip control.

Needs Node 20 or later. Nothing to install.

```sh
npm test          # node --test: the fee cases from Kalshi's fee-rounding doc
node replay.js --series KXBTC15M --from 2026-10-12 --to 2026-10-27 --band 70-88 --minutes 6
node replay.js --series KXETH15M --from 2026-10-20 --to 2026-10-27 --band 70-88,50-60 --minutes 6,3
```

## The fee

Kalshi's schedule (effective July 7, 2026) charges a taker, per fill:

```
fee = M × 0.07 × contracts × P × (1 − P)      P = price in dollars, M = the series' fee multiplier (usually 1)
```

Makers pay nothing unless the series' `fee_type` is `quadratic_with_maker_fees` (then 0.0175 instead of 0.07). The fee is rounded up to $0.000001, then the fill's cash change is rounded to your balance precision: $0.0001 for an account held with Kalshi directly, $0.01 if you clear through an FCM. Rounding is tracked per order and refunded in whole increments, so a split order pays about what one fill would. `settleFill()` implements that pipeline step for step; the tests are the worked examples from [Kalshi's fee-rounding doc](https://docs.kalshi.com/getting_started/fee_rounding).

Worked example: 1 contract at 70¢ costs 0.07 × 0.70 × 0.30 = $0.0147, so 1.47¢ in fees and 71.47¢ in all. It pays 100¢ if it wins, so it breaks even at a 71.47% win rate:

```js
import { takerFeeCents, breakeven } from "./fees.js";
takerFeeCents(70);   // 1.47
takerFeeCents(95);   // 0.34  (0.3325¢ rounded up to the hundredth of a cent)
breakeven(70);       // 0.7147
```

Fees are per-series market data and can change: read `GET https://api.elections.kalshi.com/trade-api/v2/series/{ticker}` (`fee_type`, `fee_multiplier`) before you rely on these numbers. `replay.js` does.

## The replay

For every settled market in the date range, `replay.js` takes the close of the 1-minute candle in force M minutes before the close, finds the side whose ask is in the band (buying NO costs 100¢ minus the yes bid; the cheaper side if both fit), buys one contract, holds it to settlement and charges the taker fee. Markets with a bid/ask spread wider than `--max-spread` (default 12¢) at that minute are skipped. The coin-flip row buys a random side of every quoted market at the same minute; a rule with no edge should land near it, roughly the fee plus half the spread below zero.

Sample output (run 2026-10-30):

```
KXBTC15M, markets closing 2026-10-12 to 2026-10-27 UTC: 1520 settled, 1520 with candles
fee: quadratic × 1, taker, 1 contract(s) per order; max spread 12¢; 67 requests

rule                     bets  win rate  net ¢/contract      95% CI (¢)
-----------------------  ----  --------  --------------  --------------
70-88¢ side, 6 min left   536     77.4%           -2.97   [-6.47, 0.52]
coin flip, 6 min left    1520     50.0%           -2.22  [-4.12, -0.33]
```

Limits, stated plainly: a candle's close is not a fill. A real order arrives after the price it saw and often pays more, so a replay flatters a rule. Neighbouring 15-minute windows are correlated, so the interval is narrower than it should be. Many rules tried on one stretch of data will produce a "winner" by chance.

## What we found

We ran rules like these as paper-trading agents against Kalshi's live order book. In August 2026 a family of momentum agents, mostly on the 15-minute crypto markets, lost 3.35¢ a contract after fees over 781 bets, and a coin-flip control lost about 0.4¢, roughly what the fees cost. In a re-run on KXBTC15M from October 12 to 27, 2026, none of five agents beat the coin-flip control by a margin the samples could show; the control lost 0.65¢ a contract over 446 bets, and an agent buying a 70–88¢ favorite with about six minutes left lost 4.73¢ a contract over 234. No edge held up. The full write-up, with method and caveats: [Does momentum work on Kalshi's 15-minute markets?](https://windmill.markets/research/kalshi-15-minute-momentum?r=github)

## Links

- [Kalshi fee calculator](https://windmill.markets/kalshi-fee-calculator?r=github): the fee, all-in cost and breakeven for any price, with a series' live fee settings.
- [Kalshi 15-minute bitcoin bot](https://windmill.markets/kalshi-15-minute-bitcoin-bot?r=github): how the KXBTC15M markets settle and what an agent does each window.
- [Windmill](https://windmill.markets/?r=github) runs rules like these as AI agents on paper for free, no card needed.

Not affiliated with Kalshi. Not financial advice.

## License

MIT
