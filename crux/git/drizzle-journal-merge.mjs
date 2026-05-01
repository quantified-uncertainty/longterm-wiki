/**
 * Drizzle journal merge driver — auto-resolves `_journal.json` conflicts on rebase.
 *
 * Wired up via `.gitattributes`:
 *
 *     apps/wiki-server/drizzle/meta/_journal.json merge=drizzle-journal
 *
 * plus `git config merge.drizzle-journal.driver "node crux/git/drizzle-journal-merge.mjs %O %A %B %P"`
 * (set by `pnpm install` / `scripts/setup.sh`).
 *
 * The conflict shape: two PRs both add a migration grabbing the next idx (e.g.
 * both 221), and neither rebase nor a 3-way merge can resolve it without a
 * human or an LLM round-trip. This driver:
 *
 *   1. Parses the three journal versions (base, ours, theirs).
 *   2. Computes the union of `entries` by tag.
 *   3. For conflicts (duplicate idx or duplicate tag prefix), renumbers the
 *      LATER migration (by `when`) to a fresh idx above the current max.
 *   4. Renames migration .sql files (and snapshot.json siblings) on disk via
 *      `git mv` when the prefix changes.
 *   5. Bumps `when` timestamps for renumbered entries to keep strictly
 *      increasing (else the migrator silently skips them).
 *   6. Writes the resolved journal to %A.
 *
 * Failure mode: on any error (parse failure, file rename failure), exits 1
 * with a clear message pointing the user at `pnpm crux migrations renumber`
 * to fix the journal manually after the rebase aborts. Git falls back to
 * the standard 3-way merge in that case — which leaves conflict markers
 * in `_journal.json` exactly as before, so this driver is additive: it can
 * only succeed where the default merge would have failed.
 *
 * Implemented as plain ESM (no tsx dependency) so it runs unaltered on
 * every developer's machine — even on a fresh clone before `pnpm install`
 * has populated `node_modules`.
 *
 * The pure merge logic is exposed as `mergeJournals()` for unit testing —
 * the side-effecting filesystem operations live in the `runMergeDriver()`
 * entry point.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Resolve duplicate idx values and duplicate tag prefixes by renumbering the
 * conflicting entries to fresh idx values (above the current max). Historical
 * entries with valid idx and unique tag prefixes are LEFT UNCHANGED — this
 * keeps the rewrite minimal and avoids producing a noisy diff that touches
 * already-applied production migrations.
 *
 * Conflict detection:
 *   - Two or more entries with the same `idx`.
 *   - Two or more entries whose tag begins with the same numeric prefix.
 *
 * Resolution: for each conflict group, the entry with the smallest `when`
 * (i.e. the migration authored first) keeps its idx/tag. The remaining
 * entries are renumbered to the next free idx values above the current
 * maximum, and their tags rewritten to match.
 *
 * This is the right shape for the canonical scenario the merge driver is
 * built for: two PRs both grabbed `idx=221`. The earlier one keeps 221,
 * the later one becomes 222.
 *
 * Used as a fallback (`crux migrations renumber`) and as the shared core of
 * the 3-way merge below.
 */
export function renumberJournal(journal) {
  // Make a deep copy so callers' input isn't mutated.
  const entries = journal.entries.map((e) => ({ ...e }));

  // Identify conflict groups by idx and by tag prefix. We collect indices
  // (positions in the entries array) so we can pick a winner deterministically.
  const idxGroups = new Map();
  const prefixGroups = new Map();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!idxGroups.has(e.idx)) idxGroups.set(e.idx, []);
    idxGroups.get(e.idx).push(i);

    const m = e.tag.match(/^(\d+)_/);
    if (m) {
      const p = m[1];
      if (!prefixGroups.has(p)) prefixGroups.set(p, []);
      prefixGroups.get(p).push(i);
    }
  }

  // Collect the set of entry indices that need to be renumbered: any entry
  // not in the "winner" position of its idx-group or prefix-group. Winner
  // is the entry with smallest `when` (tie-break by tag for determinism).
  const needsRenum = new Set();
  const pickWinner = (group) => {
    let winner = group[0];
    for (const i of group.slice(1)) {
      const a = entries[winner];
      const b = entries[i];
      if (b.when < a.when || (b.when === a.when && b.tag.localeCompare(a.tag) < 0)) {
        winner = i;
      }
    }
    return winner;
  };
  for (const group of idxGroups.values()) {
    if (group.length < 2) continue;
    const winner = pickWinner(group);
    for (const i of group) {
      if (i !== winner) needsRenum.add(i);
    }
  }
  for (const group of prefixGroups.values()) {
    if (group.length < 2) continue;
    const winner = pickWinner(group);
    for (const i of group) {
      if (i !== winner) needsRenum.add(i);
    }
  }

  // Compute the next free idx and prefix above any existing entry's value.
  // A "used" idx comes from any entry's current idx OR any entry's tag prefix
  // (in case the journal records idx=N for tag `00MM_*` with M != N).
  const usedIdx = new Set();
  for (const e of entries) {
    usedIdx.add(e.idx);
    const m = e.tag.match(/^(\d+)_/);
    if (m) usedIdx.add(parseInt(m[1], 10));
  }
  let nextFreeIdx = 0;
  for (const v of usedIdx) if (v >= nextFreeIdx) nextFreeIdx = v + 1;

  // Renumber conflicting entries in `when` order so deterministic tie-breaks
  // give the older migration the lower new idx.
  const toRenum = [...needsRenum].sort((a, b) => {
    const ea = entries[a];
    const eb = entries[b];
    return (ea.when - eb.when) || ea.tag.localeCompare(eb.tag);
  });

  const renames = [];
  for (const i of toRenum) {
    const entry = entries[i];
    const newIdx = nextFreeIdx++;
    const newPrefix = String(newIdx).padStart(4, '0');
    const m = entry.tag.match(/^(\d+)_/);
    if (m && m[1] !== newPrefix) {
      const oldTag = entry.tag;
      const newTag = `${newPrefix}_${entry.tag.slice(m[0].length)}`;
      renames.push({ oldTag, newTag });
      entry.tag = newTag;
    }
    entry.idx = newIdx;
  }

  // Track which entry references were renumbered. We bump only their `when`
  // values for monotonicity — historical entries are left untouched so we
  // don't churn already-applied production state.
  const touched = new Set(toRenum.map((i) => entries[i]));

  // We don't re-sort the entries array. Drizzle migrations are ordered by
  // `when`, not by idx — sorting by idx would gratuitously reorder rows
  // when an existing journal has historical out-of-position entries (idx
  // gaps, manual cleanups). The validator only requires unique idx, unique
  // tag prefix, and strictly-increasing `when` in array order.

  // Ensure strictly-increasing `when` — duplicates cause the migrator to
  // silently skip migrations (it compares `created_at < folderMillis`).
  let prev = -Infinity;
  for (const e of entries) {
    if (touched.has(e) && e.when <= prev) e.when = prev + 1;
    prev = Math.max(prev, e.when);
  }

  return {
    resolved: {
      version: journal.version,
      dialect: journal.dialect,
      entries,
    },
    renames,
  };
}

/**
 * Pure JSON merge — given the three versions of `_journal.json` (base, ours,
 * theirs), compute the resolved journal and the list of file renames implied
 * by reassigned idx values.
 *
 * Strategy:
 *   - Base entries pass through unchanged (drizzle migrations are append-only;
 *     entries already in base refer to migrations applied in production).
 *   - Additions from ours and theirs are unioned by tag, then handed to
 *     `renumberJournal` which resolves any idx or prefix collisions.
 *   - Conflicts on top-level keys (`version`, `dialect`) are resolved by
 *     preferring `ours` — they only change when drizzle-kit's schema version
 *     bumps, which is rare and the user can re-run drizzle-kit if needed.
 */
export function mergeJournals(base, ours, theirs) {
  const baseTags = new Set(base.entries.map((e) => e.tag));
  const additionsByTag = new Map();
  for (const e of ours.entries) {
    if (!baseTags.has(e.tag)) additionsByTag.set(e.tag, { ...e });
  }
  for (const e of theirs.entries) {
    if (!baseTags.has(e.tag)) additionsByTag.set(e.tag, { ...e });
  }

  return renumberJournal({
    version: ours.version,
    dialect: ours.dialect,
    entries: [...base.entries.map((e) => ({ ...e })), ...additionsByTag.values()],
  });
}

/**
 * Serialize a journal in drizzle-kit's exact format: 2-space indent + two
 * trailing newlines. Any deviation produces noisy diffs on every subsequent
 * `drizzle-kit generate`.
 */
export function serializeJournal(journal) {
  return JSON.stringify(journal, null, 2) + '\n\n';
}

/**
 * Run a git command, throwing with a descriptive error on failure.
 * Uses execFileSync to avoid shell-injection issues with file paths.
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args.join(' ')} failed: ${message}`);
  }
}

/**
 * Check whether a path is tracked by git (has a known index entry).
 */
function isTracked(path, cwd) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', path], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply a list of tag renames to the worktree: rename the .sql migration
 * file and any matching snapshot.json file. Uses `git mv` so the rename
 * is staged automatically.
 *
 * `drizzleDir` is interpreted relative to `repoRoot` if not absolute. We
 * resolve to an absolute path before calling `existsSync` / `git mv` so the
 * driver works correctly regardless of the parent process's CWD.
 *
 * Operates in two modes depending on whether the source file is in the
 * worktree:
 *
 *   - **Worktree present + index unlocked** (post-rebase / post-merge hook):
 *     `git mv` the file. The rename is staged and the next commit (or
 *     `--amend`) picks it up.
 *   - **File not yet in worktree** (mid-rebase merge driver invocation):
 *     git's index is held by the rebase machinery — `git mv` fails with
 *     `index.lock: File exists`. We can't reach the file because it's only
 *     in the rebase's pending tree, not the worktree. The caller (the
 *     merge driver) catches this and writes a marker file that the
 *     post-rewrite/post-merge hook will apply once git releases the lock.
 *
 * If the .sql file is already at the new path (idempotent re-run), we
 * skip silently — git can re-invoke the merge driver during conflict
 * resolution and we want re-runs to be no-ops.
 */
export function applyRenames(renames, drizzleDir, repoRoot) {
  const skipped = [];
  const deferred = [];
  let renamed = 0;

  // Resolve drizzleDir relative to repoRoot so we don't depend on CWD.
  const absDrizzleDir = drizzleDir.startsWith('/') ? drizzleDir : join(repoRoot, drizzleDir);

  for (const { oldTag, newTag } of renames) {
    const oldSql = join(absDrizzleDir, `${oldTag}.sql`);
    const newSql = join(absDrizzleDir, `${newTag}.sql`);

    if (!existsSync(oldSql)) {
      if (existsSync(newSql)) {
        // Already renamed — idempotent.
        skipped.push(`${oldTag}.sql (already renamed to ${newTag}.sql)`);
        renamed++;
      } else {
        // File isn't in the worktree yet (e.g., mid-rebase the .sql will
        // arrive when git applies the commit's tree). Defer this rename
        // to the post-rewrite/post-merge hook.
        deferred.push({ oldTag, newTag });
      }
      continue;
    }

    if (existsSync(newSql)) {
      throw new Error(
        `Cannot rename ${oldTag}.sql → ${newTag}.sql: destination already exists. ` +
          `This indicates a tag collision the merge driver cannot resolve safely.`,
      );
    }

    if (isTracked(oldSql, repoRoot)) {
      try {
        git(['mv', oldSql, newSql], repoRoot);
      } catch (err) {
        // `git mv` fails with `index.lock` while git holds the merge index.
        // Defer — the post-rewrite/post-merge hook will retry once the lock
        // is released.
        const message = err instanceof Error ? err.message : String(err);
        if (/index\.lock/i.test(message)) {
          deferred.push({ oldTag, newTag });
          continue;
        }
        throw err;
      }
    } else {
      // Untracked file — rename via fs and stage.
      renameSync(oldSql, newSql);
      try {
        git(['add', newSql], repoRoot);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/index\.lock/i.test(message)) {
          deferred.push({ oldTag, newTag });
          continue;
        }
        throw err;
      }
    }
    renamed++;

    // Also rename the snapshot.json sibling, if it exists.
    // Snapshots are sparse in this codebase — most migrations don't have one.
    const oldPrefix = oldTag.match(/^(\d+)_/)?.[1];
    const newPrefix = newTag.match(/^(\d+)_/)?.[1];
    if (oldPrefix && newPrefix && oldPrefix !== newPrefix) {
      const oldSnap = join(absDrizzleDir, 'meta', `${oldPrefix}_snapshot.json`);
      const newSnap = join(absDrizzleDir, 'meta', `${newPrefix}_snapshot.json`);
      if (existsSync(oldSnap) && !existsSync(newSnap)) {
        if (isTracked(oldSnap, repoRoot)) {
          try {
            git(['mv', oldSnap, newSnap], repoRoot);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!/index\.lock/i.test(message)) throw err;
            // Snapshot rename can be deferred too — hook handles it.
          }
        } else {
          renameSync(oldSnap, newSnap);
          try {
            git(['add', newSnap], repoRoot);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!/index\.lock/i.test(message)) throw err;
          }
        }
      }
    }
  }

  return { renamed, skipped, deferred };
}

/**
 * Locate the repository root by walking up from a starting directory until
 * a `.git` entry is found. Throws if not inside a git repo.
 */
function findRepoRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Not inside a git repository (started from ${startDir})`);
    }
    dir = parent;
  }
}

/**
 * Entry point for the git merge driver. Args correspond to git's `%O %A %B %P`:
 *
 *   pathBase    — common ancestor's version (read-only temp file)
 *   pathOurs    — current branch's version (also the OUTPUT path)
 *   pathTheirs  — other branch's version (read-only temp file)
 *   workingPath — pathname of the conflicted file in the worktree
 *
 * On success: writes resolved JSON to pathOurs, renames .sql/snapshot files,
 * exits 0.
 *
 * On failure: prints a message recommending `pnpm crux migrations renumber`,
 * exits 1 — which leaves the conflict markers in place so the user can
 * inspect and fix manually.
 */
export function runMergeDriver(pathBase, pathOurs, pathTheirs, workingPath, cwd = process.cwd()) {
  let base, ours, theirs;
  try {
    base = JSON.parse(readFileSync(pathBase, 'utf-8'));
    ours = JSON.parse(readFileSync(pathOurs, 'utf-8'));
    theirs = JSON.parse(readFileSync(pathTheirs, 'utf-8'));
  } catch (err) {
    return {
      exitCode: 1,
      message:
        `drizzle-journal-merge: failed to parse one of the input journals: ${err instanceof Error ? err.message : String(err)}\n` +
        `  Falling back to standard 3-way merge. After resolving manually, run:\n` +
        `    pnpm crux migrations renumber`,
    };
  }

  let mergeResult;
  try {
    mergeResult = mergeJournals(base, ours, theirs);
  } catch (err) {
    return {
      exitCode: 1,
      message:
        `drizzle-journal-merge: merge logic failed: ${err instanceof Error ? err.message : String(err)}\n` +
        `  Falling back to standard 3-way merge. After resolving manually, run:\n` +
        `    pnpm crux migrations renumber`,
    };
  }

  let repoRoot;
  try {
    repoRoot = findRepoRoot(cwd);
  } catch (err) {
    return {
      exitCode: 1,
      message: `drizzle-journal-merge: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The .sql files we need to rename live in the directory containing the
  // conflicted journal's parent (e.g. apps/wiki-server/drizzle/meta/
  // _journal.json → apps/wiki-server/drizzle/).
  const drizzleDir = dirname(dirname(workingPath));

  let deferredRenames = [];
  try {
    const result = applyRenames(mergeResult.renames, drizzleDir, repoRoot);
    deferredRenames = result.deferred;
  } catch (err) {
    return {
      exitCode: 1,
      message:
        `drizzle-journal-merge: failed to rename migration files: ${err instanceof Error ? err.message : String(err)}\n` +
        `  After resolving the rebase, run:\n` +
        `    pnpm crux migrations renumber`,
    };
  }

  // Persist any renames we couldn't apply now (because git's index lock is
  // held and/or the source .sql file isn't in the worktree yet) so the
  // post-rewrite / post-merge hook can finish them once the rebase /merge
  // completes.
  if (deferredRenames.length > 0) {
    try {
      const pendingPath = join(repoRoot, '.git', 'MIGRATION_RENAMES_PENDING');
      const payload = {
        version: 1,
        drizzleDir, // path relative to repo root
        renames: deferredRenames,
      };
      writeFileSync(pendingPath, JSON.stringify(payload, null, 2));
    } catch (err) {
      return {
        exitCode: 1,
        message:
          `drizzle-journal-merge: failed to write pending-renames marker: ${err instanceof Error ? err.message : String(err)}\n` +
          `  After the rebase completes, run:\n` +
          `    pnpm crux migrations renumber`,
      };
    }
  }

  try {
    writeFileSync(pathOurs, serializeJournal(mergeResult.resolved));
  } catch (err) {
    return {
      exitCode: 1,
      message: `drizzle-journal-merge: failed to write resolved journal: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const renameCount = mergeResult.renames.length;
  let message = `drizzle-journal-merge: resolved ${mergeResult.resolved.entries.length} entries`;
  if (renameCount > 0) {
    message += ` (${renameCount} migration${renameCount === 1 ? '' : 's'} renumbered`;
    if (deferredRenames.length > 0) {
      message += `; ${deferredRenames.length} rename${deferredRenames.length === 1 ? '' : 's'} deferred to post-rewrite hook`;
    }
    message += ')';
  }
  return { exitCode: 0, message };
}

// CLI entry point — only runs when executed directly, not when imported by tests.
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  /drizzle-journal-merge\.(mjs|cjs|js|ts)$/.test(process.argv[1]);

if (invokedDirectly) {
  const [, , pathBase, pathOurs, pathTheirs, workingPath] = process.argv;
  if (!pathBase || !pathOurs || !pathTheirs || !workingPath) {
    process.stderr.write(
      'Usage: drizzle-journal-merge.mjs <base> <ours> <theirs> <working-path>\n' +
        '  This is a git merge driver — git invokes it with %O %A %B %P.\n',
    );
    process.exit(2);
  }
  const result = runMergeDriver(pathBase, pathOurs, pathTheirs, workingPath);
  process.stderr.write(result.message + '\n');
  process.exit(result.exitCode);
}
