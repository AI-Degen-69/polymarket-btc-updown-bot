# Backlog — Issue #1 (Crypticorn strategy alignment)

Findings noticed during the Station IV review that are outside the issue's acceptance criteria.
They stay open until `vi-close-pipeline` resolves them.

| ID | Item | Why it was deferred |
| --- | --- | --- |
| B1 | Populate `news.events` automatically from an economic-calendar feed | Issue problem-statement item 5. The acceptance criteria do not require it, and `SPEC.md` §3 puts live calendar scraping out of scope. |
| B2 | The commit ships a full dashboard web app (`web/`), a hosted snapshot (`sites/`), dashboard/risk/state changes and a `start-bot.ps1` rewrite that `tasks/plan.md` never lists | Spec-axis scope creep. Reviewed and verified instead of removed — tearing out the operator's working dashboard is destructive. |
| B3 | `config.json` commits `risk.dailyLossLimitPct: 50`, while `DEFAULT_CONFIG` and the Strategy page say 3% | Operator-owned live config. Changing a risk limit silently is not a review fix; confirm the intended value. |
