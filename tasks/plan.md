# Implementation Plan: Align Bot Strategy with Crypticorn Guide

Branch: i1/align-crypticorn-strategy | Issue: #1

## Summary
Implements 5 core technical updates to align bot execution with Johannes Thüroff's Polymarket 5-Minute Strategy guide: post-shakeout reversal direction detection, momentum-adjusted probability pricing, tight-chop corridor rejection, resilient stall exit timer with grace period, and configuration/UI schema synchronization.

---

## Tasks

### Task 1: Tight Chop Filter ($50 Corridor) [x]
- **ID:** T1
- **Size:** S
- **Domain:** `[Backend/Logic]`
- **Target Files:**
  - `src/config.ts`
  - `src/signals.ts`
  - `test/strategy.test.ts`
- **Description:** Add `tightChopRangeUsd: 50` to `EntryConfig` and `DEFAULT_CONFIG`. In `evaluateEntry`, evaluate the high/low range of price samples during the observation window. If range $< 50\text{ USD}$ and BTC has no clear trend, skip with `reason: "tight-chop-no-trend"`.
- **Helper Skill:** `test-driven-development`
- **Depends on:** none
- **Verification:** `bun test` passes, including new test verifying rejection of $30 oscillation in observation window.

---

### Task 2: Resilient Stall Exit Timer with Grace Window [x]
- **ID:** T2
- **Size:** S
- **Domain:** `[Backend/Logic]`
- **Target Files:**
  - `src/config.ts`
  - `src/signals.ts`
  - `src/types.ts`
  - `test/strategy.test.ts`
- **Description:** Enhance `evaluateExit` and `Position` tracking to tolerate brief quote blips outside the $[0.60, 0.70]$ stall band. Maintain `stallSinceMs` unless the bid leaves the band for $> 15$ continuous seconds or hits an immediate exit threshold ($\ge 0.85$ profit target or $\le 0.20$ resolution hold).
- **Helper Skill:** `test-driven-development`
- **Depends on:** none
- **Verification:** Unit test simulating quotes fluctuating 0.65 -> 0.59 -> 0.66 within 10s verifies `stallSinceMs` is preserved and exits after 180s total stall duration.

---

### Checkpoint 1 (T1 & T2) [x]
Run `bun test` to confirm chop filter and exit stall timer enhancements pass without regressions.

---

### Task 3: Post-Shakeout Direction & Side Selection [x]
- **ID:** T3
- **Size:** M
- **Domain:** `[Backend/Logic]`
- **Target Files:**
  - `src/signals.ts`
  - `test/strategy.test.ts`
- **Description:** Decouple `side` selection from static `price >= anchor`. In `evaluateEntry`, inspect price trajectory across the post-shakeout window ($t \ge 300\text{s}$) and the hold window ($\ge 60\text{s}$). If price stabilized below the anchor and sustains an upward trend over the last 60s, select `side = "Up"`. If price stabilized above the anchor and rolls downward over the last 60s, select `side = "Down"`. If trend is continuation, maintain respective side. Reject if price is oscillating across hold window.
- **Helper Skill:** `incremental-implementation`
- **Depends on:** T1
- **Verification:** Unit test replicating the guide's winning trade example (BTC dumps to 67,150 from 67,400 open, recovers to 67,250 over 60s -> verifies bot chooses `side: "Up"`).

---

### Task 4: Momentum Drift in Probability Model [x]
- **ID:** T4
- **Size:** M
- **Domain:** `[Backend/Logic]`
- **Target Files:**
  - `src/probability.ts`
  - `src/signals.ts`
  - `test/strategy.test.ts`
- **Description:** Add optional drift rate $\mu$ (`driftPerSec`) to `upProbability`. Calculate post-shakeout recovery velocity in `evaluateEntry` and pass it to `upProbability`, projecting recovery trajectory over remaining window duration. Ensure zero-drift remains the default for steady/continuation states.
- **Helper Skill:** `api-and-interface-design`
- **Depends on:** T3
- **Verification:** Unit test verifying that a recovery bounce with positive momentum velocity produces model probability $> 0.50$ and edge $> 0.06$ on an Up quote at 28¢.

---

### Checkpoint 2 (T3 & T4) [x]
Verify complete end-to-end entry signal pipeline with `bun test`. Both continuation and reversal test cases pass with appropriate sizing.

---

### Task 5: Config & UI Schema Synchronization [x]
- **ID:** T5
- **Size:** XS
- **Domain:** `[UX / Copy]`
- **Target Files:**
  - `config.example.json`
  - `config.json`
  - `web/src/app/pages/Strategy.tsx`
  - `README.md`
- **Description:** Sync `config.example.json` with full `exit` block, `entry.tightChopRangeUsd`, and omitted entry fields. Fix UI copy in `Strategy.tsx` line 49 from "96 five-minute windows" to "96 fifteen-minute windows (and 288 five-minute windows)".
- **Helper Skill:** `documentation-and-adrs`
- **Depends on:** T1, T2, T3, T4
- **Verification:** Compare JSON keys between `config.example.json` and `DEFAULT_CONFIG`; verify Vite app builds via `bun run build:web`.
