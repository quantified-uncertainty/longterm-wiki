## 2026-02-16 | claude/explore-wiki-dashboard-d1uuh | Add interventions & proposals dashboards

**What was done:** Created internal dashboards at `/internal/interventions` and `/internal/proposals` to surface the structured data from `data/interventions.yaml` (14 entries) and `data/proposals.yaml` (27 entries) that were previously loaded by the build pipeline but never consumed by the app. Added `Intervention` and `Proposal` types plus getter functions to the data layer, built searchable/sortable DataTable-based dashboards, and registered them in the internal sidebar nav.

**Pages:** (no wiki content pages changed)

**Issues encountered:**
- None

**Learnings/notes:**
- `interventions` and `proposals` keys were already being loaded into `database.json` by `build-data.mjs` but the `DatabaseShape` interface and data layer had no corresponding fields or getters — pure dead data until now.
