# Kickoff

Initialize a session checklist and establish working context.

Run this at the start of a session, after understanding what the task is.

## Step 1: Create the session checklist

Copy `.claude/checklist-template.md` to `.claude/wip-checklist.md`, filling in:
- `{TIMESTAMP}` with the current date/time
- `{BRANCH}` with the current git branch name
- `{TASK_DESCRIPTION}` with a 1-sentence summary of what this session will do

## Step 2: Customize the checklist

Review the checklist and remove items that don't apply to this session:

- **If no MDX files will be changed**: Remove the EntityLinks, numeric ID stability, MDX escaping, and content accuracy items.
- **If no `crux/` files will be changed**: Remove the crux TypeScript item.
- **If no entity YAML will be changed**: Remove the numeric ID stability item.
- **If no new pages/dashboards**: Remove the "New pages/dashboards" PR description item.
- **If not working on a GitHub issue**: Remove the "Originating issue updated" item.

Add any task-specific items. For example:
- If adding a new CLI command: "Command registered in `crux/crux.mjs` and `--help` works"
- If adding a new data field: "Field processed by `build-data.mjs` and included in database schema"
- If modifying a build script: "Build produces identical output to before for unchanged inputs"

## Step 3: Signal start on GitHub issue (if applicable)

If this session is working on a specific GitHub issue:

```bash
pnpm crux issues start <ISSUE_NUM>
```

## Step 4: Present the checklist

Output the customized checklist to the user so they can see what the session will need to accomplish. Highlight any items that seem particularly important or risky for this specific task.

Throughout the session, check items off in `.claude/wip-checklist.md` as they are completed. When it's time to ship, run `/finalize`.
