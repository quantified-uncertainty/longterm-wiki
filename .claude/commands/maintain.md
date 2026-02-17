# Maintenance Sweep

Run a prioritized maintenance session: review recent PRs, analyze session logs, triage GitHub issues, detect codebase cruft, and take action.

## Overview

This command orchestrates a maintenance sweep across the project. It gathers signals from multiple sources, prioritizes them, then works through fixes and updates. Run this periodically (e.g. daily or after a batch of PRs merge).

## Phase 1: Gather Signals

Collect maintenance signals from all sources. Run these in parallel where possible.

### 1a. Recent PR & Session Log Review

Review PRs merged since the last maintenance sweep.

1. Check for a timestamp file at `.claude/maintain-last-run.txt`. If it exists, use that date. Otherwise default to 7 days ago.
2. Fetch merged PRs since that date:
   ```bash
   SINCE=$(cat .claude/maintain-last-run.txt 2>/dev/null || date -d '7 days ago' +%Y-%m-%d)
   curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/pulls?state=closed&sort=updated&direction=desc&per_page=50" \
     | python3 -c "
   import json, sys
   prs = json.load(sys.stdin)
   since = '$SINCE'
   for p in prs:
       if p.get('merged_at') and p['merged_at'][:10] >= since:
           print(f\"#{p['number']}: {p['title']} (merged: {p['merged_at'][:10]}) [{p['head']['ref']}]\")
   "
   ```
3. For each merged PR, read the corresponding session log in `.claude/sessions/`. The session log filename maps from the branch name (e.g. `claude/fix-bug-Abc12` → `2026-02-17_fix-bug-Abc12.md`).
4. Extract from each session log:
   - **Issues encountered** — problems that may recur or need follow-up
   - **Learnings/notes** — patterns to propagate into rules or common-issues
   - **Pages edited** — to check if those pages need follow-up fixes
5. Compile a summary of:
   - Recurring issues across sessions (same error in 2+ logs)
   - Learnings that should be added to `.claude/common-issues.md` or `.claude/rules/`
   - Pages that were edited by multiple PRs (potential conflicts or inconsistencies)
   - Any session that mentioned pipeline failures or workarounds

### 1b. GitHub Issue Triage

Review all open issues for staleness and relevance.

1. Fetch all open issues:
   ```bash
   curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/issues?state=open&per_page=100&sort=updated&direction=desc" \
     | python3 -c "
   import json, sys
   issues = json.load(sys.stdin)
   for i in issues:
       if 'pull_request' not in i:
           labels = ', '.join(l['name'] for l in i.get('labels', []))
           days_old = '?'
           print(f\"#{i['number']}: {i['title']} [{labels}] (updated: {i['updated_at'][:10]}, created: {i['created_at'][:10]})\")
   "
   ```
2. For each issue, assess:
   - **Was it addressed by a recent PR?** Cross-reference issue titles/numbers with merged PR titles and session log contents. If an issue was fixed, comment and close it.
   - **Is it stale?** If no activity in 30+ days and no clear next step, consider closing with a note.
   - **Is it actionable now?** Could it be fixed in this maintenance session?
   - **Is it still relevant?** Has the codebase changed enough that the issue no longer applies?
3. Categorize each issue as: `close` (resolved/stale/irrelevant), `actionable` (can fix now), `keep` (still valid, not actionable now), or `update` (needs a comment with current status).

### 1c. Codebase Cruft Detection

Look for common sources of technical debt.

1. **Dead code**: Check for unused exports, unreferenced files, commented-out code blocks.
   ```bash
   # Files in crux/ not imported anywhere
   for f in $(find crux/ -name '*.ts' -not -name '*.test.*' -not -name '*.d.ts'); do
     basename=$(basename "$f" .ts)
     refs=$(grep -r "$basename" crux/ app/ --include='*.ts' --include='*.mjs' --include='*.tsx' -l | grep -v "$f" | wc -l)
     if [ "$refs" -eq 0 ]; then echo "ORPHAN: $f"; fi
   done
   ```
2. **Stale TODO/FIXME/HACK comments**: Find and assess which are still relevant.
   ```bash
   grep -rn 'TODO\|FIXME\|HACK\|XXX' crux/ app/src/ --include='*.ts' --include='*.tsx' --include='*.mjs'
   ```
3. **Stale session logs**: Session logs older than 30 days that reference branches already merged — these are historical and fine to keep, but check if any mention unresolved issues.
4. **Duplicate or near-duplicate utilities**: Look for functions doing similar things in different files.
5. **Large files**: Files over 500 lines that might benefit from splitting.
   ```bash
   find crux/ app/src/ -name '*.ts' -o -name '*.tsx' | xargs wc -l | sort -rn | head -20
   ```

### 1d. Page Quality Check

Quick health check on wiki content.

1. Run `pnpm crux updates list --overdue --limit=5` to see most overdue pages.
2. Run `pnpm crux validate` to see current validation status.
3. Note any pages with quality scores below 50.

## Phase 2: Prioritize

Build a ranked work list from Phase 1 signals. Priority order:

1. **P0 — Broken things**: CI failures, blocking validation errors, broken imports/exports
2. **P1 — Close resolved issues**: Issues that were fixed by recent PRs but not yet closed. This is quick and high-value.
3. **P2 — Propagate learnings**: Add recurring issues from session logs to `.claude/common-issues.md`. Update rules files if patterns are clear.
4. **P3 — Actionable issues**: GitHub issues that can be fixed now, prioritized by label (`enhancement` > unlabeled) and age.
5. **P4 — Cruft cleanup**: Dead code removal, TODO resolution, file splitting. Only if the other categories are clear.
6. **P5 — Page updates**: Delegate to `pnpm crux updates run` for content freshness.

Present the prioritized list to the user and ask which categories to work on. Default to P0-P2 (always do these) and ask about P3-P5.

## Phase 3: Execute

Work through the prioritized list:

1. **For each issue to close**: Post a comment explaining why, then close it.
   ```bash
   # Comment on an issue
   curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/issues/<NUMBER>/comments" \
     -d '{"body": "<explanation>"}'
   # Close an issue
   curl -s -X PATCH -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/issues/<NUMBER>" \
     -d '{"state": "closed", "state_reason": "completed"}'
   ```

2. **For learnings to propagate**: Edit `.claude/common-issues.md` or the relevant rules file.

3. **For actionable issues**: Fix the code, following the standard workflow (edit → validate → test).

4. **For cruft**: Remove dead code, resolve TODOs, split large files. Each change should be a focused, reviewable unit.

5. **For new issues discovered**: Create GitHub issues for problems found during the sweep that can't be fixed now.
   ```bash
   curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/issues" \
     -d '{"title": "<title>", "body": "<description>", "labels": ["enhancement"]}'
   ```

## Phase 4: Record

1. Update the last-run timestamp:
   ```bash
   date +%Y-%m-%d > .claude/maintain-last-run.txt
   ```
2. Write a session log summarizing what was done.
3. Commit all changes.
4. Run the standard `/push-and-ensure-green` workflow.

## Notes

- Be conservative with issue closures. When in doubt, comment with status rather than closing.
- For cruft removal, only remove things you're confident are unused. Grep thoroughly before deleting.
- This sweep should be non-destructive to wiki content. Page updates go through the Crux pipeline.
- If the sweep finds many issues (>10 actionable items), work on the top 5 and file the rest as GitHub issues for future sessions.
