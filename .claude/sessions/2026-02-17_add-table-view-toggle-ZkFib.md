## 2026-02-17 | claude/add-table-view-toggle-ZkFib | Add card/table view toggle to Explore page

**What was done:** Added a card/table view toggle to the /wiki Explore page. Table view is full-width, high-density with 10 sortable columns (Title, Type, Importance, Quality, Words, Updated, Category, Tags, Format, ID). Category and tag cells are clickable — they populate the search bar to filter. Removed the "Explore" heading to save vertical space. Added `containerClassName` prop to the shared DataTable component for reusable container customization.

**Pages:** (no wiki content pages changed)

**Issues encountered:**
- None

**Learnings/notes:**
- Added `containerClassName` prop to DataTable so callers can override the scroll container's height/styling without forking the component. The explore table uses `max-h-[calc(100vh-13rem)]` instead of the default `max-h-[80vh]`.
- Page layout restructured so ExploreGrid controls its own width constraints — filters stay at `max-w-7xl` while the table view gets full viewport width with just `px-6` padding.
