# Quality Constraints: Crypticorn Strategy Alignment

## 1. Zero Regressions
- All 29 pre-existing tests in `test/strategy.test.ts` must pass without modifications to existing assertion semantics.
- New test suites must explicitly test:
  1. Post-shakeout recovery side selection (buying Up while price < anchor).
  2. Momentum drift probability pricing.
  3. Tight chop rejection ($< $50 range).
  4. Stall exit timer grace-period tolerance.

## 2. Anti-Cheat & Quality Bar
- Strictly forbid `@ts-ignore`, `eslint-disable`, or type assertions masking type mismatches.
- No deleted tests or stripped assertions.
- Sizing must remain strictly fractional Kelly (¼ Kelly) capped at 8% ($80 on $1,000) with zero martingale streak behavior.
- Spread cap remains strictly $\le 2¢$.

## 3. Dependency Constraints
- Zero new external runtime dependencies (`node_modules`).
- All calculations must remain pure, deterministic TypeScript running natively under Bun.
