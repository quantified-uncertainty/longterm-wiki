# /deploy — Production Deploy Orchestrator

Orchestrates a production deploy via a release PR. Collects deploy tasks from all included PRs, monitors deployment, and verifies post-deploy tasks.

**Usage**: `/deploy` (when a release PR exists) or `/deploy <PR-number>`

## Step 0: Identify the release PR

If a PR number was provided, use it. Otherwise, find the open release PR:
```bash
gh pr list --base production --head main --state open --json number,title,url
```

If no release PR exists, ask the user if they want to create one:
```bash
pnpm crux gh release create
```

## Step 1: Collect deploy tasks from included PRs

Run the deploy task collector to find all tasks from PRs included in this release:

```bash
pnpm crux gh deploy-tasks pending --days=30
```

Also scan the release PR commit range for any untracked deploy-relevant changes:
```bash
pnpm crux gh deploy-tasks detect --base=origin/production
```

Present a unified summary:
- Total PRs included in this release
- PRs with deploy tasks (and the tasks)
- PRs with no deploy tasks
- Any tasks detected from the diff that weren't in PR descriptions

## Step 2: Pre-merge verification

Before the human merges:
1. Verify all CI checks pass on the release PR: `pnpm crux gh ci status --pr=<N>`
2. Execute any `pre-merge` phase tasks (e.g., verify env vars are set)
3. Check for production branch divergence (hotfixes not on main)
4. Report blockers and warnings

**IMPORTANT**: Do NOT auto-merge the release PR. Present the summary and ask the user to merge manually. The merge button is a human checkpoint.

## Step 3: Monitor deployment (after human merges)

After the user confirms they've merged:

1. **Wiki-server deploy**: Monitor the `wiki-server-docker.yml` workflow
   ```bash
   pnpm crux gh ci status --wait --workflow=wiki-server-docker.yml
   ```

2. **Vercel deploy**: Monitor the CI pipeline's deploy trigger
   ```bash
   pnpm crux gh ci status --wait
   ```

3. **E2E smoke tests**: Wait for `e2e-post-deploy.yml` to pass
   ```bash
   gh run list --workflow=e2e-post-deploy.yml --limit=1 --json status,conclusion
   ```

4. Report deployment status: both wiki-server and Vercel

## Step 4: Execute post-deploy verifications

For each `post-deploy` phase task:

1. **Automated tasks**: Run the verification command and report pass/fail
2. **Manual tasks**: Present to the user and ask for confirmation
3. Mark completed tasks by updating the original PR description via:
   ```bash
   pnpm crux gh deploy-tasks inject --pr=<N>
   ```

## Step 5: Report

Post a summary comment on the release PR:
- Deploy status (success/partial/failed)
- Tasks verified (N/M completed)
- Any manual tasks still pending
- Link to wiki-server health: check `pnpm crux sys health check`

## Error handling

- If deployment fails (ArgoCD rollback triggered), stop task execution and alert
- If a verification fails, log it but continue with other tasks
- If GitHub API calls fail, retry once then log and continue
- Never auto-rollback — report the issue and let the human decide

## Post-deploy audit

If any tasks required manual verification or had warnings, add entries to `.claude/audits.yaml`:
```bash
pnpm crux sys audits check <id> --pass --notes="Verified during deploy"
```
