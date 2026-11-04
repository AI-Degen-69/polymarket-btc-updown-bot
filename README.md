# Polymarket 5-Minute Strategy Bot

An automated implementation of **"The Polymarket 5-Minute Strategy I Actually Use
(Tested)"** (Johannes Thüroff, Crypticorn) for Polymarket's recurring **BTC
Up-or-Down 5-minute and 15-minute markets**.

The bot rediscovers both market sets every cycle, waits out the shakeout, prices
the real probability of the move, only orders when the odds are still mispriced,
then manages the exit and the bankroll exactly as the guide describes.

Runs on your machine with Bun. **Default mode is paper — it never sends an order
unless you pass `--live`.**

## The strategy, mapped to code

| Guide rule | Implementation |
| --- | --- |
| "No entry in the first 5 minutes" | `intervalParams["15m"].observationSeconds = 300` (100s for 5m markets) — `src/signals.ts` |
| "Direction held for ≥ 60 seconds" | Post-shakeout direction (continuation or reversal recovery) must hold for at least 60s outside noise band — `src/signals.ts` |
| "Odds are still mispriced" | Log-normal model with post-shakeout momentum drift `p = Φ((ln(price/anchor) + μ·τ) / (σ·√τ))`, requiring `edge ≥ 0.06` |
| "No scheduled news before resolution" | `news.events` ISO list with a ±15-minute blackout — `src/news.ts` |
| "Sit out low-volatility grind & tight chop" | Skip when BTC 1-hour range is under `minHourlyRangePct` (0.3%) or observation range is under `tightChopRangeUsd` ($50) |
| "Only trade when the spread is ≤ 2¢" | `maxSpreadCents: 2`, read from the live CLOB book |
| "Don't chase the move" | Skip once the move exceeds `maxMovePct` (0.5%) |
| "Size by edge, ¼ Kelly" | `kellyFraction(p, price+fee) × 0.25`, hard-capped at 8% of bankroll (~$80 per $1,000) |
| "Lock profit at 85–90¢" | Sell at the bid when it reaches `profitTargetCents: 0.85` |
| "Odds stall at 60–70¢ for 3+ minutes" | Stall timer per position with 15s grace window for order book quote jitter, exits after `stallSeconds` |
| "Odds reverse below entry → hold" | Holds while the thesis is intact |
| "Reverse to 20¢ → accept the loss" | Holds to resolution below `acceptLossBelowCents: 0.20` |
| "Sell immediately on news" | News blackout flips open positions to sell |
| "3–6 markets per day, not 96" | `maxTradesPerDay: 6` |
| "Two losses in a row → stop for the day" | `maxConsecutiveLosses: 2` plus a cooldown after every loss |
| "Never size by streak" | Sizing ignores win/loss streaks entirely (no martingale) |

The 5-minute markets use the same rules scaled to the shorter window, as the
guide describes ("same principles at higher intensity"): 100s observation, 20s
direction hold, 60s stall timer.

## How markets are found

Polymarket addresses these windows by slug, so no scraper and no hardcoded IDs:

```
https://gamma-api.polymarket.com/events/slug/btc-updown-15m-<window start, unix s>
https://gamma-api.polymarket.com/events/slug/btc-updown-5m-<window start, unix s>
```

Each cycle the bot aligns the clock to the 5- and 15-minute grid, discovers the
live window plus the next one, and reads the CLOB order book
(`/book?token_id=…`) for both outcomes. Order placement goes through the official
[`@polymarket/client`](https://github.com/Polymarket/ts-sdk) SDK, so signing, L2
HMAC headers and wallet approvals stay in Polymarket's own code.

**Anchor price.** The window's reference price is captured from the bot's own
price feed at window open, so distance, direction and volatility all come from a
single source. If the bot starts or restarts mid-window it recovers the open from
1-minute candles; only if that fails does it use the market's published Chainlink
`priceToBeat`. Any non-live anchor demands an extra 0.05% of move before entry,
and the fallback is logged.

**Price source.** A median of Coinbase, Kraken and Binance spot, polled every 2
seconds. The market resolves on Chainlink BTC/USD; the median tracks it closely
at the seconds scale the strategy trades, and using one feed for both the anchor
and the signal avoids mixing venues.

## Run it

```bash
cd bot
bun install

bun run scan            # dry run: discovery, anchors, decisions. Writes nothing.
bun run scan --minutes 20
bun run                 # paper trading loop with persisted state
bun run run --live      # LIVE orders (needs keys, see below)
bun run status          # equity, open positions, recent trades
bun run reset           # wipe local state
bun test                # strategy/risk unit tests
```

`scan` prints, every cycle where something changes, lines such as:

```
12:04:10 SKIP   no trade: move-too-small        slug=btc-updown-15m-… movePct=0.031 needsPct=0.05
12:07:22 ENTRY  entered position                slug=btc-updown-15m-… side=Up price=0.32 shares=250 usd=80.00 p=0.687 edge=0.351 movePct=0.078
12:11:05 EXIT   closed position                 slug=btc-updown-15m-… side=Up at=0.86 pnl=$134.83 why=profit-target-hit
```

## Dashboard

The repo's app doubles as the bot's dashboard: run the bot loop plus its local
API, and the app's **Live bot** page shows what the bot is doing in real time.

```bash
cd bot
bun run          # paper loop: writes .state/snapshot.json + .state/events.ndjson
bun run dashboard # read API on 127.0.0.1:8788

cd ..
bun run dev      # app on http://localhost:5173
```

What the page shows:

- **Windows** — every live 5m/15m market with anchor (and where it came from),
  move vs the move it needs, model probability, edge, both books, time left, and
  the exact gate verdict for this tick.
- **Decision journal** — one line per decision *change*: waiting out the
  shakeout, direction not held, spread too wide, no mispricing, profit target
  hit, odds stalled. De-duplicated so a 2-second loop stays readable.
- **Positions and trades** — entry price, shares, mark, unrealised PnL, stall
  timer, and every fill with its reason.
- **Risk limits** — trades today, losses in a row, daily loss, drawdown, plus a
  kill-switch button that writes the same `.state/STOP` file the engine checks.
- **Reset** — wipes open positions, the trade log, the journal and every risk
  counter, restarts at the configured bankroll (default $1,000) and releases the
  kill switch. It leaves a `.state/RESET` marker so a *running* engine reloads
  its in-memory state on the next tick instead of overwriting the wipe. Live
  resting orders do not exist by design: every fill is a marketable FAK order.

The API only listens on loopback and only reads files the engine already writes.
It is deliberately separate from the engine: closing it changes nothing about
trading, and it never holds a key.

## Live trading

1. Copy `.env.example` to `.env` and set `POLYMARKET_PRIVATE_KEY` (the signer key
   for your Polymarket account) plus `POLYMARKET_WALLET_ADDRESS` if you trade
   through a Deposit/Proxy/Safe wallet rather than the signer EOA.
2. Keep `BANKROLL_USD` at the amount you actually allocate to this strategy:
   it drives Kelly sizing and every loss limit.
3. Fund the wallet with USDC on Polygon. The SDK handles approvals and gasless
   wallet operations.
4. Start with `bun run scan` for a session, then `bun run` (paper) for a day, and
   only then `bun run run --live`.

Fee model used everywhere (paper and live reconciliation): Crypto taker rate
`0.07`, `fee = shares × 0.07 × p × (1 − p)`.

### Kill switch and state

- `bot/.state/STOP` present → no new entries (checked every cycle).
- `bot/.state/state.json` holds anchors, open positions and the risk counters.
- `bot/.state/trades.ndjson` is an append-only log of every decision that became
  an order.
- A `Ctrl-C` stops cleanly and saves state. Restarting mid-window keeps anchors
  and open positions.

## Configuration

Defaults are the guide's numbers (`src/config.ts`). Override any of them in
`bot/config.json` (see `config.example.json`), or set `BANKROLL_USD` / `LIVE` in
the environment. Notable knobs:

| Key | Default | Meaning |
| --- | --- | --- |
| `entry.minEdge` | `0.06` | Minimum model edge after fees |
| `entry.minModelProb` / `maxModelProb` | `0.52` / `0.72` | Probability band worth trading |
| `entry.maxEntryPriceCents` | `0.65` | Refuse expensive sides |
| `entry.kellyCut` | `0.25` | Quarter Kelly |
| `entry.maxPositionPct` | `0.08` | Cap per trade |
| `risk.maxConcurrentPositions` | `1` | One position at a time |
| `risk.dailyLossLimitPct` | `3` | Halt for the day |
| `risk.maxDrawdownPct` | `15` | Global kill switch |
| `news.events` | `[]` | ISO timestamps (CPI, FOMC, Fed speakers) |

## What this bot does not do

- It does not guess scheduled news; put event times in `news.events`.
- It does not redeem resolved positions — the CLOB settles winning shares to
  USDC, and `status` reports realised PnL from the bot's own fills.
- It cannot verify its own live fills in this checkout: live order accounting
  parses the CLOB response and is reviewed against the documented response
  shapes, but no funded key was available to run a real trade. Paper mode,
  discovery, pricing, sizing, exits and risk limits are exercised and unit
  tested.
- It is not financial advice. The guide itself reports a 55–65% win rate with
  2–3x wins versus losses; that edge depends on execution discipline, not on
  this code being clever.
