# Agent Session Start

Initialize an agent checklist and establish working context.

Run this at the start of a session, after understanding what the task is.

## Step 1: Generate the checklist

Run `pnpm crux agent-checklist init` with the appropriate arguments:

- **If working on a GitHub issue**: `pnpm crux agent-checklist init --issue=N` (auto-detects type from labels)
- **If not on an issue**: `pnpm crux agent-checklist init "Task description" --type=X`

Valid types: `content`, `infrastructure`, `bugfix`, `refactor`, `commands`

If unsure about the type, `infrastructure` is the default.

## Step 2: Signal start on GitHub issue (if applicable)

If this session is working on a specific GitHub issue and `--issue` was used in step 1, also run:

```bash
pnpm crux issues start <ISSUE_NUM>
```

## Step 3: Assemble research context (optional but recommended)

For content sessions (editing a page or working with an entity), gather context upfront to avoid 5-15 separate file reads:

```bash
# Context for a specific page you'll be editing:
pnpm crux context for-page <page-id>

# Context for a GitHub issue (finds related pages/entities automatically):
pnpm crux context for-issue <N>

# Context for an entity:
pnpm crux context for-entity <entity-id>

# Context for a free-text topic:
pnpm crux context for-topic "topic description"
```

Output is saved to `.claude/wip-context.md`. Read it once — it contains page metadata, related pages, backlinks, citation health, entity YAML, and frontmatter.

## Step 4: Present the checklist

Read `.claude/wip-checklist.md` and output it to the user. Highlight any items that seem particularly important or risky for this specific task.

Throughout the session, check items off in `.claude/wip-checklist.md` as they are completed. When it's time to ship, run `/agent-session-ready-PR`.
