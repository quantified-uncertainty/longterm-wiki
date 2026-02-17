## 2026-02-15 | claude/check-considerations-index-tBtzY | Remove dead Experiments sidebar links

**What was done:** Removed the "Experiments" section from the internal sidebar nav, which contained two dead links (insight-grid-experiments and risk-trajectory-experiments) whose MDX pages had been previously deleted.

**Pages:** (no page content changes — infrastructure-only fix)

**PR:** #137

**Issues encountered:**
- None

**Learnings/notes:**
- The wiki uses "Cruxes" (not "Crucial Considerations") as the canonical entity type for key uncertainties. There is no dedicated Crucial Considerations index page.
- Both experiment pages were identified as "walls of gray boxes" in the STUB_AUDIT plan and recommended for deletion; the pages were removed but the nav entries were not cleaned up.
