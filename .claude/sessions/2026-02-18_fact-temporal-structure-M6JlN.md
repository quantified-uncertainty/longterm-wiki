## 2026-02-18 | claude/fact-temporal-structure-M6JlN | Refactor fact system to knowledge-graph measures

**What was done:** Redesigned the fact system with three layers of improvement:
1. **Measures** — renamed from "metrics" to avoid collision with entity type. Rich metadata: direction, display format, relatedMeasures, applicableTo.
2. **Auto-inference** — facts auto-infer their measure from ID (e.g., `valuation-nov-2025` → `valuation`). Use `measure: ~` to opt out.
3. **Structured values** — fact values can now be numbers (`380e9`), ranges (`[20e9, 26e9]`), or lower bounds (`{min: 67e9}`) instead of just strings. Build pipeline auto-derives display strings, numeric, low/high from the measure context.

Also added `subject` field for benchmark facts, source URLs, and updated the dashboard.

**Pages:** (infrastructure-only, no wiki page edits)

**Issues encountered:**
- Naming collision between `metric` (entity type) and `metric` (fact field) — resolved by renaming to `measure`
- Auto-inference was too aggressive for `revenue-yoy-growth-2024` (matched `revenue-` prefix) — fixed with `measure: ~` opt-out

**Learnings/notes:**
- Structured values: `value: 380e9` + measure `unit: USD` → auto-formatted as `"$380 billion"`
- Percentages: `value: 40` + measure `unit: percent` → `"40%"`, stored as `numeric: 0.4` for computation
- Ranges: `value: [20e9, 26e9]` → `"$20-26 billion"`, auto-sets low/high/numeric
- Lower bounds: `value: {min: 67e9}` → `"$67 billion+"`, handles the "+" suffix semantically
- 20 measures, 16 auto-inferred, 32 structured values normalized, 31 timeseries observations
