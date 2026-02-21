# Edit Log — Rollback & Recovery Runbook

> **Authoritative source**: PostgreSQL database on wiki-server (since PR #485).
> The `data/edit-logs/` YAML directory has been permanently deleted.
> There is no automatic fallback to YAML if the database is lost.

## What is stored

Each edit log entry has:
- `pageId` — MDX slug (e.g. `open-philanthropy`)
- `date` — ISO date of the edit (YYYY-MM-DD)
- `tool` — pipeline that made the edit (`crux-improve`, `claude-code`, `manual`, etc.)
- `agency` — human involvement level (`human`, `ai-directed`, `automated`)
- `requestedBy` — person or system that initiated the edit (optional)
- `note` — free-text description of what changed (optional)
- `createdAt` — database insert timestamp (server-side, not editable)

## Normal operations

```bash
# View edit history for a page
pnpm crux edit-log view <page-id>

# Check stats across all pages
pnpm crux validate edit-logs

# Append an entry manually (e.g. after a manual edit)
# (use the crux improve or claude-code pipeline — it appends automatically)
```

## Backup procedure

The wiki-server database should be backed up regularly via `pg_dump`. Run this on the server host:

```bash
pg_dump -U <db_user> -d <db_name> -t edit_logs -F c -f edit_logs_$(date +%Y%m%d).dump
```

Verify the dump is non-empty before trusting it:

```bash
pg_restore --list edit_logs_YYYYMMDD.dump | grep -c "TABLE DATA"
# Should print 1
```

Store dumps in a location separate from the database host (e.g. S3 or a different server).

## Rollback: restore from a pg_dump backup

If the `edit_logs` table is corrupted or accidentally dropped:

```bash
# 1. Drop the corrupted table (if it still exists)
psql -U <db_user> -d <db_name> -c "DROP TABLE IF EXISTS edit_logs CASCADE;"

# 2. Restore from the most recent dump
pg_restore -U <db_user> -d <db_name> -t edit_logs edit_logs_YYYYMMDD.dump

# 3. Verify row count
psql -U <db_user> -d <db_name> -c "SELECT COUNT(*) FROM edit_logs;"
```

If the sequence is out of sync after restore:

```bash
psql -U <db_user> -d <db_name> -c "SELECT setval('edit_logs_id_seq', (SELECT MAX(id) FROM edit_logs));"
```

## Rollback: reconstruct from git history (no backup)

If no database backup is available, entries can be partially reconstructed from git history. Each commit that ran the crux pipeline corresponds to one or more edit log entries.

**Limitation**: only the date and approximate tool can be recovered from git. `requestedBy` and `note` fields cannot be recovered without access to original pipeline logs.

```bash
# List commits that touched content pages, with their dates and authors
git log --pretty=format:"%H %ad %an %s" --date=short -- "content/docs/**/*.mdx" > git_edit_history.txt

# For each commit, identify which pages changed
git diff-tree --no-commit-id -r --name-only <commit-hash> | grep "content/docs"
```

To bulk-insert reconstructed entries, write a script that calls `appendEditLogBatch` from `crux/lib/wiki-server/edit-logs.ts` with the recovered data.

## Rollback: revert to a previous wiki-server version

If a wiki-server code change introduced a bug affecting edit log writes:

```bash
# On the wiki-server host
git log --oneline -20                    # Find the last known-good commit
git checkout <good-commit-hash>          # Revert the server code
pnpm build && pnpm start                 # Restart the server
```

Then verify the crux CLI can write entries:

```bash
pnpm crux validate edit-logs             # Should report stats without errors
```

## Checking health after any rollback

```bash
# From the longterm-wiki repo
pnpm crux validate edit-logs             # Stats check via wiki-server API
pnpm crux edit-log view open-philanthropy  # Spot-check a high-activity page
```

Expected output of `validate edit-logs` when healthy:

```
  ✓ Edit log store healthy
    Total entries: <N>  |  Pages with logs: <M>
    By tool: crux-improve=..., claude-code=..., ...
```

## What changed in #485 (migration)

- `data/edit-logs/` YAML files were deleted from the repository
- `crux/lib/edit-log.ts` now writes exclusively to PostgreSQL via wiki-server API
- `validate-edit-logs.ts` was updated from a YAML validator to a server stats check
- The `pnpm crux edit-log view` command reads from PostgreSQL, not YAML

There is no migration script to re-run — the YAML data was imported into PostgreSQL before deletion.
