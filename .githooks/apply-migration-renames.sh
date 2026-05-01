#!/usr/bin/env bash
#
# Apply migration .sql renames recorded by the drizzle-journal merge driver.
#
# The merge driver (crux/git/drizzle-journal-merge.mjs) resolves
# _journal.json conflicts on rebase by renumbering the loser of an idx
# collision. The .sql file rename can't always happen during the merge
# itself — git holds the index lock and the source .sql may not yet be in
# the worktree (mid-rebase). So the driver writes a marker file at
# .git/MIGRATION_RENAMES_PENDING, and this script applies the renames once
# the rebase / merge completes (post-rewrite / post-merge).
#
# Behavior:
#   - Reads .git/MIGRATION_RENAMES_PENDING (JSON: { drizzleDir, renames }).
#   - For each rename, `git mv` the .sql file (and snapshot.json sibling).
#   - If any rename succeeded, amend HEAD to fold them into the just-made
#     commit. This keeps the rebase / merge result a single clean commit.
#   - Always removes the marker file so it doesn't carry over.
#
# Exits 0 on success or no-op. Failures are warned but never block the user
# (it's only ever called from non-blocking hooks). Worst case the user runs
# `pnpm crux migrations renumber` to clean up.

set -uo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo '')"
if [ -z "$REPO" ]; then exit 0; fi

PENDING="$REPO/.git/MIGRATION_RENAMES_PENDING"
if [ ! -f "$PENDING" ]; then exit 0; fi

# Parse the marker JSON in a single Node invocation (drizzleDir on the first
# line, then one tab-separated `oldTag\tnewTag` per rename). We rely on Node
# being available — same prerequisite as the merge driver itself. Tags are
# validated against the same regex as the merge driver to defeat path
# traversal via attacker-controlled journal content.
PARSED="$(node -e '
  const path = process.argv[1];
  const j = JSON.parse(require("fs").readFileSync(path, "utf-8"));
  if (typeof j.drizzleDir !== "string" || !j.drizzleDir) process.exit(2);
  const SAFE = /^\d+_[A-Za-z0-9_]+$/;
  console.log(j.drizzleDir);
  for (const r of j.renames || []) {
    if (typeof r?.oldTag !== "string" || typeof r?.newTag !== "string") continue;
    if (!SAFE.test(r.oldTag) || !SAFE.test(r.newTag)) continue;
    console.log(r.oldTag + "\t" + r.newTag);
  }
' "$PENDING" 2>/dev/null || true)"

if [ -z "$PARSED" ]; then
  echo "drizzle-journal-merge: pending marker is corrupt or empty — removing $PENDING" >&2
  rm -f "$PENDING"
  exit 0
fi

DRIZZLE_DIR="$(printf '%s\n' "$PARSED" | head -n 1)"
RENAMES_TSV="$(printf '%s\n' "$PARSED" | tail -n +2)"

if [ -z "$DRIZZLE_DIR" ]; then
  echo "drizzle-journal-merge: pending marker missing drizzleDir — removing $PENDING" >&2
  rm -f "$PENDING"
  exit 0
fi

cd "$REPO"

ANY_RENAMED=0
while IFS=$'\t' read -r OLD_TAG NEW_TAG; do
  [ -z "$OLD_TAG" ] && continue

  OLD_SQL="$DRIZZLE_DIR/${OLD_TAG}.sql"
  NEW_SQL="$DRIZZLE_DIR/${NEW_TAG}.sql"

  if [ -f "$OLD_SQL" ] && [ ! -f "$NEW_SQL" ]; then
    if git mv "$OLD_SQL" "$NEW_SQL" 2>/dev/null; then
      ANY_RENAMED=1
    else
      # File might be untracked — fall back to fs rename + git add.
      mv "$OLD_SQL" "$NEW_SQL" 2>/dev/null && git add "$NEW_SQL" 2>/dev/null && ANY_RENAMED=1
    fi
  elif [ ! -f "$OLD_SQL" ] && [ -f "$NEW_SQL" ]; then
    # Already in the desired state (idempotent re-run).
    :
  fi

  # Snapshot.json sibling — same pattern, optional.
  OLD_PREFIX="$(echo "$OLD_TAG" | grep -oE '^[0-9]+' || true)"
  NEW_PREFIX="$(echo "$NEW_TAG" | grep -oE '^[0-9]+' || true)"
  if [ -n "$OLD_PREFIX" ] && [ -n "$NEW_PREFIX" ] && [ "$OLD_PREFIX" != "$NEW_PREFIX" ]; then
    OLD_SNAP="$DRIZZLE_DIR/meta/${OLD_PREFIX}_snapshot.json"
    NEW_SNAP="$DRIZZLE_DIR/meta/${NEW_PREFIX}_snapshot.json"
    if [ -f "$OLD_SNAP" ] && [ ! -f "$NEW_SNAP" ]; then
      git mv "$OLD_SNAP" "$NEW_SNAP" 2>/dev/null || true
    fi
  fi
done <<<"$RENAMES_TSV"

rm -f "$PENDING"

if [ "$ANY_RENAMED" = "1" ]; then
  # Try to fold renames into HEAD. The amend re-fires post-rewrite /
  # post-merge but the marker file was deleted above, so the recursive call
  # is a no-op.
  #
  # During the post-merge hook, git may still consider itself "in the middle
  # of a merge" — `git commit --amend` fails with exit 128 in that case.
  # That's fine: we leave the rename as a staged change. The user will see
  # it in `git status` and can commit it manually (or it'll go into their
  # next commit on the branch).
  if [ -e "$REPO/.git/MERGE_HEAD" ] || [ -e "$REPO/.git/MERGE_MSG" ]; then
    echo "drizzle-journal-merge: .sql rename staged (still mid-merge — run 'git commit --amend --no-edit' after the merge completes to fold it in)"
  elif git commit --amend --no-edit >/dev/null 2>&1; then
    echo "drizzle-journal-merge: applied deferred .sql renames and amended HEAD"
  else
    # The merge state can persist briefly into the post-merge hook on some
    # git versions. Stage-only fallback: rename is in the index, user
    # commits later.
    echo "drizzle-journal-merge: .sql rename staged — run 'git commit --amend --no-edit' to fold it in"
  fi
fi

exit 0
