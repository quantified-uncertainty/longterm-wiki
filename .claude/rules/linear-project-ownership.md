# Linear Project Ownership — Which Project Does This Belong To?

Decision rules for filing new Linear issues into the right QUA project. Read this **when filing a new issue** or **when flagging an existing issue as miscategorized** — the 6 projects have overlapping-sounding names and the wrong call gets made repeatedly without an explicit doctrine.

Derived from the 2026-04-14 Linear refactor pass, which moved ~22 issues between projects to fix scope drift and found that the most common miscategorizations are sourcing work scattered across 3 projects, dashboards vs monitoring blurred, and page authoring landing in infra.

---

## The 6 open projects — one-line scope

| Project | Owns |
|---|---|
| **Automation & Infrastructure** | CI gate, validation system, build/test infra, scheduled jobs, deploy pipeline, crux CLI itself |
| **Coordinator & Agent Tooling** | Agent session lifecycle (`/agent-init`, `/agent-ship`, `/agent-end`), Linear-GH integration, hook system, PR patrol runtime, slot/tmux tooling |
| **Data Integrity** | Schema, concurrency, write-path correctness, validation invariants — across the wiki data model. NOT sourcing-specific. |
| **Content Quality & Enrichment** | Page authoring, FactBase fact curation, entity data enrichment, citation infrastructure for content |
| **Source-Check & Verification** | Source-check verdicts, evidence tracking, verification-dot UI, `source_check_*` / `sourcing_*` tables, claims-first enforcement, coverage expansion |
| **Dashboards & Visibility** | Internal `/internal/*` dashboards, coverage/verification dot indicators, `EntityProfileShell` and profile-page UI, operational monitoring UIs |

---

## Decision rules — the three confusable boundaries

### Boundary 1: Sourcing vs Data Integrity vs Automation

This is the most common miscategorization. All three projects can plausibly claim issues about `source_check_*` tables, sourcing validators, or the sourcing ratchet.

**Rule**: **if the word "sourcing" or "source-check" appears in the title or the fix, it belongs in Source-Check & Verification.** No exceptions, even if the fix also touches the validation gate, PG schema, or a crux command.

| Example issue | Wrong home | Right home | Why |
|---|---|---|---|
| "Add PG CHECK constraint on `source_check_verdicts.record_type`" | Data Integrity (it's schema) | **Source-Check** | The table is sourcing-specific. |
| "Extract `VALID_RECORD_TYPES` + `SOURCING_EXEMPT_TYPES` into shared package" | Data Integrity (type safety) | **Source-Check** | Types are sourcing-scoped. |
| "Re-enable sourcing ratchet on PR branches" | Automation (CI gate) | **Source-Check** | The ratchet rule itself is sourcing-specific. |
| "`validate-sourcing-coverage.ts` crashes on undefined" | Automation (validator bug) | **Source-Check** | It's a sourcing validator. |

**Data Integrity owns**: schema/concurrency/write-path issues for **non-sourcing** tables — the core wiki data model, prediction market snapshots, general FK invariants, generated columns, etc. See the QUA-154 7-tier structure as canon.

**Automation & Infrastructure owns**: the validation gate *infrastructure* (how validators run, gate-triage, baseline ratchets as a class, CI orchestration) but not the individual validators that are sourcing-specific.

### Boundary 2: Dashboards & Visibility vs Automation & Infrastructure

**Rule**: **is the user-facing surface a dashboard/UI, or a background job?**

- If it renders pixels on `/internal/*` or on a user-facing detail page → **Dashboards & Visibility**.
- If it's a scheduled job or gate check that writes data (which may later appear in a dashboard) → **Automation & Infrastructure**.

| Example issue | Home | Why |
|---|---|---|
| "Monitor `build-data.mjs` complexity" | Automation | It's a build-time job. The monitor runs in CI, not as a UI. |
| "`/internal/data-quality` page shows stale stats" | Dashboards | The symptom is UI pixels. |
| "Groundskeeper scan job fails silently" | Automation | Background job correctness. |
| "Add coverage-by-project dashboard card to `/internal/coverage`" | Dashboards | New UI pixels. |

**Dashboards & Visibility also owns** `EntityProfileShell` migration and entity detail page layout, because the primary concern is rendering, not data correctness.

### Boundary 3: Content Quality & Enrichment vs Dashboards & Visibility

Both care about user-facing content. Splits on **authoring vs navigation/display**.

**Rule**:
- **Authoring** (filling stub pages, adding sources to entities, writing MDX, curating facts) → **Content Quality & Enrichment**.
- **Display/navigation** (entity profile shell, directory tables, coverage dots, data-source detail pages) → **Dashboards & Visibility**.

The ambiguous case: a new `/internal/*` dashboard that's also a content page. **Follow Pattern A** (`.claude/rules/internal-dashboards.md`) — the dashboard itself is a wiki page, so the *infrastructure* for making the dashboard is Dashboards & Visibility, but the *content* on it is Content Quality. In practice, file the parent issue in Dashboards and any fact-curation work under it as Content Quality.

---

## Coordinator & Agent Tooling — what DOESN'T belong

This project is specifically about the **Claude Code session lifecycle** and the agent-workflow infrastructure that surrounds it. It does **not** own:

- **General CI fixes** (even if triggered by an agent session) → Automation & Infrastructure
- **Validation gate fixes** (even if an agent hit them) → Automation & Infrastructure
- **Sourcing validators** (even if an agent filed the issue) → Source-Check & Verification
- **Wiki content bugs** (even if an agent produced them) → Content Quality & Enrichment

| Example issue | Wrong home | Right home | Why |
|---|---|---|---|
| "`deploy-tasks detect` false-positive on `NO_COLOR` env" | Coordinator (agent tool) | **Automation** | It's a crux CLI subcommand, not session lifecycle. |
| "Gate override rate at 46% — investigate bypasses" | Coordinator (agent-workflow) | **Automation** | The gate itself is infra. |
| "End-to-end test: agent batch workflow" | Automation (it's a test) | **Coordinator** | The thing being tested is the agent workflow. |
| "Automate groundskeeper-health audit" | Coordinator (automation) | **Dashboards** | The output is a visibility surface. |

---

## Common scope-creep smell tests

When you catch yourself filing an issue in Automation & Infrastructure, ask:

1. Is the word **sourcing/source-check** in my title? → Source-Check & Verification.
2. Is the output a **user-facing dashboard or page**? → Dashboards & Visibility.
3. Am I **authoring wiki content or enriching entity data**? → Content Quality & Enrichment.
4. Is this **only relevant inside an agent session lifecycle**? → Coordinator & Agent Tooling.
5. Is this a **schema/concurrency/FK invariant** for non-sourcing tables? → Data Integrity.

Only if none of the above fires does it stay in Automation & Infrastructure. That project accumulated 47+ issues in April 2026 because scope was never challenged — it had become the default landing zone.

## Cross-project dependencies — document them

If an issue in Project A has a parent, blocker, or subtask in Project B, **note it in both project descriptions' "Current focus" sections**. Dependencies that aren't documented stall when one side is deprioritized.

Example: QUA-224 (Grafana dashboard, Dashboards) depends on QUA-221 (Agent Session Logging, Coordinator). Neither project description mentioned this; the dependency was invisible until someone traced parents.

## When in doubt

1. **File in the project the title suggests**, then wait for disagreement.
2. **Don't create a new project** for a single issue. Projects are strategic — 6-8 is the current count and more would fragment further.
3. **Move is cheap, rename is visible**. Moving an issue between projects is a one-click reversible edit; renaming or creating projects is broadly visible and should be discussed first.

## Historical: why this doc exists

2026-04-14 Linear refactor pass found:
- **16 orphan issues** (no project)
- **22 issues in the wrong project** (sourcing split 3 ways being the worst cluster)
- **3 closed umbrella issues** still cited as "Current focus" in project descriptions
- **22 → 0 labels** after removing migration-era cruft

The root cause of miscategorization wasn't malice — it was that the boundary between adjacent projects (sourcing/data-integrity, dashboards/automation, coordinator/automation) had never been written down. This doc is that boundary. Update it when a new systematic miscategorization emerges; don't let scope doctrine drift back into "gut feel."
