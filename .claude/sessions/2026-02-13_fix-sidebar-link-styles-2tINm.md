## 2026-02-13 | claude/fix-sidebar-link-styles-2tINm | Fix InfoBox sidebar link styles

**What was done:** Updated the InfoBox "Related Entries" section to use `EntityLink` components instead of plain `Link` components, giving sidebar links the same background color styling and hover tooltip popups as main content links. Added `id` field to resolved related entries in the data layer, changed InfoBox Card from `overflow-hidden` to `overflow-visible` so tooltips aren't clipped, fixed `pluralize()` bugs ("analysises" → "analyses", "persons" → "people"), and tightened Related section spacing with a flex-wrap layout.

**Issues encountered:**
- pnpm install fails on puppeteer postinstall (known issue), `--ignore-scripts` workaround used

**Learnings/notes:**
- The InfoBox Card previously used `overflow-hidden` which would clip any absolutely-positioned tooltips; changed to `overflow-visible` with rounded header corners instead
- The `pluralize()` helper needed both a -sis → -ses rule and an irregular plurals map
