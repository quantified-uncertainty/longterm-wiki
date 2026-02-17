## 2026-02-17 | claude/add-table-view-toggle-ZkFib | Add card/table view toggle to Explore page

**What was done:** Added a toggle on the /wiki Explore page to switch between the existing card grid view and a new full-width data table view. The table uses TanStack React Table with sortable columns for Title, Type, Importance, Quality, Words, Last Updated, Category, Tags, and Description. View mode persists in the URL via `?view=table`.

**Pages:** (no wiki content pages changed)

**Issues encountered:**
- None

**Learnings/notes:**
- The DataTable component (`app/src/components/ui/data-table.tsx`) supports both a legacy API (data+columns) and a newer API (pre-built table instance). Used the table instance API for the explore table since sorting state is managed externally.
- Page layout restructured so ExploreGrid controls its own width constraints — filters stay at `max-w-7xl` while the table view gets full viewport width with just `px-6` padding.
