## 2026-02-18 | claude/improve-commands-workflow | Programmatic session checklist system

**What was done:** Built `crux session init/status/complete` CLI — a typed checklist system that replaces the static checklist-template.md. Generates tailored checklists based on session type (content, infrastructure, bugfix, refactor, commands) from a 40-item catalog. Added Key Decisions logging, merge/CI verification items, and deduplicated `currentBranch()`. Simplified `/kickoff` and `/finalize` slash commands to use the new CLI.

**Pages:** none

**Model:** opus-4-6

**Duration:** ~45min

**Issues encountered:**
- `pnpm crux validate gate` fails on build-data step (pre-existing ERR_UNKNOWN_FILE_EXTENSION for .ts imports in build-data.mjs, same on clean main)
- `npx tsc --noEmit` in crux/ has many pre-existing errors (authoring, generate, rules modules); new session files compile clean
- Sandbox permission errors with npx (used local tsc binary instead)

**Learnings/notes:**
- The gate check build-data failure is pre-existing and should be tracked as a separate issue
- `currentBranch()` was duplicated across issues.ts and session-checklist.ts — fixed by having issues.ts import from session-checklist.ts
- Checklist round-trip tests (build then parse) are valuable for catching format mismatches
