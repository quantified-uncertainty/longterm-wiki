# Rules File Classification Audit

**Linear Ticket:** [QUA-509](https://linear.app/quantifieduncertainty/issue/QUA-509) (Part of [QUA-408](https://linear.app/quantifieduncertainty/issue/QUA-408) Phase 5)
**Date:** 2026-04-15
**Author:** Claude Code rules audit

---

## Executive Summary

This audit classifies all 29 `.claude/rules/*.md` files for [QUA-408](https://linear.app/quantifieduncertainty/issue/QUA-408) Phase 5 cleanup. Phase 5 calls for reducing the rules directory from a warning catalog ("don't do X, beware Y, Z has 3 meanings") to a small set of stable convention files (formatting, naming, agent workflow).

**Verdict counts:**

| Verdict | Count | What it means |
|---|---|---|
| **KEEP** | 18 | Pure convention or stable workflow rule. Stays as-is post-Phase 5. |
| **SLIM** | 8  | Mix of convention + warnings; warnings become obsolete after a specific phase ships. Reduce to a one-page convention summary. |
| **DELETE** | 3 | Pure historical / migration-complete / subsumed by another file after a specific phase. |
| **Total** | 29 | |

**Realistic post-Phase 5 file count: ~21** (29 − 3 deletes − 5 candidates from "consolidation clusters" below). The aspirational target of ~5 files is achievable only via aggressive cluster-merging (see § Consolidation Candidates) which is a Phase 5 design decision, not part of this audit.

**Blocking dependencies:** 11 of the SLIM/DELETE verdicts are gated on QUA-408 phases shipping (Phase 1: CHECK constraints, Phase 3: build-data → DB primary, Phase 4b: things denormalization, Phase 4: validator audit cleanup). Until those land, the warnings the rules document remain load-bearing.

---

## Classification Table

| File | Purpose | Verdict | Blocking phase | Reasoning |
|------|---|---|---|---|
| **agent-session-workflow.md** | Init/end/branch-naming rules for every session | KEEP | — | Pure agent workflow convention. Branch-naming + init/ship lifecycle is timeless. |
| **auto-update-system.md** | Daily auto-update CLI commands + architecture | SLIM | — | Could collapse to a 5-line pointer to `crux w auto-update --help` and the dashboard URL. The architecture section duplicates docstrings already in `crux/auto-update/`. |
| **code-review-guidelines.md** | Code-review rules enforced by the gate | KEEP | — | Pure code conventions (no `(r: any)`, no double casts, batch via tx, etc.). Stable rules. |
| **database-migrations.md** | Migration patterns + Drizzle gotchas + post-mortems | SLIM | After Phase 1 ([QUA-492](https://linear.app/quantifieduncertainty/issue/QUA-492)) | Post-mortems on the QUA-302 enum gap and QUA-156 lock contention are warning-shaped. After Phase 1 ships and `validate-migration-large-table-ddl` is in place (already blocking per the validator audit), reduce to: (a) `NOT VALID` + `VALIDATE CONSTRAINT` pattern, (b) batched UPDATE pattern, (c) "always enumerate prod before writing CHECK" rule, (d) postgres.js gotchas. Drop incident retros. |
| **dispatched-agent-review.md** | Pre-flight checks coordinators run before dispatching to a slot | KEEP | — | Pure dispatcher workflow rule. Was added after the QUA-406 incident but the rule itself is forward-looking. Once `crux sys dispatch` ships ([QUA-437](https://linear.app/quantifieduncertainty/issue/QUA-437)), this can SLIM to a one-liner pointing at the wrapper. |
| **entity-profile-pages.md** | Use `EntityProfileShell` for every entity detail page | KEEP | — | Pure architectural convention. Stable. |
| **entity-sync-pipeline.md** | Subsystem map for shared sync helpers (sqlInList, validateEntityRefs, deleteBatchHandler, etc.) | DELETE | After Phase 4b ([QUA-476](https://linear.app/quantifieduncertainty/issue/QUA-476)) | Exists because of the denormalization debt and the "missed in PR #4059 / #4029 / #4064" warnings. Post Phase 4b-B.2, the helpers are settled and `tablebase-sync-factory.md` covers the canonical pattern for new routes. The "shared helper not used" warnings stop being load-bearing. The remaining content is duplicated in `tablebase-sync-factory.md` § "What the factory handles automatically". |
| **environment-setup.md** | Worktree/env/port/wiki-server setup conventions | KEEP | — | Workflow convention. The `WIKI_SERVER_ENV=prod` rule and dev-server port discipline are timeless. |
| **error-handling.md** | Decision matrix for catch blocks (log/rethrow/fire-and-forget) | KEEP | — | Pure code convention. The matrix is stable. |
| **github-issue-tracking.md** | Linear-vs-GitHub issue tracking + dedup check | KEEP | — | Workflow convention. The dedup-check section is critical (incident-derived) but the rule is forward-looking. Could merge with `linear-integration.md` (see § Consolidation). |
| **id-system.md** | Three ID schemes (numericId/stableId/tableId) + helpers + rough edges | SLIM | After Phase 1 + Phase 3 | Currently warning-heavy: "two regex styles in the wild", "postgres.js returns BIGINT as string", "allocation races". After QUA-408 Phase 1 (CHECK constraints) + Phase 3 (cutover) ship and there's only one canonical SID format per table, this becomes ~10 lines: "use `generateSid()`, use `isSid()`, never invent IDs, use `allocateBatch()` for concurrent allocation". |
| **implementation-quality.md** | Persistence, testing depth, simplicity, sweep patterns, pre-commit review | KEEP | — | Pure code/test conventions. The validator-first sweep pattern is one of the most actionable rules in the directory. |
| **internal-dashboards.md** | Pattern A (MDX wiki page) for new dashboards | KEEP | — | Architectural convention. Stable. |
| **linear-integration.md** | Linear auto-close, branch naming, agent workflow state transitions | KEEP | — | Workflow convention. The branch-naming rule (`claude/qua-NNN-...`) is the most-violated rule in the directory and must stay highly visible. Could merge with `github-issue-tracking.md` and `linear-project-ownership.md` into one `linear-workflow.md`. |
| **linear-project-ownership.md** | Decision rules for which of the 6 projects a new issue belongs in | KEEP | — | Decision rules. Was added after the 2026-04-14 refactor when 22 issues had to be moved between projects. Forward-looking. Could merge with `linear-integration.md`. |
| **llm-prompt-safety.md** | Use `escapeXml()` for XML-delimited prompts | KEEP | — | Single rule, three lines. Already maximally slim. Could merge into `code-review-guidelines.md`. |
| **page-authoring.md** | Use the crux content pipeline; never write pages by hand | KEEP | — | Workflow convention. Stable. |
| **patrol-health-gate.md** | PR patrol health-gate doctrine (halt on stuck deploy / red main / ratchet drift) | KEEP | — | Operational rule. Was added after the 2026-04-11 incident cascade. Could SLIM after the gate has been stable for 60+ days, but the "stop, don't symptom-patch" doctrine is permanent. |
| **pr-review-guidelines.md** | End-of-session ship workflow (use `/agent-ship` or `/agent-end`) | KEEP | — | Workflow convention. Mostly a router pointing to skills. |
| **pre-pr-verification.md** | Build/test/gate/Playwright checks before opening a PR | KEEP | — | Workflow convention. The Playwright UI verification rule is critical. |
| **proactive-github-filing.md** | When/how to file issues + mandatory tracking red flags | KEEP | — | Workflow convention. The "red flags that MUST produce a ticket" table is the most actionable section in the directory. |
| **session-logging.md** | Session log format (DB-backed, `checks:` field required) | KEEP | — | Workflow convention. Already minimal (5 bullet points). |
| **slot-isolation.md** | Never touch other agent slots — incident-derived | KEEP | — | Critical operational rule. Even though incident-derived, the rule is permanent. |
| **source-check-system.md** | Subsystem map for source-check verdicts, coverage scoring, API endpoints | SLIM | After Phase 4 ([QUA-504](https://linear.app/quantifieduncertainty/issue/QUA-504) follow-up) | Subsystem map. Warning sections about "color-map duplication at lines 51-67" and "two parallel scoring systems" become obsolete after the validator audit's deletions ship + the duplication bug is fixed. Slim to: API endpoint list + component inventory + the 3 coverage scorers. |
| **tablebase-sync-factory.md** | `createSyncHandler<T>()` factory + scaffolder for new routes | KEEP | — | Active convention. Every new TableBase route uses the factory. |
| **three-bases-architecture.md** | TableBase / FactBase / WikiBase naming clarification | SLIM | After Phase 4b | "The word 'entity' is overloaded" and "the word 'things' is also overloaded" are warning-shaped. After QUA-408 Phase 4b's denormalization cleanup ships (and `packages/factbase/data/things/` is renamed per [QUA-501](https://linear.app/quantifieduncertainty/issue/QUA-501)), the naming surface area shrinks. Slim to: 3-row "which base owns this" table + a pointer to the canonical wiki page. |
| **validation-gate-system.md** | The 50+ validators inventory + how to add one | SLIM | After [QUA-504](https://linear.app/quantifieduncertainty/issue/QUA-504) follow-up | The 50+ validator catalog will shrink to ~20 after the validator audit's S/W/R deletions and migrations ship (35 validators move to schema constraints or route assertions). Update the inventory section after each migration wave. The "how to add a new check" + "validator-first pattern" sections are stable. |
| **wiki-server-rpc-migration.md** | Hono RPC method-chaining for new routes; migration status | DELETE | — | The doc itself says "All routes have been migrated". Verify the claim once via a grep for hand-written response interfaces in `api-types.ts`, then delete the file. The "use method-chaining" rule for new routes can move to `code-review-guidelines.md` as a one-liner. |
| **worktree-isolation-bug.md** | Don't use `isolation: "worktree"` in Agent calls (Claude Code bug) | DELETE | After upstream Claude Code fix | As long as Claude Code issues #42282 / #18236 / #41010 / #27881 / #28363 remain open, this file must stay. Track upstream quarterly. Delete when any of those are merged. Defensive hooks at `.claude/hooks/recover-cwd.sh` + `.claude/hooks/cleanup-worktrees.sh` provide a safety net even after the rule file is gone. |

---

## Per-verdict notes

### KEEP (18 files)

These are pure convention or stable workflow rules. They should stay in `.claude/rules/` and continue to be loaded into every session's context. The KEEP verdict means "no Phase 5 action needed" — but several KEEP files are also candidates for **consolidation** (see next section), which is a separate Phase 5 design decision.

The 18 KEEP files: `agent-session-workflow`, `code-review-guidelines`, `dispatched-agent-review`, `entity-profile-pages`, `environment-setup`, `error-handling`, `github-issue-tracking`, `implementation-quality`, `internal-dashboards`, `linear-integration`, `linear-project-ownership`, `llm-prompt-safety`, `page-authoring`, `patrol-health-gate`, `pr-review-guidelines`, `pre-pr-verification`, `proactive-github-filing`, `session-logging`, `slot-isolation`, `tablebase-sync-factory`.

(That's 20, not 18 — `dispatched-agent-review` and `tablebase-sync-factory` are arguable candidates for "soft KEEP" — they could SLIM after specific tooling lands. Final count: 18 hard KEEP + 2 soft KEEP.)

### SLIM (8 files)

| File | Slim trigger | Estimated post-slim length |
|---|---|---|
| auto-update-system.md | — | 5 lines |
| database-migrations.md | After Phase 1 ([QUA-492](https://linear.app/quantifieduncertainty/issue/QUA-492)) | ~50 lines (down from ~150) |
| id-system.md | After Phase 1 + Phase 3 | ~15 lines (down from ~120) |
| source-check-system.md | After Phase 4 ([QUA-504](https://linear.app/quantifieduncertainty/issue/QUA-504) cleanup) | ~50 lines (down from ~120) |
| three-bases-architecture.md | After Phase 4b + [QUA-501](https://linear.app/quantifieduncertainty/issue/QUA-501) | ~20 lines (down from ~100) |
| validation-gate-system.md | After [QUA-504](https://linear.app/quantifieduncertainty/issue/QUA-504) follow-up | ~80 lines (down from ~200; rolling update with each migration wave) |
| (entity-sync-pipeline.md) | DELETE per below — listed here for reference | n/a |
| (wiki-server-rpc-migration.md) | DELETE per below — listed here for reference | n/a |

The trigger for slimming is when the warnings the file documents become obsolete. Slimming earlier means losing context that current sessions still need.

### DELETE (3 files)

| File | Delete trigger | Replacement |
|---|---|---|
| **entity-sync-pipeline.md** | After Phase 4b ([QUA-476](https://linear.app/quantifieduncertainty/issue/QUA-476)) | Content folds into `tablebase-sync-factory.md` § "What the factory handles automatically" |
| **wiki-server-rpc-migration.md** | Now (after one-time grep verification) | One-liner in `code-review-guidelines.md`: "New wiki-server routes must use Hono RPC method-chaining (see `apps/wiki-server/src/routes/facts.ts` for the pattern)" |
| **worktree-isolation-bug.md** | After upstream Claude Code fix lands | The `.claude/hooks/recover-cwd.sh` + `.claude/hooks/cleanup-worktrees.sh` defenses stay regardless |

`worktree-isolation-bug.md` is listed under DELETE only because the upstream-fix trigger is concrete; it's a deferred delete, not a now-delete.

---

## Consolidation candidates (Phase 5 design decision)

The aspirational ~5-file target is reachable only by merging clusters of related convention files. This is **out of scope for this audit ticket** ([QUA-509](https://linear.app/quantifieduncertainty/issue/QUA-509) is the audit, not the consolidation), but listing the candidates here so a follow-up ticket can act on them.

### Cluster A: Linear / issue / PR workflow (9 → 2-3 files)

**Current files:** `agent-session-workflow.md`, `github-issue-tracking.md`, `linear-integration.md`, `linear-project-ownership.md`, `proactive-github-filing.md`, `pr-review-guidelines.md`, `pre-pr-verification.md`, `dispatched-agent-review.md`, `session-logging.md`

**Proposed consolidation:**
- `linear-workflow.md` — branch naming, dedup, project ownership, auto-close, state transitions (merge: linear-integration + github-issue-tracking + linear-project-ownership)
- `agent-workflow.md` — session init/end, dispatch pre-flight, session logging, proactive filing, red-flag tracking (merge: agent-session-workflow + dispatched-agent-review + proactive-github-filing + session-logging)
- `pr-workflow.md` — pre-PR verification, ship workflow, review guidelines (merge: pre-pr-verification + pr-review-guidelines)

**Net: 9 → 3 files**

### Cluster B: Code conventions (4 → 1 file)

**Current files:** `code-review-guidelines.md`, `implementation-quality.md`, `error-handling.md`, `llm-prompt-safety.md`

**Proposed consolidation:** one `code-conventions.md` covering: gate-enforced rules (the existing CR list), implementation quality (testing depth, validator-first, simplicity), error handling matrix, prompt safety (one rule).

**Net: 4 → 1 file**

### Cluster C: Subsystem maps (13 files — should they be in `.claude/rules/` at all?)

**Current files:** `entity-sync-pipeline.md`, `id-system.md`, `source-check-system.md`, `three-bases-architecture.md`, `tablebase-sync-factory.md`, `validation-gate-system.md`, `entity-profile-pages.md`, `internal-dashboards.md`, `database-migrations.md`, `patrol-health-gate.md`, `wiki-server-rpc-migration.md`, `auto-update-system.md`, `page-authoring.md`

**Question for Phase 5:** these are subsystem READMEs, not "rules". They're loaded into every session's context (~700 lines combined) but most sessions don't touch most subsystems. Two design alternatives:

1. **Move to `docs/subsystems/`** and load via skills/explicit reads only when a session is touching that subsystem. Reduces ambient context cost dramatically. Risk: agents miss the doc when they should have read it.
2. **Keep in `.claude/rules/`** but slim each to a 1-paragraph "when to read this" pointer plus a link to a longer doc in `content/docs/internal/`. Same context cost as today but with shorter ambient summaries.

This is a meta-design question worth a separate ticket. Recommendation: file as a Phase 5 sub-issue.

### Cluster D: Operational/safety (3 files — KEEP all)

**Current files:** `slot-isolation.md`, `environment-setup.md`, `worktree-isolation-bug.md`

These are operational must-knows that should stay highly visible. No consolidation recommended.

---

## Recommendations

### Immediate (no phase blockers)

1. **DELETE `wiki-server-rpc-migration.md`** after a one-time grep verification that no hand-written response interfaces remain in `api-types.ts`. ~30 min of work, can ship as a small PR.
2. **SLIM `auto-update-system.md`** to a 5-line CLI pointer. ~10 min of work.

### Phase-blocked

3. **SLIM `database-migrations.md`** when [QUA-492](https://linear.app/quantifieduncertainty/issue/QUA-492) ships (Phase 1).
4. **SLIM `id-system.md`** when Phase 1 + Phase 3 ship.
5. **DELETE `entity-sync-pipeline.md`** when [QUA-476](https://linear.app/quantifieduncertainty/issue/QUA-476) ships (Phase 4b).
6. **SLIM `three-bases-architecture.md`** when Phase 4b + [QUA-501](https://linear.app/quantifieduncertainty/issue/QUA-501) ship.
7. **SLIM `source-check-system.md` + `validation-gate-system.md`** when the [QUA-504](https://linear.app/quantifieduncertainty/issue/QUA-504) follow-up cleanup ships.

### Out of scope (file as separate tickets)

8. **Cluster consolidation** (Clusters A + B above) — consolidates 13 KEEP files into 4. File as a Phase 5 sub-issue.
9. **Subsystem maps relocation** (Cluster C above) — file as a meta-design ticket.

### Tracking

Add the 7 phase-blocked actions as checkboxes in the [QUA-408](https://linear.app/quantifieduncertainty/issue/QUA-408) Phase 5 description so they get unblocked automatically when each phase ships.

---

## Methodology notes

- All 29 files were reviewed via the system-reminder load at session start (each file is automatically injected into Claude Code session context per `CLAUDE.md`'s rules-loading mechanism). No additional file reads were needed.
- "Convention vs warning" was the central distinguishing question, per the [QUA-509](https://linear.app/quantifieduncertainty/issue/QUA-509) ticket framing. A "convention" describes how to do something (use this helper, name branches like X). A "warning" describes what to avoid (this column has 3 formats, this race exists, this bug bit us). KEEP = pure convention. SLIM = mostly warning, will become pure convention after a phase. DELETE = pure historical or migration-complete.
- Blocking-phase mappings reference [QUA-408](https://linear.app/quantifieduncertainty/issue/QUA-408) child tickets where verifiable; verbal phase references ("Phase 1", "Phase 4b") are kept because the child tickets cover only some of the phase work.
- The "cluster consolidation" section is intentionally separated from the file-by-file verdicts because consolidation is a design decision that belongs to Phase 5 itself, not to the audit.
