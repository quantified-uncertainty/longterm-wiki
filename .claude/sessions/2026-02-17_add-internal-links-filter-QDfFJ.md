## 2026-02-17 | claude/add-internal-links-filter-QDfFJ | Add Internal filter to Field row on /wiki

**What was done:** Added "Internal" as a filter option in the Field filter row on the /wiki explore page, allowing users to quickly filter for internal pages without scrolling through the Entity type filter.

**Pages:** (no page content changes — UI filter only)

**Issues encountered:**
- None

**Learnings/notes:**
- FIELD_GROUPS now supports an optional `entityType` property for type-based filtering alongside cluster-based filtering
- The same pattern can be reused to add other type-based entries to the Field row in the future
