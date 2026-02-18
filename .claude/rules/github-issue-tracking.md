# GitHub Issue Tracking — MANDATORY

When a Claude Code session is assigned to work on a specific GitHub issue, it MUST signal its activity on that issue so humans can track progress and avoid duplicate work.

## At Session Start

When the task description references a GitHub issue number (e.g., "resolve issue #239", "fix #239", "work on https://github.com/.../issues/239"), do the following **before writing any code**:

### 1. Post a start comment on the issue

```bash
ISSUE_NUM=239   # replace with actual number
BRANCH=$(git branch --show-current)
curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/issues/${ISSUE_NUM}/comments" \
  -d "{\"body\": \"🤖 Claude Code starting work on this issue (branch: \`${BRANCH}\`).\n\nSee branch for progress. This comment will be updated when work is complete.\"}"
```

### 2. Add the `claude-working` label

```bash
curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/issues/${ISSUE_NUM}/labels" \
  -d '{"labels": ["claude-working"]}'
```

If the label doesn't exist yet, create it first:

```bash
curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/labels" \
  -d '{"name": "claude-working", "color": "0075ca", "description": "Claude Code is actively working on this"}'
```

**Or use the crux CLI (simpler):**

```bash
pnpm crux issues start <ISSUE_NUM>
```

## At Session End (when shipping)

After the work is committed and pushed (via `/push-and-ensure-green`), post a completion comment and remove the `claude-working` label:

```bash
PR_URL="<url of the PR>"
ISSUE_NUM=239

# Post completion comment
curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/issues/${ISSUE_NUM}/comments" \
  -d "{\"body\": \"🤖 Claude Code has finished working on this. Changes are in ${PR_URL} — please review and merge.\"}"

# Remove claude-working label
curl -s -X DELETE \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/issues/${ISSUE_NUM}/labels/claude-working"
```

**Or use the crux CLI:**

```bash
pnpm crux issues done <ISSUE_NUM> --pr=<PR_URL>
```

## Why This Matters

- Humans can see at a glance which issues are being handled
- Prevents multiple sessions picking up the same issue simultaneously
- The `claude-working` label enables filtering in the GitHub issues list
- Creates a paper trail connecting branches/PRs to the originating issue

## Edge Cases

- If `GITHUB_TOKEN` is not set, skip the API calls and note this in the session log
- If the issue number cannot be determined from the task description, skip this workflow
- The `/next-issue` command handles start tracking automatically — no need to do it manually when using that workflow
