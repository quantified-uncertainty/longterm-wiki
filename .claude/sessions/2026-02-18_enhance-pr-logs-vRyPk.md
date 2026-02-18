## 2026-02-18 | claude/enhance-pr-logs-vRyPk | Add LLM metadata to session/PR logs

**What was done:** Added three new optional fields to session logs — Model, Duration, and Cost — so the page-changes dashboard and per-page change history show which LLM did the work, how long it took, and approximate cost. Updated parser, types, tests, dashboard table (new Model column), and PageStatus sidebar.

**Model:** opus-4-6

**Duration:** ~30min

**Issues encountered:**
- None

**Learnings/notes:**
- The session log parser uses a simple regex pattern `**Field:**\s*(.+?)(?:\n\n|\n\*\*|\n---)` for each field, so new fields are trivial to add as long as they follow the same bold-label format
- Existing ~70 session files gracefully degrade — new fields are undefined for old sessions, shown as "—" in the dashboard
