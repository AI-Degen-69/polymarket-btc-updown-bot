# Specification: Crypticorn 5-Minute Strategy Alignment

## 1. Background & Goals
Audit of the trading bot against Johannes Thüroff's authoritative guide ("The Polymarket 5-Minute Strategy I Actually Use (Tested)" at https://www.crypticorn.com/polymarket-5-minute-strategy/) revealed critical gaps between the guide's rules and the codebase.

The primary objective is to align bot decision-making with the exact behavior described in the guide:
1. Enable post-shakeout reversal trading (buying UP after an early dump recovers, and buying DOWN after an early pump rolls over).
2. Incorporate momentum drift into probability pricing so post-shakeout recoveries can register statistical edge.
3. Filter out tight chop (< $50 oscillation during observation window).
4. Harden the 60–70¢ stall exit timer against CLOB quote jitter using a grace window.
5. Synchronize configuration files (`config.example.json`, `config.json`) and UI documentation.

---

## 2. Requirements & Acceptance Criteria

### Requirement 1: Post-Shakeout Direction & Side Selection
- **As-Is**: `side` is strictly `price >= anchor ? "Up" : "Down"`, and `direction-not-held` fails if any sample crosses `anchor ± tolerance`.
- **To-Be**:
  - The observation window captures early shakeout extremes ($P_{min}$ and $P_{max}$).
  - Direction over the hold window ($\ge 60\text{s}$) is computed from recent price movement (slope / net velocity) rather than static position relative to anchor.
  - If BTC dumped below the anchor, stabilized, and has sustained an upward recovery for $\ge 60\text{s}$, the bot identifies direction as `"Up"`, allowing entry on `"Up"` tokens at discounted odds (e.g. 25–40¢).
  - Continuation moves (staying above anchor and trending up, or staying below and trending down) continue to be supported.
  - Flapping/oscillating price during the hold window triggers `direction-not-held`.
- **Superseded in part (2026-11-05)**: the reversal path exists but cannot be entered. With zero drift, any side still behind the anchor prices at $p < 0.50$ and fails `minModelProb: 0.52`; signed `movePct` also fails the min-move gate. Trading the pre-cross reversal requires an edge model the bot does not have.

### Requirement 2: Momentum-Aware Probability Pricing
- **As-Is**: Zero-drift Brownian motion $p = \Phi(\ln(price/anchor) / (\sigma \sqrt{\tau}))$ strictly assigns $p < 0.50$ when $price < anchor$.
- **To-Be**:
  - `upProbability` accepts an optional drift parameter ($\mu$ per second) derived from post-shakeout momentum.
  - When post-shakeout recovery velocity is present, the drift term projects expected recovery toward/beyond anchor over remaining time $\tau$.
  - Without drift, model retains backward-compatible driftless behavior.
- **Superseded (2026-11-05)**: the drift term was removed from `signals.ts`. Projecting a 60s slope over 400–870s flipped $p$ from 0.11 to 0.61 within seconds and bought the losing side six times out of six. `p` is zero-drift again.

### Requirement 3: Tight Chop Filter ($50 Corridor)
- **As-Is**: Only macro 1-hour range is checked (`minHourlyRangePct: 0.3`).
- **To-Be**:
  - In `EntryConfig`, add `tightChopRangeUsd` (default `50`).
  - If high-low range during the observation period (minutes 0–5) is $< 50\text{ USD}$, skip with `reason: "tight-chop-no-trend"`.

### Requirement 4: Resilient Stall Exit Timer
- **As-Is**: `stallSinceMs` resets to `null` on any single 2-second tick where bid $< 0.60$ or $> 0.70$.
- **To-Be**:
  - A grace window of 15 seconds is applied before clearing `stallSinceMs` when bid fluctuates outside $[0.60, 0.70]$, preventing CLOB micro-flickers from wiping the 180s stall timer.
  - Profit target ($\ge 0.85$) or catastrophic drop ($\le 0.20$) immediately override.

### Requirement 5: Configuration & UI Consistency
- **As-Is**: `config.example.json` lacks `exit` block and several entry params. `Strategy.tsx` misstates 96 5-minute windows.
- **To-Be**: Complete `config.example.json` with all fields matching `DEFAULT_CONFIG`; fix UI text in `Strategy.tsx`.

---

## 3. Out of Scope
- Automated live economic calendar scraping via paid third-party API subscriptions (static ISO schedule remains supported via `config.news.events`).
- Modifying Polymarket CLOB authentication or execution SDKs.
