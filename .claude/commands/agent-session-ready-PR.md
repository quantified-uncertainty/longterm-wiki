# Agent Session Ready PR

Verify the agent checklist is complete, polish the PR, and ship.

This command assumes `/agent-session-start` was run earlier and `.claude/wip-checklist.md` exists.

## Step 1: Check progress

Run `pnpm crux agent-checklist status` to see what remains.

If `.claude/wip-checklist.md` doesn't exist, generate one now with `pnpm crux agent-checklist init "Task description" --type=X` and work through ALL items before proceeding.

## Step 2: Complete unchecked items

For each unchecked item in the checklist:

1. **Can it be completed now?** Do it and check it off.
2. **Not applicable?** Mark with `[~]` in the checklist.
3. **Blocked?** Note why next to the item.

Pay special attention to:
- **Paranoid review** (`paranoid-review`): Use the Task tool to spawn a fresh subagent with the full diff (`git diff main`) and this prompt: *"You are a paranoid code reviewer with no prior context. Find every bug, DRY violation, dead code, missing export, test coverage gap, hardcoded constant, and deferred work item in this diff. Be adversarial — assume something is wrong."* Paste findings here. Fix or document every issue before checking the item off.
- **Self-audit**: Re-run commands you claimed to run. Verify outputs match your claims.
- **Gate check**: `pnpm crux validate gate --fix` — record the exact test count.

## Step 3: Write / update PR description

Check if a PR exists and update it with: summary, key changes, test plan, issue references.

## Step 4: Update GitHub issue

If working on a GitHub issue:
```bash
pnpm crux issues done <ISSUE_NUM> --pr=<PR_URL>
```

## Step 5: Session log — write to DB

Run `pnpm crux agent-checklist snapshot` to get the `checks:` YAML block.

Then write a session YAML file and sync it to the wiki-server DB:

```bash
# Write the structured YAML session file
cat > .claude/sessions/$(date +%Y-%m-%d)_$(git branch --show-current | tr '/' '-').yaml << 'YAML'
date: "YYYY-MM-DD"
branch: "claude/..."
title: "Short title describing what was done"
summary: "One-paragraph summary of the session — what changed, why, and outcome."
model: "claude-sonnet-4-6"   # or opus-4-6, haiku-4-5
duration: "~Xmin"
cost: "$X"
pr: "https://github.com/quantified-uncertainty/longterm-wiki/pull/NNN"
pages:
  - page-id-1
  - page-id-2
issues:
  - "Issue or unexpected obstacle encountered (one per bullet)"
learnings:
  - "Key learning or insight from this session (one per bullet)"
recommendations:
  - "Follow-up work or improvement recommended for next time (one per bullet)"
checks:
  # paste output of `pnpm crux agent-checklist snapshot` here
YAML

# Sync the YAML to the wiki-server PostgreSQL DB
pnpm crux wiki-server sync-session .claude/sessions/YYYY-MM-DD_branch-name.yaml
```

**Required fields:** `date`, `branch`, `title`, `summary`, `pages`
**Rich fields (fill in all three):** `issues`, `learnings`, `recommendations` — these are stored as structured JSONB in the DB and power the `/internal/page-changes` dashboard. Use bullet arrays, not prose.

The `.yaml` file is gitignored (local scratch only). The DB is the source of truth.

## Step 6: Validate completion

Run `pnpm crux agent-checklist complete` — must exit 0 (all items checked or N/A).

## Step 7: Ship

Run `/push-and-ensure-green`.

## Step 8: Final report

Output a summary with: checklist final state, issues found & fixed, follow-up issues filed, and verdict (SHIP IT or NEEDS WORK).
