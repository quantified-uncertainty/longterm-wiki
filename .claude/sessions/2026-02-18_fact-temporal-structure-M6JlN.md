## 2026-02-18 | claude/fact-temporal-structure-M6JlN | Add temporal metric structure to fact system

**What was done:** Added formal metric definitions and temporal structure to the fact system. Facts can now reference a `metric` (like "valuation" or "revenue") that groups related observations across time and entities, enabling timeseries queries and cross-entity comparisons. Also added `low`/`high` range fields for estimate-style facts. Updated the Fact Dashboard with three views: By Entity, By Metric, and Timeseries (with mini bar charts).

**Pages:** (no wiki page content changes)

**Issues encountered:**
- None

**Learnings/notes:**
- The fact system now supports 19 metric definitions with 32 timeseries observations across 18 metrics
- `metric` field is optional for backward compatibility — existing `<F>` component usage is unaffected
- Schema validation now cross-references metric IDs in facts against `data/fact-metrics.yaml`
- Range support via `low`/`high` fields enables facts like "$20-26 billion" to have structured numeric bounds
