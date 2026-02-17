## 2026-02-17 | claude/add-changelog-pr-links-9vI0W | Add PR links to change history

**What was done:** Added support for PR links in the Change History UI and page-changes table. Extended the session log format with an optional `**PR:**` field, updated the parser to extract PR numbers (from `#NNN` or full GitHub URLs), flowed the `pr` field through `ChangeEntry` → `PageChangeItem` → UI components, and backfilled PR numbers into all 47 existing session log files using the GitHub API.

**Pages:** (no wiki content pages changed)

**Issues encountered:**
- The `build-data.mjs` script has a pre-existing environment issue where `DATA_DIR` resolves to `/home/user/data` instead of the repo's `data/` directory, preventing full gate validation in this sandbox

**Learnings/notes:**
- All session logs without `**Pages:**` fields are infrastructure-only sessions that don't appear in change history, so they don't need PR backfilling
- The PR field is optional and backward-compatible — entries without it render exactly as before
