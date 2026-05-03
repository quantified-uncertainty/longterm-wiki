---
name: "source-command-update-discussion"
description: "Post a status update on a GitHub Discussion — cross-reference its issues, PRs, and questions against current state."
---

# source-command-update-discussion

Use this skill when the user asks to run the migrated source command `update-discussion`.

## Command Template

# Update Discussion — Status Report

Post a status update comment on a GitHub Discussion by checking the current state of all referenced issues, PRs, and open questions against the codebase and GitHub.

## Step 1: Load the discussion

```bash
pnpm crux gh epic view <N>
```

Read the full discussion body and all comments. Extract:
- **Referenced issues** (e.g., `#3667`, `#3609`) — collect all `#NNNN` references
- **Referenced PRs** — any PRs mentioned in discussion body or comments
- **Open questions** — numbered questions, decision points, or unresolved items
- **Last status update** — the most recent comment with progress data (coverage tables, session results, etc.)

## Step 2: Check current state

Run these in parallel:

**Issue status** — for each referenced issue:
```bash
gh issue view <N> -R quantified-uncertainty/longterm-wiki --json number,title,state,labels --jq '{number, title, state, labels: [.labels[].name]}'
```

**Recent related PRs** — search for PRs merged since the last status update that touch related code:
```bash
gh pr list -R quantified-uncertainty/longterm-wiki --state merged --limit 50 --json number,title,mergedAt,headRefName
```

Filter these to PRs relevant to the discussion topic. Use keyword matching against the discussion title and referenced issues.

**Code state** — if the discussion references specific metrics, coverage numbers, or feature flags, check the current codebase to see if they've changed.

## Step 3: Compose the status update

Structure the comment as:

```markdown
## Status Update (YYYY-MM-DD)

### PRs merged since last update

Group by category:
- **Direct improvements:** PRs that directly advance the discussion goals
- **Supporting fixes:** Bug fixes, display improvements, infrastructure that supports the goals

### Issue tracker

| Issue | Status | Notes |
|-------|--------|-------|
| #NNNN | **Closed** / Open | Brief note on current state |

### Assessment

- Which original questions now have answers (or partial answers)?
- What changed since the last update?
- What are the next priorities?
```

Guidelines:
- **Be concrete** — cite PR numbers, not vague summaries
- **Answer the original questions** — if the discussion poses numbered questions, explicitly address which ones now have answers
- **Highlight surprises** — anything that went better or worse than expected
- **Keep it scannable** — tables for issue status, bullet points for assessment

## Step 4: Post the comment

```bash
# Get the discussion node ID
DISC_ID=$(gh api graphql -f query='
{
  repository(owner: "quantified-uncertainty", name: "longterm-wiki") {
    discussion(number: <N>) { id }
  }
}' --jq '.data.repository.discussion.id')

# Write comment body to temp file
cat >| /tmp/disc-update.md <<'COMMENT'
<your composed comment>
COMMENT

# Post it
BODY=$(cat /tmp/disc-update.md | jq -Rs .)
gh api graphql -f query="
mutation {
  addDiscussionComment(input: {
    discussionId: \"$DISC_ID\",
    body: $BODY
  }) {
    comment { url }
  }
}"
```

## Step 5: Update agent metadata (if present)

If the discussion body has an `<!-- agent-project -->` metadata block, update `last_agent_session` to today's date and adjust `phases_done` if applicable.

**If `phases_done == phases_total` (or `status: done`) after your update, close the discussion.** Open discussions with all phases done accumulate as ambient noise that future cleanup sweeps have to triage. Run:

```bash
pnpm crux gh epic comment <N> "All phases complete. Closing per status update."
pnpm crux gh epic close <N>
```

## What this is NOT

- This is not `/work-on-discussion` — you are **reporting**, not implementing
- Don't start fixing issues or writing code during a status update
- If you notice something urgent while reviewing, file it as an issue or note it in the comment, but don't switch to implementation mode
