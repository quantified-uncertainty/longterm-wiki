## 2026-02-17 | claude/add-table-view-toggle-ZkFib | Add card/table view toggle to Explore page

**What was done:** Added a card/table view toggle to the /wiki Explore page. Table view is full-width, high-density with 11 sortable columns (Title, Type, Imp., Res., Qual., Links, Words, Updated, Category, ID, Tags). Two new data fields surfaced: `researchImportance` (98% populated) and `backlinkCount` (75% non-zero, max 223). Category and tag cells are clickable — they populate the search bar to filter. Removed the "Explore" heading to save vertical space. Added `containerClassName` prop to the shared DataTable for reusable container customization. Code review fixed: performance bug (unmemoized callback), wasted sort in table mode, dropped low-signal Format column, added accessibility labels, header tooltips on abbreviated columns.

**Pages:** (no wiki content pages changed)

**Issues encountered:**
- Test mock data was missing `researchImportance` and `backlinkCount` fields — fixed and assertions added.

**Learnings/notes:**
- Added `containerClassName` prop to DataTable so callers can override the scroll container's height/styling without forking the component.
- `handleSearchChange` must be `useCallback`-wrapped when passed to child components that use it in `useMemo` deps — otherwise columns rebuild every render and TanStack reinitializes.
- `backlinkCount` is computed by build-data.mjs via `scanContentEntityLinks()` + entity backlinks. 75% of pages have at least one backlink; max is 223.
- `researchImportance` comes from frontmatter, 98.4% populated, separate scoring axis from `readerImportance`.
