# active_agents Column Audit (QUA-445 Phase A)

**Context:** QUA-445 proposes merging `active_agents` into `agent_sessions`. Before moving columns, audit which of the "unique-to-active_agents" columns are actually written programmatically vs. dead.

**Date:** 2026-04-14
**Scope:** Columns on `active_agents` that have no equivalent on `agent_sessions`: `session_name`, `current_step`, `files_touched`, `heartbeat_at`, `metadata`.

## Findings

### `current_step` — ACTIVE, keep

Write paths:

| File | Call site | Frequency |
|------|-----------|-----------|
| `apps/groundskeeper/src/scheduler.ts:260` | `currentStep: \`${name}: ${result.summary ?? event} (${Math.round(durationMs / 1000)}s)\`` | Every task completion in the groundskeeper loop (~every 30-60s) |
| `apps/groundskeeper/src/scheduler.ts:343` | `currentStep: \`${name}: ERROR — ${errorMessage.slice(0, 100)}\`` | On every groundskeeper task error |
| `apps/groundskeeper/src/wiki-server.ts:176` | `updates: { currentStep?: string; status?: string }` — shared wrapper | Via scheduler.ts above |
| `crux/worker/run.ts:206, 218` | `currentStep: 'Processing X job(s)...' / 'Polling for jobs'` | Every worker poll cycle |
| `crux/commands/agents.ts:241` | `if (options.step !== undefined) updates.currentStep = options.step;` | Manual CLI: `crux agents update --step="..."` |

Writes are frequent (groundskeeper updates every task completion). The column is load-bearing on the Active Agents dashboard for human visibility. **Preserve** — when `active_agents` is dropped, `current_step` needs to move to `agent_sessions`.

### `files_touched` — DEAD-ISH, defer removal

Write paths:

| File | Call site | Frequency |
|------|-----------|-----------|
| `crux/commands/agents.ts:246` | `if (options.files !== undefined) updates.filesTouched = options.files.split(',').map(f => f.trim())` | Manual CLI only: `crux agents update --files=a,b,c` |

No programmatic writers. Only a manual CLI flag that's rarely (never?) used in practice.

**Options:**
1. Drop in Phase E along with the table.
2. Repurpose to auto-populate from git diff at checklist complete time (nice-to-have, out of scope for QUA-445).

**Decision:** don't migrate to `agent_sessions`. When `active_agents` is dropped, `--files` silently becomes a no-op; document at that time.

### `heartbeat_at` — CORE, moving in Phase B

Core liveness signal. `heartbeat_at` column added to `agent_sessions` in migration 0179 (this PR). Heartbeat hook now populates both tables' `heartbeat_at`.

### `session_name` — DORMANT

Grep shows no writers; only readers on the dashboard (`agent-activity/active-agents-table.tsx:87`). Field reads come from `active_agents.sessionName` which is never set by anything.

**Decision:** drop at Phase E drop-time; dashboard will lose the Name column, which is fine since it's always blank today.

### `metadata` (jsonb) — DORMANT

No writers. Defined in schema but unused.

**Decision:** drop at Phase E. If a use case emerges, put it on `agent_sessions`.

## Summary for Phase B

Columns that must migrate to `agent_sessions` before dropping `active_agents`:

- `heartbeat_at` — **done in this PR** (migration 0179)
- `current_step` — needs a follow-up PR adding the column + updating groundskeeper + worker writers. **Not in this PR.** Filed as Phase C work.

Columns that can be dropped without migration:

- `files_touched` — manual CLI only, effectively unused
- `session_name` — no writers
- `metadata` — no writers

## Next phase (Phase C)

Add `current_step` to `agent_sessions`. Update groundskeeper and worker to write there in addition to `active_agents`. Keep `active_agents.current_step` writes until the dashboard flip in Phase D.
