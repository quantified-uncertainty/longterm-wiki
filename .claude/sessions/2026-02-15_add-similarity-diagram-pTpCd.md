## 2026-02-15 | claude/add-similarity-diagram-pTpCd | Add page similarity graph

**What was done:** Added an interactive force-directed similarity graph at `/internal/similarity` that visualizes all 617 wiki pages clustered by content similarity. Uses d3-force for physics simulation with Canvas rendering, showing nodes colored by entity type, sized by importance, and connected by relatedness scores from the existing relatedGraph data.

**Pages:** (no wiki page content changes)

**Issues encountered:**
- `getDatabase` is a private function in `@data/index` — used public API (`getAllPages`, `getTypedEntityById`, `getRelatedGraphFor`) instead
- `pnpm add d3` failed silently (puppeteer postinstall error) leaving d3 runtime packages missing from package.json — caught in review, fixed by adding `d3-force`, `d3-selection`, `d3-zoom` as explicit dependencies
- d3-zoom and React mouse handlers fought over mousedown events causing simultaneous pan+drag — fixed with zoom filter that blocks pan on nodes
- Click event fired after every node drag (mouseUp clears dragRef before click) — fixed with `wasDraggingRef` flag
- Simulation tick captured stale `draw` closure — fixed with `drawRef` indirection
- Stats showed "0 pages" on first render (computed from empty refs) — fixed by computing from props via `useMemo`

**Learnings/notes:**
- The relatedGraph in database.json has ~6889 page-to-page edges with scores ranging 1-97
- A threshold of ~5 gives ~2470 visible edges which is a good default for the force graph
- Canvas rendering handles 600+ nodes smoothly with d3-force simulation
- When mixing d3 native listeners with React synthetic events on the same element, use d3's `filter` to coordinate — React's `stopPropagation` won't prevent d3 listeners
- Always verify `pnpm add` succeeded by checking package.json, not just node_modules
- Node click URLs must use numeric IDs (`/wiki/E42`) not slugs (`/wiki/ai-risks`) — slugs cause a 307 redirect since only numeric IDs are pre-rendered via `generateStaticParams`
- RSC payload for 617 nodes + 4636 edges is ~427 KB raw / ~107 KB gzipped — acceptable for an internal tool page
