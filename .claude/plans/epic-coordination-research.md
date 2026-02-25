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

**Option 4: Linear for epics, GitHub for tasks (incremental)**
- Purpose-built agent API with sessions, assignment, progress
- New dependency outside GitHub
- Could be added later alongside GitHub-native approach
- See detailed analysis below

---

## Appendix: Linear Deep Dive

### Overview

Linear shipped "Linear for Agents" in May 2025 — a dedicated API that treats AI agents as first-class workspace members. Of all non-GitHub tools evaluated, Linear is the clear standout for agent coordination. This section documents what's actually there, what works, and where the gaps are.

### Agent Sessions — The Core Abstraction

An `AgentSession` tracks the lifecycle of a single agent run. Sessions are **created automatically** when an agent is @mentioned or assigned ("delegated") an issue. The agent doesn't manage session state manually — Linear infers it from emitted activities.

**Five session states:** `pending` → `active` → `complete` (or `error` / `awaitingInput`)

**Five activity types:**

| Type | Purpose | Content Fields |
|---|---|---|
| `thought` | Internal reasoning (shown as collapsible) | `{ type: "thought", body: string }` |
| `action` | Tool call (file read, search, etc.) | `{ type: "action", action: string, parameter: string, result?: string }` |
| `elicitation` | Question for the human | `{ type: "elicitation", body: string }` |
| `response` | Final output (marks session complete) | `{ type: "response", body: string }` |
| `error` | Something went wrong | `{ type: "error", body: string }` |

**Plan tracking:** Sessions have a `plan` field — an array of `{ content: string, status: "pending" | "inProgress" | "completed" | "canceled" }`. Must be replaced in full on each update. Linear renders this as a checklist in the UI.

**External URLs:** Sessions can link to external dashboards/PRs via `externalUrls: [{ label, url }]`. Setting this also prevents the session from being marked unresponsive.

**Timing constraints:**
- Webhook must return within **5 seconds**
- Agent must emit an activity or update external URL within **10 seconds** of session creation, or it's marked unresponsive
- This means you need a webhook receiver, not polling

### Authentication Model

**OAuth2 with `actor=app`** — creates a dedicated app identity in the workspace (not impersonating a user). The agent gets its own ID, name, and avatar.

Key scopes:
- `app:assignable` — agent appears in issue assignment menus
- `app:mentionable` — agent can be @mentioned
- `read`, `write`, `issues:create`, `comments:create` — standard CRUD
- **Cannot use `admin` scope** with `actor=app`

**Client credentials grant** available for server-to-server (no browser flow needed). Token valid for 30 days. Only one active client_credentials token per app.

**Token refresh:** Access tokens expire in 24 hours. Refresh token rotation is mandatory for apps created after Oct 1, 2025. Migration deadline: April 1, 2026.

### GitHub Integration

Linear has **native bidirectional GitHub sync** (launched Dec 2023):

| Feature | Direction | Details |
|---|---|---|
| PR linking | GitHub → Linear | Issue ID in branch name, PR title, or magic words auto-links |
| Status auto-update | GitHub → Linear | Draft PR → "In Progress", merged → "Done" (configurable per team) |
| Issues Sync | Bidirectional | Title, description, status, labels, assignee, comments all sync |
| Comment threads | Bidirectional | Reply to GitHub comments from Linear; private Linear threads stay private |

**Source of truth:** Not explicitly defined by Linear for conflicting edits. Both platforms can modify synced items.

**Gotcha:** Tagging existing issues with a sync label sometimes doesn't trigger sync — only newly created issues sync reliably.

### Sub-Issues

Linear supports parent-child issue relationships via `parentId` on `issueCreate`/`issueUpdate`. No explicit maximum nesting depth documented (unlike GitHub's 8 levels). Auto-close behavior: when all sub-issues complete, parent auto-closes (configurable per team).

### Rate Limits

| Auth Method | Requests/Hour | Complexity Points/Hour |
|---|---|---|
| API key | 5,000 | 250,000 |
| OAuth app (`actor=app`) | 500 (some sources say higher) | 2,000,000 |
| Unauthenticated | 60 | 10,000 |

**Per-user scoping:** API key limits are per-user. OAuth app limits are per user/app combination. If each agent is a separate OAuth app installation, they each get their own quota. For 5 concurrent agents with separate tokens, this would be 5 × 500 = 2,500 req/hr.

**Dynamic scaling:** OAuth apps get dynamically increased limits based on paid workspace size.

**Complexity formula:** Each property = 0.1 point, each object = 1 point, connections multiply by pagination arg (default 50). Max single query: 10,000 points.

### Agent Guidance

Two levels of instruction documents for agents:
- **Workspace-level:** Settings → Agents → Additional guidance (markdown)
- **Team-level:** Team settings → Agents → Additional guidance (overrides workspace)

Delivered via the `promptContext` field in webhook payloads, formatted as XML with `<guidance>` elements. Not queryable directly via API — only arrives through webhooks.

### MCP Server

Official remote server at `https://mcp.linear.app/mcp`. 21-22 tools including `list_issues`, `create_issue`, `update_issue`, `delete_issue`, project management, comments, teams, labels.

**Claude Code setup:**
```bash
claude mcp add --transport http linear https://mcp.linear.app/mcp
```

Uses OAuth 2.1 with dynamic client registration. After adding, run `/mcp` to authenticate.

### SDK

`@linear/sdk` v75.0.0 (Feb 2026). TypeScript, auto-generated from GraphQL schema, actively maintained. Node 18+.

```typescript
import { LinearClient } from "@linear/sdk";
const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });

// Create sub-issue
const result = await client.createIssue({
  title: "Implement auth middleware",
  teamId: "TEAM_UUID",
  parentId: "PARENT_ISSUE_UUID",
  assigneeId: "AGENT_UUID",
});

// Emit agent activity
await client.createAgentActivity({
  agentSessionId: "SESSION_UUID",
  content: { type: "thought", body: "Analyzing requirements..." },
});
```

### Pricing

| Plan | Cost | Issues | Teams | Agent API |
|---|---|---|---|---|
| Free | $0 | 250 active | 2 | Yes |
| Basic | $10/user/mo | Unlimited | 5 | Yes |
| Business | $16/user/mo | Unlimited | Unlimited | Yes |
| Enterprise | Custom | Unlimited | Unlimited | Yes + sub-initiatives |

Agents don't count as billable users. 75% off for nonprofits. No dedicated open-source program.

**The 250-issue cap on Free is the critical constraint** for this project. With ~700 wiki pages and active development, you'd exceed this unless aggressively archiving.

### Real-World Agent Integrations (Shipping Today)

**Cursor:** Assign a Linear issue to Cursor → agent reads context, creates branch, writes code, emits thoughts/actions, opens PR, updates Linear. Implementation took ~1 day using the SDK.

**Factory AI ("Droids"):** Delegate an issue → Factory provisions a remote workspace, launches a Droid with full context. Supports hundreds of concurrent Droids. Opens PRs linked to originating issues.

**Cyrus** (open-source, `github.com/ceedaragents/cyrus`): Monitors Linear/GitHub issues, creates isolated git worktrees, runs Claude Code, streams activity updates back to Linear agent sessions. Supports multiple AI backends (Claude, Cursor, Codex, Gemini).

### Limitations and Gotchas

1. **Developer Preview** — APIs are actively changing. `AgentSession.type` already deprecated.
2. **Delegation, not assignment** — agents are delegates; humans retain ownership.
3. **Admin-only install** — requires workspace admin to authorize OAuth app.
4. **10-second liveness requirement** — must emit activity within 10s of webhook or marked unresponsive. Requires always-on webhook receiver.
5. **Webhook-first architecture** — guidance/context only arrives via webhooks, not queryable. This is architecturally incompatible with Claude Code's session-based model (no persistent webhook receiver).
6. **No public visibility** — external contributors can't see Linear issues. Requires GitHub Issues Sync for community-facing work.
7. **250-issue cap on Free** — inadequate for active projects without aggressive archiving.
8. **MCP server reliability** — remote MCP connections still early, may need retries.
9. **Dual-system cognitive load** — teams report ~23% slower cycle times when PM lives outside the codebase (Zenhub research).

### Assessment for This Project

**What Linear does better than GitHub:**
- Agent sessions with plan tracking, activity timeline, and liveness monitoring
- Purpose-built UI showing agent progress alongside human work
- Native agent guidance (workspace-wide instruction documents)
- Richer project hierarchy (initiatives → projects → issues → sub-issues)
- Cycles (sprints) with automatic scheduling

**What doesn't fit this project:**
- **Webhook-first model** — Claude Code sessions are ephemeral. There's no persistent server to receive webhooks. The 10-second liveness requirement assumes an always-on agent service (like Cursor's cloud or Factory's Droids), not a CLI tool.
- **250-issue Free cap** — would need Basic ($10/user/mo minimum) for serious use.
- **No public visibility** — this is an open-source project; contributors need to see issues.
- **Dual-system overhead** — adding Linear on top of GitHub Issues + `crux` CLI introduces context switching for humans and sync complexity for automation.
- **Developer Preview risk** — building on APIs that may change before GA.

**If Linear were adopted, the most viable path:**
1. Use Linear Projects as the "epic" layer (replacing GitHub Discussions).
2. Keep GitHub Issues for individual tasks (preserve `crux issues start/done`).
3. Use Linear's GitHub Issues Sync to bidirectionally connect them.
4. Add `crux linear` commands alongside existing `crux issues`/`crux epic`.
5. This gives agent sessions + progress tracking from Linear while keeping community-facing work on GitHub.

**But this requires:** A webhook receiver (could be wiki-server), Basic plan ($10/user/mo), and maintaining two systems in sync. The benefit over the GitHub Sub-Issues + Discussions hybrid is primarily the agent session UI — which is nice but not essential for coordination.

---

## Updated Decision Matrix

| Option | Complexity | Cost | Agent Coordination | Human Visibility | Community Access | Requires Webhook Server |
|---|---|---|---|---|---|---|
| **1. Sub-Issues + Discussions** | Medium | Free | Good (manual) | Good | Full | No |
| **2. Sub-Issues Only** | Low | Free | Basic | Good | Full | No |
| **3. Discussions Only (current)** | Low | Free | Weak | Good | Full | No |
| **4. Linear for Epics** | High | $10+/user/mo | Excellent | Excellent | Requires sync | Yes |
| **5. Linear Full** | Very High | $10+/user/mo | Excellent | Excellent | Requires sync | Yes |

### Bottom Line

Linear's agent API is genuinely impressive — it's the best-designed agent coordination system available today. But for this project, the **architectural mismatch** (webhook-first vs. ephemeral CLI sessions) and **operational overhead** (paid plan, dual-system sync, webhook server) outweigh the benefits. The GitHub Sub-Issues + Discussions hybrid covers the core needs (task decomposition, progress tracking, coordination documents) at zero cost with zero new infrastructure.

Linear becomes compelling if/when:
- The project runs persistent agent services (not just CLI sessions)
- The team grows beyond solo/small where Linear's PM features add value
- The 250-issue Free cap is addressed or a paid plan is justified
- Linear's agent API reaches GA with stable contracts
