# Dispatch & Orchestration Tool Evaluation — April 2026

**Author**: agent session 2026-04-24, slot a10, branch `claude/dispatch-orchestration-evaluation`
**Scope**: evaluate 5 third-party agent-orchestration tools against our existing `./ws dispatch` + slot-orchestration coordinator workflow. Recommend whether to adopt one, vendor pieces from one, or stay on the local stack.

## TL;DR — recommendation

**Stay on the local stack. Run a focused 1-day spike of `bassimeledath/dispatch` only, against the narrow problem of "coordinator main session fills up too fast."**

Reasoning:
1. **Our `./ws` + `crux sys dispatch` + `crux pr-patrol` stack is roughly equivalent in capability** to ComposioHQ AO and Overstory, and is purpose-built for this codebase (slot model, port allocation, `agent_sessions` PG dedup, Linear/GH integration, audit log, `--force` reconciliation). Replacing it would be a multi-week migration to gain… roughly the same thing, with a different bug surface.
2. **Mission Control, AO, and Overstory all assume "single repo, agents = worktrees inside it"**. We deliberately rejected worktrees (`.claude/rules/worktree-isolation-bug.md`) in favor of independent-clone slots after a confirmed Claude Code bug (#42282) corrupted parent CWD. Any tool that re-introduces worktrees is a regression for us.
3. **Agent Teams (official) is interesting for a different problem** — *intra-session* parallelism inside a single coordinator (research with competing hypotheses, parallel review). It does NOT solve cross-session dispatch. Worth enabling experimentally for high-token review/research tasks, with `teammateMode: in-process` (no tmux split panes — we already manage tmux ourselves).
4. **`bassimeledath/dispatch` is the only tool that solves a problem we don't already solve well**: keeping the *coordinator's* context lean by spawning fire-and-forget workers from inside the coordinator's own session. Our `./ws dispatch` solves dispatch from the shell, not from inside Claude — every coordinator dispatch currently bloats the coordinator's context with the full task description + status polling. Worth a 1-day spike.

**No spike was run** during this evaluation — see [§Spike notes](#spike-notes) for why and the recommended follow-up.

---

## What we already have (the baseline)

The longterm-wiki coordinator stack, in rough capability order:

| Layer | Implementation | Maps to (in third-party tools) |
|---|---|---|
| Independent-clone slots `a1`–`a20` with port isolation | `lw/ws` + `crux/commands/agent-workspace.ts` (1,439 LOC) | "worktrees" in AO/Overstory, but with stronger isolation |
| Headless dispatch with `claude -p` + stream-JSON capture | `crux/commands/dispatch.ts` (440 LOC) | `ao start`, `ov sling`, `bassimeledath /dispatch` |
| Tmux window naming + `./ws open <N> --claude` | `lw/ws` | `ov inspect`, `ao` dashboard sessions |
| PR patrol w/ health gate, ratchet-drift detector, per-fingerprint cooldown | `crux/commands/pr-patrol.ts` (364 LOC) + `.claude/rules/patrol-health-gate.md` | AO `reactions:` block (CI-failed, changes-requested) |
| Cross-session dedup against PG `agent_sessions` + Linear comments + open PRs | `crux/commands/dispatch.ts::preflight` + `crux sys dispatch` (QUA-437) | none of the 5 tools ship this — they assume single operator |
| Linear-aware branch naming + auto-close + start/done state | `crux/commands/linear.ts` + `.claude/rules/linear-integration.md` | AO `tracker: linear`, MC GitHub-Issues sync (one-way) |
| Hook layer: `inject-wip-checklist`, `verify-checklist-on-stop`, `recover-cwd`, `cleanup-worktrees` | `.claude/hooks/*.sh` | AO/MC: hook profiles (minimal/standard/strict) |
| Session-end review via `/agent-review-pr` + `/agent-ship` mandatory pipeline | `.claude/commands/*.md` | none ship review-before-PR mandatorily |

Our gaps vs. the third-party fleet:
- **No live TUI dashboard** of all running agents (we have `crux sys sessions list` + `./ws list`, both single-shot).
- **No coordinator-internal dispatcher** (the `bassimeledath/dispatch` niche).
- **No automatic CI-failure → re-dispatch loop** (we patrol PRs but the fix path is operator-driven).
- **No multi-runtime support** — we are Claude-Code-only. Codex/Aider/Cursor adapters do not exist; we have not had a concrete need.

---

## The 5 tools

### 1. Claude Code Agent Teams + `/batch` (official, experimental)

**Source**: [code.claude.com/docs/en/agent-teams](https://code.claude.com/docs/en/agent-teams)
**Status**: experimental, requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, Claude Code v2.1.32+, Opus 4.6 access.

**Model**: in-process or split-pane. A *team lead* (the main session) spawns *teammates* — separate Claude Code instances with their own context windows, all in the same project root, communicating via a shared task list + mailbox. State lives in `~/.claude/teams/{name}/config.json` and `~/.claude/tasks/{name}/`.

**Comparison to subagents** (their own framing): subagents only report back to the parent and can't talk to each other; teammates message each other directly and self-claim from a shared task list. Teammates do NOT inherit the lead's conversation history.

**`/batch`**: not actually documented as a Claude Code core command. The community references (Piebald-AI/claude-code-system-prompts) suggest it's a community-released slash command for git-worktree-based parallelization. In our repo, `/batch` is an alias that "redirects to validator-first sweeps or agent slots" — i.e. we already collapsed it into our existing infra.

**Best for** (per Anthropic's own guidance): research/review with competing perspectives, debugging with competing hypotheses, cross-layer features where each layer is owned by one teammate. Explicitly **bad for** sequential tasks, same-file edits, or work with many dependencies. **Token cost scales linearly with teammate count.**

**Fit for us**:
- ✅ Plausible win for `/agent-review-pr`-style reviews (security + perf + tests in parallel, debate cross-checks).
- ✅ Plausible win for the "5 hypotheses" debugging pattern.
- ❌ Does NOT solve our core need (cross-session, fire-and-forget, multi-day dispatch). Teams die with the lead session.
- ❌ Single-team-per-session limit. No nested teams. `/resume` doesn't restore in-process teammates.
- ⚠️ Split-pane mode requires tmux/iTerm2 — would conflict with our existing tmux window-naming loop.

**Verdict**: enable experimentally for review/research workloads inside `coord/` and `a*` slots, in-process mode only. Do not use for dispatch.

---

### 2. Overstory (`jayminwest/overstory`)

**Source**: [github.com/jayminwest/overstory](https://github.com/jayminwest/overstory)
**Stack**: Bun + tmux + SQLite. ~37 commands (`ov sling`, `ov coordinator start`, `ov dashboard`, `ov mail`, `ov merge`, `ov watch`, …). MIT.

**Architecture**: instruction overlays + tool-call guards + custom SQLite mail (WAL, ~1–5ms queries) + FIFO merge queue with 4-tier conflict resolution + tiered watchdog (mechanical daemon → AI triage → monitor agent). Pluggable `AgentRuntime` interface across 11 runtimes (Claude Code, Pi, Gemini, Aider, Goose, Amp, Codex, Copilot, Cursor, Sapling, OpenCode).

**Agent role tree**:
```
Orchestrator (multi-repo)
  → Coordinator (per project)
    → Supervisor / Lead
      → Scout (read-only) / Builder (read-write) / Reviewer / Merger / Monitor
```

**Notable explicit warning** in their README: *"Agent swarms are not a universal solution. Compounding error rates, cost amplification, debugging complexity, and merge conflicts are the normal case, not edge cases."* They link a STEELMAN.md and recommend reading it before deploying.

**Fit for us**:
- ✅ The architecture is the most thoughtful of the 5 — explicit role-based RBAC (read-only scouts, read-write builders), guard hooks per runtime, watchdog tiers, SQLite mail. Several pieces map to ideas we'd build ourselves eventually.
- ✅ Multi-runtime adapters would let us experiment with Codex/Gemini for cheap parallel tasks.
- ❌ **Worktree-based.** Direct conflict with our anti-worktree rule (Claude Code bug #42282).
- ❌ Maintained part-time, PRs reviewed in 2-week batches, PRs >200 LOC require a discussion first. Slow channel for fixes if we hit a blocker.
- ❌ Mailbox + merge queue + watchdog is a lot of infra to learn for what is essentially the problem `./ws` already solves for us.
- ⚠️ Agent definitions live in `.overstory/` with bidirectional sync to disk — would need to coordinate with our `.claude/` rules and hooks.

**Verdict**: read STEELMAN.md and CLAUDE.md for ideas (especially the watchdog tiering and SQLite mail patterns), but don't adopt. The blast radius of swapping out our slot management is large for marginal capability gains.

---

### 3. Mission Control (`builderz-labs/mission-control`)

**Source**: [github.com/builderz-labs/mission-control](https://github.com/builderz-labs/mission-control), [mc.builderz.dev](https://mc.builderz.dev/)
**Stack**: Next.js 16 + SQLite (better-sqlite3, WAL) + Zustand + WebSocket/SSE. 32 panels, 101 REST endpoints, 282 unit + 295 E2E tests. MIT, alpha.

**Model**: it's a **dashboard**, not an orchestrator. You install it, point your existing agents at it via REST/CLI, and it gives you Kanban + token cost + memory graph + skills hub + security audit. Framework adapters for OpenClaw / CrewAI / LangGraph / AutoGen / Claude SDK.

**Claude Code integration is read-only**: scans `~/.claude/projects/` for sessions, `~/.claude/tasks/` and `~/.claude/teams/` for tasks/configs, and surfaces them. It does not start/stop Claude sessions.

**Notable**: agent eval framework (output evals vs. golden datasets, trace evals for loop detection, drift detection vs. 4-week baseline). Security panel with secret detection + MCP call auditing + per-agent trust scoring 0–100.

**Fit for us**:
- ✅ The only tool of the 5 that focuses on *visibility* over *spawning*. Closest to the gap we actually have ("no live dashboard of all running agents").
- ✅ Skill registry security scanner could be useful given our `.claude/skills/` ecosystem.
- ❌ Yet-another-Next.js-app to deploy, secure, and maintain. We already run our own internal dashboards inside `apps/web/internal/*` — adding MC means a second auth surface, second deploy story, second update cadence.
- ❌ Framework adapter for Claude is **read-only**. To make MC actually drive our slots, we'd write a new adapter that proxies to `./ws dispatch` — at which point we've built a Mission-Control-shaped facade over our own infra.
- ⚠️ Alpha software. APIs and schemas may change between releases.

**Verdict**: skip. If we want a live agent dashboard, the right path is to add a `/internal/dispatch-fleet` page (Pattern A — see `.claude/rules/internal-dashboards.md`) that reads `agent_sessions` + `~/.cache/crux-dispatch/log.jsonl` + tmux state. ~1 day of work, integrated into our existing nav, no new auth.

---

### 4. ComposioHQ Agent Orchestrator (`@aoagents/ao`)

**Source**: [github.com/ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
**Stack**: Node 20+ + tmux + `gh` CLI + 7-slot plugin architecture (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal). MIT, npm-published, 3,288 test cases, 61 PRs merged.

**Model**: closest in spirit to our coordinator. `ao start` spawns an *orchestrator agent* that fans out per-issue worker agents into git worktrees. `agent-orchestrator.yaml` declares reactions:

```yaml
reactions:
  ci-failed:        { auto: true,  action: send-to-agent, retries: 2 }
  changes-requested:{ auto: true,  action: send-to-agent, escalateAfter: 30m }
  approved-and-green:{ auto: false, action: notify }
```

Worker → CI → fix → review → merge, with the operator pulled in only for human-judgment forks. Plugin slots make agent (Claude/Codex/Aider/Cursor/Opencode), runtime (tmux/process), tracker (GH/Linear/GitLab) all swappable.

**Fit for us**:
- ✅ The reaction-config model (CI-failed → re-dispatch with retries; changes-requested → send-to-agent with 30m escalation) is **directly the next thing we'd build** in `crux pr-patrol`. We already have the patrol loop and the health gate; we don't have the auto-fix loop.
- ✅ Linear tracker plugin already exists.
- ✅ Active development (61 PRs merged, npm-published).
- ❌ **Worktree-based** (same blocker as Overstory).
- ❌ Auto-merge reactions are dangerous for a wiki with 700+ pages and a 22-validator gate. Would need to disable or heavily audit before turning on.
- ❌ Replacing our slot+`crux sys dispatch` flow with `ao start` would require migrating `agent_sessions` dedup, `--force` audit logging, the slot-isolation enforcement, and the Linear-comment-as-claim mechanism. None of those are bolt-on — they live in our PG schema and our coordinator skills.
- ⚠️ Their orchestrator agent is itself a Claude session. Token cost amplification risk if the orchestrator + N workers all run on Opus.

**Verdict**: the **best engineered** of the 5 for our use case, but the migration cost is real. Read their `artifacts/architecture-design.md` and steal the `reactions:` config pattern for a future `crux pr-patrol --auto-fix` mode (Linear ticket worth filing). Don't adopt the tool itself.

---

### 5. `bassimeledath/dispatch` (Claude Code skill)

**Source**: [github.com/bassimeledath/dispatch](https://github.com/bassimeledath/dispatch), [bassimeledath.com/blog/dispatch](https://www.bassimeledath.com/blog/dispatch)
**Install**: `npx skills add bassimeledath/dispatch -g` (user-level) or no `-g` (project-level). MIT.

**Model**: a Claude Code **skill** that runs *inside* your active session. The dispatcher (your main Claude) writes a checklist, spawns a background worker via `claude --background` (or `cursor agent` / `codex exec` per the configured backend), and a monitor watches the worker's output. The worker has its own fresh full-context window. If the worker is stuck, it writes a question to an IPC dir; the monitor surfaces it; you answer; the worker continues without losing context.

**Configuration**: `~/.dispatch/config.yaml` with three sections — backends (CLI commands), models (alias → backend), aliases (named shortcuts with role prompts). Multi-model: `/dispatch use opus to review`, `/dispatch use gemini to refactor`.

**Fit for us**:
- ✅ **The only tool of the 5 that solves a real gap** — keeping the coordinator's *own* context lean while it dispatches. Today, every `./ws dispatch` call from a coordinator session bloats the coordinator with task description + status checks. Dispatch's checklist-handoff pattern matches what `crux sys agent-checklist` already produces — natural fit.
- ✅ Lightweight. Single skill, no daemon, no dashboard, no SQLite. Adds 1 directory to `.claude/skills/`.
- ✅ Multi-model is opportunistic — we could use Sonnet/Haiku for cheap parallel sweeps without taking on the full multi-runtime complexity of Overstory.
- ❌ **Recursive concern**: it spawns `claude --background` workers, which would themselves try to register in `agent_sessions`, post `crux linear start` comments, fight for slot dedup. Need to test how well it composes with our infra.
- ❌ Doesn't know about our slot system. Workers would land in the parent coordinator's CWD, not in an isolated slot — potentially modifying files on the coordinator's branch (or `main`, which would be blocked by our PreToolUse hook).
- ⚠️ User-level install (`-g`) is a global Claude Code config change. Project-level install requires every operator to opt in.

**Verdict**: **the only one worth a spike.** See follow-up below.

---

## Comparison matrix

| | Agent Teams | Overstory | Mission Control | ComposioHQ AO | bassimeledath/dispatch |
|---|---|---|---|---|---|
| **Maturity** | Experimental | Stable, part-time maint. | Alpha | Active (61 PRs) | Stable, single-author |
| **Install footprint** | env var | Bun + tmux + SQLite | Next.js + DB | npm global + tmux | 1 skill dir |
| **Isolation model** | shared CWD | git worktree | n/a (dashboard) | git worktree | shared CWD |
| **Solves cross-session dispatch?** | ❌ | ✅ | ❌ (read-only) | ✅ | ✅ (lightweight) |
| **Multi-runtime?** | Claude only | 11 runtimes | Adapters | Plugin | Backends config |
| **CI-failure auto-fix?** | ❌ | Via watchdog | ❌ | ✅ (reactions) | ❌ |
| **Live dashboard?** | tmux panes | `ov dashboard` TUI | Web SPA | Web at :3000 | ❌ |
| **Conflicts with our worktree-bug rule?** | n/a | ❌ blocks | n/a | ❌ blocks | ⚠️ shared CWD |
| **Conflicts with `agent_sessions` dedup?** | n/a | ⚠️ unaware | ⚠️ unaware | ⚠️ unaware | ⚠️ unaware |
| **Migration cost from current stack** | Low (additive) | High | High | High | Low (additive) |

---

## Spike notes

The brief asked for a real-dispatch spike "where feasible." None turned out to be feasible from inside this slot session without disrupting infra:

- **AO**: `npm install -g @aoagents/ao` + dashboard at port 3000 conflicts with `lw/main`'s dev server. Spawning a fleet would race against our own slot dedup.
- **Overstory**: `bun install` + `ov init` writes to `.overstory/` in the project root. Installing here would commit infra to the repo.
- **Mission Control**: full Next.js install + admin account setup. Hours of yak-shaving.
- **Agent Teams**: needs a fresh Claude session with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Can't enable mid-session.
- **bassimeledath/dispatch**: `npx skills add -g` is a global change to the user's Claude config. Should not be done unilaterally during a research-only session.

### Recommended follow-up spike (1 day, separate session)

Create slot a14 (or any idle slot) for an isolated `bassimeledath/dispatch` spike:

1. `./ws open 14 --claude` in a fresh tmux window.
2. `npx skills add bassimeledath/dispatch` (project-level — installs to `.claude/skills/dispatch/` only in that slot, not globally).
3. Add a project-level dispatch config that points workers at `claude -p` with our slot's `.env` and the `bypassPermissions` mode used by `./ws dispatch`.
4. Run a synthetic dispatch: "use sonnet to grep for `TODO` in `crux/` and write findings to `/tmp/sweep.md`." Confirm:
   - Worker spawns without polluting `agent_sessions` (it shouldn't run `crux sys agent-checklist init` because no Linear ticket).
   - Coordinator session size before/after — measure context savings.
   - Worker file writes land in the spike slot only, not in any other slot.
5. Try a real dispatch: pick a low-risk QUA-NNN, dispatch from coordinator using both `./ws dispatch` and `bassimeledath /dispatch`, compare:
   - Coordinator context bloat
   - Latency to first line of output
   - How well question-back-to-operator works vs. our current "operator polls `dispatch-status`" model

If it's a clear win, add a `crux sys dispatch --via=skill` mode that uses the skill instead of the bash worker, with a feature flag. If it composes badly with `agent_sessions`, document the rough edges and stay on `./ws dispatch`.

---

## What to do this week

1. **File a Linear ticket** for the `bassimeledath/dispatch` spike above (Coordinator & Agent Tooling project per `.claude/rules/linear-project-ownership.md`). Estimated 1 day.
2. **File a Linear ticket** for "add `/internal/dispatch-fleet` dashboard" — single-page Pattern A view of `agent_sessions` + dispatch runs + tmux state. ~1 day. (Closes the visibility gap without adopting Mission Control.)
3. **File a Linear ticket** for "investigate `crux pr-patrol --auto-fix`" — port AO's `reactions:` config pattern (CI-failed → re-dispatch with retries, changes-requested → send-to-agent with escalation timeout). ~3 days, gated on the spike showing dispatch is reliable enough to chain.
4. **Consider** enabling `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `coord/.claude/settings.json` only, for review/research-heavy releases. Not urgent. Not for slots — slots are single-purpose, in-process teams would compete with our slot model.

## Sources

- [Claude Code — Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams)
- [jayminwest/overstory](https://github.com/jayminwest/overstory) and [STEELMAN.md](https://github.com/jayminwest/overstory/blob/main/STEELMAN.md)
- [builderz-labs/mission-control](https://github.com/builderz-labs/mission-control)
- [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
- [bassimeledath/dispatch](https://github.com/bassimeledath/dispatch) and [10x Your Claude Code Window Size with Dispatch](https://www.bassimeledath.com/blog/dispatch)
- Local baseline: `lw/README.md`, `lw/a10/crux/commands/dispatch.ts`, `lw/a10/crux/commands/agent-workspace.ts`, `lw/a10/.claude/rules/worktree-isolation-bug.md`, `lw/a10/.claude/rules/dispatched-agent-review.md`
