## 2026-02-15 | claude/add-similarity-diagram-pTpCd | Add page similarity graph

**What was done:** Added an interactive force-directed similarity graph at `/internal/similarity` that visualizes all 617 wiki pages clustered by content similarity. Uses d3-force for physics simulation with Canvas rendering, showing nodes colored by entity type, sized by importance, and connected by relatedness scores from the existing relatedGraph data.

**Pages:** (no wiki page content changes)

**Issues encountered:**
- `getDatabase` is a private function in `@data/index` — used public API (`getAllPages`, `getTypedEntityById`, `getRelatedGraphFor`) instead
- `@types/d3` meta-package doesn't auto-install sub-package types — needed to explicitly install `@types/d3-force`, `@types/d3-selection`, `@types/d3-zoom`
- Puppeteer download fails in CI environment — used `PUPPETEER_SKIP_DOWNLOAD=true`

**Learnings/notes:**
- The relatedGraph in database.json has ~6889 page-to-page edges with scores ranging 1-97
- A threshold of ~5 gives ~2470 visible edges which is a good default for the force graph
- Canvas rendering handles 600+ nodes smoothly with d3-force simulation
