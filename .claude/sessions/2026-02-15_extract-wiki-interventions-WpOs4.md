## 2026-02-15 | claude/extract-wiki-interventions-WpOs4 | Extract wiki interventions as structured data

**What was done:** Created a semi-structured interventions data layer (similar to cruxes) by extending the Intervention schema, creating `data/interventions.yaml` with 14 interventions extracted from wiki pages, adding build pipeline integration, and creating `InterventionCard` and `InterventionList` React components for MDX rendering.

**Pages:** intervention-portfolio

**Issues encountered:**
- None

**Learnings/notes:**
- The existing Intervention schema in `data/schema.ts` was minimal (6 fields). Extended it with risk coverage matrix, ITN prioritization, funding data, and cross-references (similar to Crux pattern).
- Build pipeline automatically writes individual JSON files for each DATA_FILES entry, so adding `interventions.yaml` to DATA_FILES was sufficient.
- The `build-data.mjs` script must be run from the `app/` directory (uses `process.cwd()` as PROJECT_ROOT, with `REPO_ROOT = join(cwd, '..')`).
