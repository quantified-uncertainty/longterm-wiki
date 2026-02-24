# Epic Coordination for Multi-Agent Workflows — Research Synthesis

**Date:** 2026-02-24
**Status:** Research complete, awaiting decision on approach
**Branch:** `claude/github-wiki-epic-tracking-BR22I`

## Problem

Multiple Claude Code agents work on related issues. Today there is no way to:
- Group issues into a parent "epic" with progress tracking
- Give agents a shared coordination document (plan, decisions, blockers)
- Prevent duplicate claims on the same task
- Show humans a single view of an epic's status

## Research Conducted

Five mechanisms were evaluated across four parallel research threads:

1. **GitHub Sub-Issues** (REST + GraphQL API)
2. **GitHub Discussions** (GraphQL-only API)
3. **GitHub Gists** (REST API)
4. **GitHub Issues** (existing `crux issues` infrastructure)
5. **Non-GitHub tools** (Linear, Discord, Notion, Redis, LangGraph, etc.)

---

## Option Comparison

### A. GitHub Sub-Issues (Parent Issue with Children)

**How it works:** Create a regular Issue labeled `epic`. Add child issues via REST API. GitHub automatically tracks progress.

**API:**
```bash
# Add child issue to parent
CHILD_ID=$(gh api /repos/OWNER/REPO/issues/42 --jq .id)   # database id, NOT number
gh api /repos/OWNER/REPO/issues/10/sub_issues -F sub_issue_id=$CHILD_ID

# Progress (GraphQL only, requires feature flag header)
gh api graphql -H "GraphQL-Features: sub_issues" \
  -f query='query { node(id: "PARENT_NODE_ID") { ... on Issue { subIssuesSummary { total completed percentCompleted } } } }'
```

| Strength | Weakness |
|---|---|
| Native GitHub feature, GA since March 2025 | No native `gh issue` CLI support yet |
| 100 sub-issues/parent, 8 nesting levels | `sub_issue_id` uses database ID, not issue number (confusing) |
| Automatic progress tracking | Progress only via GraphQL with feature flag header |
| Assignees, labels, PR auto-close all work | Single parent per issue |
| Project board integration | No coordination document (plan, decisions) |
| Builds on existing `crux issues` infrastructure | No concurrency control for claiming tasks |

**Verdict:** Best for **task decomposition and progress tracking**. Weak for **coordination artifacts** (shared plans, decision logs).

### B. GitHub Discussions (Living Document + Threaded Comments)

**How it works:** Create a Discussion in an "Epics" category. Body is the plan (editable). Comments are the activity timeline. Link to Issues for actual tasks.

**API:** GraphQL only (no REST). Already implemented in `crux/commands/epic.ts`.

| Strength | Weakness |
|---|---|
| Body is semantically "the document" — perfect for living plans | GraphQL-only, verbose |
| Two-level threading groups agent sessions naturally | No assignees |
| Categories separate epics, Q&A, decisions | No project board integration |
| Q&A format with marked answers for blockers | No PR auto-close (`Closes #N`) |
| Up to 4 global + 4 per-category pins | No `gh` CLI commands |
| Polls for async decision-making | Issue linking is manual (body parsing) |

**Verdict:** Best for **coordination artifacts** (plans, decisions, Q&A). Weak for **task tracking** (no assignees, no progress).

### C. GitHub Gists (Structured Data Store)

**How it works:** A secret Gist holds machine-readable coordination state (JSON/YAML). Multi-file: `state.json`, `decisions.yaml`, `progress.md`. Agents read/write via REST API.

| Strength | Weakness |
|---|---|
| Clean structured data (JSON/YAML, no markdown wrapping) | Not linked to the repo |
| Multi-file per gist | Owner-only writes (all agents = same token) |
| Full version history with SHA-addressable revisions | No labels, assignees, milestones |
| File-per-agent pattern avoids write conflicts | No webhooks |
| `gh gist` CLI for most operations | No notifications or @mentions |
| Atomic multi-file updates via single PATCH | No concurrency control (last write wins) |

**Verdict:** Best for **machine-readable shared state**. Weak for **human visibility** and **discoverability**.

### D. Plain GitHub Issues (Current System)

**How it works:** Continue using `crux issues` with labels and body conventions. Add `epic` label. Track sub-tasks via markdown checklists in body.

| Strength | Weakness |
|---|---|
| Already implemented and working | No native parent/child hierarchy |
| Full ecosystem integration | Body-parsing for task lists is fragile |
| Humans know how to use Issues | No automatic progress tracking |
| `gh issue` CLI works out of the box | No coordination document semantics |

**Verdict:** Adequate but doesn't scale to multi-agent coordination.

### E. Non-GitHub Tools

| Tool | Best For | Key Limitation for This Project |
|---|---|---|
| **Linear** | Agent-first PM (dedicated agent API, agent sessions, Cursor/Factory AI integration) | New dependency, data lives outside GitHub |
| **Discord/Slack** | Human-agent visibility, status broadcasting | Not a coordination backbone, no structured storage |
| **Notion** | Rich structured data (20+ property types) | 3 req/s rate limit is crippling for multi-agent |
| **Redis** | Sub-millisecond shared state, message queuing, distributed locks | New infrastructure, no human UI out of the box |
| **LangGraph** | Best-in-class state management (checkpoints, rollback, reducers) | Framework-level, not a lightweight add-on |
| **Supabase/Firebase** | Durable storage with real-time subscriptions | Already have PostgreSQL via wiki-server |
| **CrewAI/AutoGen** | Multi-agent orchestration frameworks | Would replace, not augment, current architecture |

**Verdict:** Linear is the standout PM tool, but adds a dependency outside GitHub. Redis/Supabase would be good infrastructure but the project already has PostgreSQL. For this project, staying within GitHub is lower-friction.

---

## Recommended Approach: Sub-Issues + Discussions Hybrid

Use **both** mechanisms for their respective strengths:

### Layer 1: Sub-Issues for Task Decomposition (primary)
- Parent Issue = the epic (labeled `epic`, pinned)
- Child Issues = individual tasks agents claim and complete
- Automatic progress tracking via `subIssuesSummary`
- Full issue ecosystem: assignees, labels, PR auto-close, project boards

### Layer 2: Discussions for Coordination Artifacts (secondary)
- One Discussion per epic for the "living plan document"
- Body = current plan, task breakdown rationale, architecture decisions
- Comments = agent activity timeline (session starts, blockers, decisions)
- Q&A format for blocker resolution
- Cross-referenced from the parent Issue body

### Workflow

```
1. Create epic Issue:       crux epic create "Auth Overhaul" --pin
   → Creates Issue #100 with `epic` label
   → Creates linked Discussion with plan template
   → Adds "Plan: [Discussion #42](url)" to issue body

2. Add tasks:               crux epic add-task 100 --title "Implement OAuth"
   → Creates Issue #101
   → Adds #101 as sub-issue of #100

3. Agent claims task:       crux issues start 101
   → (existing workflow, adds claude-working label)

4. Agent posts update:      crux epic comment 100 "Starting OAuth implementation"
   → Posts to the linked Discussion (not the Issue)

5. Agent completes task:    crux issues done 101 --pr=URL
   → PR closes #101, parent #100 auto-updates progress

6. Check progress:          crux epic status 100
   → Shows: ████████░░░░ 67% (2/3 done)
   → Lists open/closed sub-issues
```

### Why This Hybrid

| Need | Mechanism |
|---|---|
| "What tasks are in this epic?" | Sub-issues on parent Issue |
| "How much is done?" | `subIssuesSummary` (automatic) |
| "Who's working on what?" | Issue assignees + `claude-working` label |
| "Close task when PR merges" | `Closes #N` (native) |
| "What's the plan?" | Discussion body (living document) |
| "What decisions were made?" | Discussion comments (threaded) |
| "Agent hit a blocker" | Discussion Q&A comment → marked answer |
| "Show me the Kanban board" | GitHub Projects (Issues only) |

### Alternative: Sub-Issues Only (Simpler)

If the coordination document aspect isn't needed yet, skip Discussions entirely and just use Sub-Issues. The plan goes in the parent Issue body (which is also editable). This is simpler but loses threaded discussion and Q&A semantics.

---

## Implementation Delta from Current State

### Already built (this branch):
- `githubGraphQL()` in `crux/lib/github.ts` — needed for both sub-issues and discussions
- `getRepoNodeId()` — needed for discussion creation
- `crux/commands/epic.ts` — Discussion-based epic commands (11 commands)
- Registered in `crux.mjs`, documented in `CLAUDE.md`

### Needs to be added for the hybrid:
1. **Sub-issue commands** in `crux/commands/epic.ts`:
   - `add-task` — create issue + add as sub-issue
   - `remove-task` — remove sub-issue link
   - `status` — query `subIssuesSummary` via GraphQL (replace current body-parsing approach)
2. **`create` rework** — create both Issue (parent) and Discussion (coordination doc), cross-link them
3. **ID resolution helper** — convert issue number → database ID (the `sub_issue_id` gotcha)

### Needs to be removed/changed:
- Current `link`/`unlink` commands parse the Discussion body for task lists → replace with real sub-issue API
- Current `status` command fetches linked issues individually → replace with `subIssuesSummary`
- Current `extractLinkedIssues()` body parsing → no longer needed

---

## Decision Needed

**Option 1: Hybrid (Sub-Issues + Discussions)**
- Most capable, covers both task tracking and coordination
- More complex, two GitHub features to maintain

**Option 2: Sub-Issues Only**
- Simpler, everything is an Issue
- Plan goes in parent Issue body
- Loses threaded coordination, Q&A, polls

**Option 3: Keep Discussion-Only (current implementation)**
- Already built and pushed
- Weakest for actual task tracking (no assignees, no PR auto-close)
- Would need manual progress tracking

**Option 4: Wait for Linear integration**
- Purpose-built agent API with sessions, assignment, progress
- New dependency outside GitHub
- Could be added later alongside GitHub-native approach
