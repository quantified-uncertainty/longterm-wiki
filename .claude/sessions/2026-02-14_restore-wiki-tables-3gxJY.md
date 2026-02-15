## 2026-02-14 | claude/restore-wiki-tables-3gxJY | Fix missing tables on /wiki explore page

**What was done:** Fixed a bug where 4 of 7 table pages were not showing up under the "Tables" filter on the /wiki explore page. The root cause was that table pages with matching entity definitions were routed through `entityItems` (which uses `entity.entityType` as the display type) instead of getting type "table". Added a `contentFormat` override so pages with `contentFormat: "table"` or `"diagram"` get the correct display type regardless of their entity type. Added 3 regression tests to prevent recurrence.

**Pages:** (no wiki content pages changed)

**Issues encountered:**
- The `pnpm install` had puppeteer download failures (network), and `vitest`/`next` binaries weren't on PATH — had to invoke them via full pnpm store paths.

**Learnings/notes:**
- When entities have matching page IDs, the entity's `entityType` overrides the page's `contentFormat` for the explore grid type. Any future `contentFormat` values need to be handled in the same override logic in `getExploreItems()`.
- Added regression tests in `data.test.ts` that verify all `contentFormat: table` pages get `type: "table"` in explore items, regardless of whether they have entities.
