## 2026-02-18 | claude/fact-temporal-structure-M6JlN | Refactor fact system to knowledge-graph measures

**What was done:** Redesigned the fact system from simple metric tags to a knowledge-graph architecture with first-class "measures" (renamed from "metrics" to avoid collision with existing `metric` entity type). Measures have rich metadata (direction, display formatting, relatedMeasures, applicableTo). Facts auto-infer their measure from ID (e.g., `valuation-nov-2025` resolves to measure `valuation`), eliminating redundant YAML boilerplate. Added `subject` field for benchmark/comparison facts. Cleaned up YAML: removed redundant `numeric` fields where auto-parseable, added source URLs. Dashboard updated to show measure metadata and direction indicators.

**Pages:** (infrastructure-only, no wiki page edits)

**Issues encountered:**
- Naming collision between `metric` (entity type) and `metric` (fact field) — resolved by renaming to `measure`
- Context ran out during v2 refactor, required continuation session

**Learnings/notes:**
- Build pipeline auto-parses `numeric` from value strings, so `numeric` is only needed for `+` suffix values
- Measure auto-inference uses longest prefix match: fact ID `valuation-nov-2025` → measure `valuation`
- Facts with `subject` override (e.g., `industry-average`) are excluded from parent entity's timeseries
- 20 measure definitions, 17 auto-inferred, 32 timeseries observations across 19 measures
