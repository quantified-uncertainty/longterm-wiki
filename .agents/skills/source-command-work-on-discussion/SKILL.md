---
name: "source-command-work-on-discussion"
description: "Bind to a GitHub Discussion and work through it as a sustained project session."
---

# source-command-work-on-discussion

Use this skill when the user asks to run the migrated source command `work-on-discussion`.

## Command Template

# Work on Discussion — Sustained Project Session

Bind this agent session to a GitHub Discussion and work through its plan systematically. The discussion is your anchor — stay on it until you finish a meaningful chunk or hit a blocker.

This replaces the "pick next issue → do it → reset" pattern with "pick a project → build deep context → make real progress."

## Step 1: Load the discussion

```bash
pnpm crux gh epic view <N>
```

Read the full discussion body and comments. Understand:
- What is the **goal**?
- What **phases/steps** are described?
- What has **already been done** (check comments, linked issues, codebase)?

## Step 2: Check for agent metadata

Look for an HTML comment block at the top of the discussion body:

```html
<!-- agent-project
priority: high | medium | low
status: not-started | in-progress | blocked | done
phases_total: N
phases_done: N
last_agent_session: YYYY-MM-DD
blocker: (optional free text)
-->
```

If it doesn't exist, that's fine — you'll add it at the end.

## Step 3: Determine the next action

Read the discussion plan and figure out what the **next concrete step** is. This requires judgment:

1. **Scan the phases/plan** in the discussion body
2. **Check what's already implemented** — read code, check git log, look for related PRs
3. **Identify the first unfinished phase** that isn't blocked
4. If the discussion doesn't have clear phases, write a plan as a comment and ask for confirmation

The next action should be something you can **implement and ship in this session**. If a phase is too large, break it into a sub-step you can complete.

## Step 4: Create a branch and init

```bash
git checkout -b Codex/disc-<N>-<short-description>
pnpm crux sys agent-checklist init "Discussion #<N>: <phase description>" --type=infrastructure
```

Post a comment on the discussion signaling you're starting:

```bash
pnpm crux gh epic comment <N> "Starting work on Phase X: <description>. Branch: Codex/disc-<N>-..."
```

## Step 5: Implement

Work through the current phase. As you go:

- **Stay focused on this discussion's scope** — don't get pulled into tangential fixes
- **If you discover something broken**, file an issue and note it, but keep working on the discussion
- **If you need a human decision**, post a comment on the discussion explaining the tradeoff and what you'd recommend. Then move to the next phase you CAN do, or stop.
- **If a phase turns out to be already done**, note it and move to the next one

## Step 6: Ship and update

When you've completed a meaningful chunk:

1. **Ship the PR** with `/agent-ship` — reference the discussion in the PR body:
   ```
   Ref: Discussion #NNNN (Phase X)
   ```

2. **Post a progress comment** on the discussion:
   ```bash
   pnpm crux gh epic comment <N> "Completed Phase X: <what was done>. PR: #YYYY. Next: Phase X+1 (<description>)."
   ```

3. **Update the agent metadata** in the discussion body. Use `pnpm crux gh epic update <N>` to edit the body, adding or updating the HTML comment block:
   ```html
   <!-- agent-project
   priority: medium
   status: in-progress
   phases_total: 5
   phases_done: 3
   last_agent_session: 2026-04-03
   -->
   ```

4. **If there's more to do and you have capacity**, continue to the next phase in the same session. Don't reset — your context is valuable.

5. **If you're done or blocked**, update status to `done` or `blocked` with a blocker description.

6. **Auto-close when complete.** If after this session `phases_done == phases_total` (or `status: done`), close the discussion explicitly. Open discussions with all phases done accumulate as ambient noise that future sweeps have to clean up. Run:
   ```bash
   pnpm crux gh epic comment <N> "All phases complete. Closing — see PR #YYYY for the final shipping piece."
   pnpm crux gh epic close <N>
   ```
   Use `--reason=outdated` only if the plan was abandoned rather than completed; default `resolved` is correct for "all phases shipped". This is a hard rule, not a judgment call: if `phases_done == phases_total`, close.

## Step 7: Continue or hand off

If the session ends mid-discussion:
- The discussion comment trail shows exactly where you stopped
- The metadata block shows phases_done vs phases_total
- The next agent session picks up where you left off by reading the discussion + comments

## How this differs from /agent-next-issue

| | /agent-next-issue | /work-on-discussion |
|---|---|---|
| **Scope** | One atomic issue | Multi-phase project |
| **Context** | Rebuilt each session | Compounds within session |
| **Duration** | 15-60 min | Hours |
| **Output** | One PR per issue | One or more PRs per session |
| **Tracking** | Issue labels | Discussion comments + metadata |
| **Issues** | Pre-existing | Created as needed during work |

## Picking which discussion to work on

If no discussion number was provided, pick one by checking:

1. **Discussions with `status: in-progress`** — continue unfinished work first
2. **Discussions with `priority: high`** — highest priority unstarted work
3. **Discussions with the most phases remaining** — biggest bang for a session
4. **Most recently active discussions** — momentum matters

You can scan for the metadata block:
```bash
# List discussions and check for agent-project metadata
pnpm crux gh epic list
```

Then read the top candidates and pick the one where you can make the most progress.
