# Kickoff

Initialize a session checklist and establish working context.

Run this at the start of a session, after understanding what the task is.

## Step 1: Generate the checklist

Run `pnpm crux session init` with the appropriate arguments:

- **If working on a GitHub issue**: `pnpm crux session init --issue=N` (auto-detects type from labels)
- **If not on an issue**: `pnpm crux session init "Task description" --type=X`

Valid types: `content`, `infrastructure`, `bugfix`, `refactor`, `commands`

If unsure about the type, `infrastructure` is the default.

## Step 2: Signal start on GitHub issue (if applicable)

If this session is working on a specific GitHub issue and `--issue` was used in step 1, also run:

```bash
pnpm crux issues start <ISSUE_NUM>
```

## Step 3: Present the checklist

Read `.claude/wip-checklist.md` and output it to the user. Highlight any items that seem particularly important or risky for this specific task.

Throughout the session, check items off in `.claude/wip-checklist.md` as they are completed. When it's time to ship, run `/finalize`.
