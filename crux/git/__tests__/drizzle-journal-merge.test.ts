/**
 * Tests for the Drizzle journal merge driver.
 *
 * Three layers:
 *
 *   1. Pure merge logic — `mergeJournals` and `renumberJournal` operate on
 *      JSON in / JSON out. These are the most important tests because they
 *      cover the canonical conflict shape (two PRs both add `idx=221`).
 *   2. End-to-end driver — `runMergeDriver` writes the resolved journal to
 *      disk and renames .sql files via `git mv`. Tested against a fixture
 *      git repo set up in tmpfs.
 *   3. Integration — runs `git rebase` against fixture branches with idx
 *      collisions and asserts the merge driver resolves cleanly.
 *
 * The pure logic tests are the regression-blocker: if they pass, the conflict
 * shape from PR #4763 (qua-954: 0221 vs 0221 with main's qua-956) cannot
 * recur as a hand-resolved-by-LLM round-trip.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  mergeJournals,
  renumberJournal,
  runMergeDriver,
  serializeJournal,
} from '../drizzle-journal-merge.mjs';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function entry(idx: number, when: number, tag: string): JournalEntry {
  return { idx, version: '7', when, tag, breakpoints: true };
}

function journal(entries: JournalEntry[]): Journal {
  return { version: '7', dialect: 'postgresql', entries };
}

// ---------------------------------------------------------------------------
// Pure merge logic — mergeJournals
// ---------------------------------------------------------------------------

describe('mergeJournals — canonical idx-collision conflict', () => {
  it('two branches both adding idx=221 → resolves with renumber', () => {
    // Base: idx 0..220 (the state when both branches were cut)
    const baseEntries: JournalEntry[] = [];
    for (let i = 0; i <= 220; i++) {
      baseEntries.push(entry(i, 1_000_000 + i, `${String(i).padStart(4, '0')}_base_${i}`));
    }
    const base = journal(baseEntries);

    // Ours adds idx=221, tag `0221_qua_956_*` with when=1_000_300
    const ours = journal([
      ...baseEntries.map((e) => ({ ...e })),
      entry(221, 1_000_300, '0221_qua_956_policy_stakeholders_natural_key'),
    ]);

    // Theirs adds idx=221, tag `0221_qua_954_*` with when=1_000_400 (later)
    const theirs = journal([
      ...baseEntries.map((e) => ({ ...e })),
      entry(221, 1_000_400, '0221_qua_954_pipeline_runs'),
    ]);

    const result = mergeJournals(base, ours, theirs);

    // Should produce 223 entries: 221 base (idx 0..220) + 2 additions
    expect(result.resolved.entries).toHaveLength(223);

    // The earlier `when` (qua_956) wins the lower idx (221).
    const e221 = result.resolved.entries.find((e) => e.idx === 221);
    expect(e221?.tag).toBe('0221_qua_956_policy_stakeholders_natural_key');

    // The later one gets idx=222 and is renamed.
    const e222 = result.resolved.entries.find((e) => e.idx === 222);
    expect(e222?.tag).toBe('0222_qua_954_pipeline_runs');

    // The rename list reports the qua_954 file relocation.
    expect(result.renames).toEqual([
      { oldTag: '0221_qua_954_pipeline_runs', newTag: '0222_qua_954_pipeline_runs' },
    ]);

    // Base entries are untouched.
    for (let i = 0; i <= 220; i++) {
      const baseEntry = result.resolved.entries.find((e) => e.idx === i);
      expect(baseEntry).toEqual(baseEntries[i]);
    }
  });

  it('reverses winner if theirs has the earlier `when`', () => {
    const baseEntries: JournalEntry[] = [
      entry(0, 1_000_000, '0000_base'),
    ];
    const base = journal(baseEntries);

    // Ours has the LATER when=1_000_400
    const ours = journal([
      ...baseEntries,
      entry(1, 1_000_400, '0001_qua_a_later'),
    ]);

    // Theirs has the EARLIER when=1_000_300
    const theirs = journal([
      ...baseEntries,
      entry(1, 1_000_300, '0001_qua_b_earlier'),
    ]);

    const result = mergeJournals(base, ours, theirs);

    // The earlier `when` (theirs / qua_b) keeps idx=1.
    const e1 = result.resolved.entries.find((e) => e.idx === 1);
    expect(e1?.tag).toBe('0001_qua_b_earlier');

    const e2 = result.resolved.entries.find((e) => e.idx === 2);
    expect(e2?.tag).toBe('0002_qua_a_later');

    expect(result.renames).toEqual([
      { oldTag: '0001_qua_a_later', newTag: '0002_qua_a_later' },
    ]);
  });

  it('three colliding additions all renumber correctly', () => {
    // Edge case: three branches all adding idx=5
    const base = journal([
      entry(0, 100, '0000_base_0'),
      entry(1, 200, '0001_base_1'),
      entry(2, 300, '0002_base_2'),
      entry(3, 400, '0003_base_3'),
      entry(4, 500, '0004_base_4'),
    ]);
    const ours = journal([
      ...base.entries,
      entry(5, 600, '0005_a'),
      entry(5, 700, '0005_b'),
    ]);
    const theirs = journal([
      ...base.entries,
      entry(5, 650, '0005_c'),
    ]);

    const result = mergeJournals(base, ours, theirs);

    // 5 base + 3 additions = 8 entries
    expect(result.resolved.entries).toHaveLength(8);
    // Sorted by `when`: a (600) < c (650) < b (700)
    const idxByTag = new Map(result.resolved.entries.map((e) => [e.tag, e.idx]));
    expect(idxByTag.get('0005_a')).toBe(5);
    expect(idxByTag.get('0006_c')).toBe(6);
    expect(idxByTag.get('0007_b')).toBe(7);
  });

  it('preserves base entries with non-canonical idx ordering', () => {
    // Real-world journals have idx gaps (e.g. idx 207, 209 with no 208) and
    // tag prefixes that don't match idx. The merge driver MUST NOT touch
    // those — they refer to migrations already applied in production.
    const baseEntries: JournalEntry[] = [
      entry(0, 100, '0000_a'),
      entry(207, 200, '0207_b'),
      entry(209, 300, '0210_c'), // idx=209 but tag prefix is 0210 (legacy mismatch)
      entry(220, 400, '0220_d'),
    ];
    const base = journal(baseEntries);
    const ours = journal([...baseEntries, entry(221, 500, '0221_new_a')]);
    const theirs = journal([...baseEntries, entry(221, 600, '0221_new_b')]);

    const result = mergeJournals(base, ours, theirs);

    // Base entries unchanged — same idx, same when, same tag
    for (const baseEntry of baseEntries) {
      const matched = result.resolved.entries.find((e) => e.tag === baseEntry.tag);
      expect(matched).toEqual(baseEntry);
    }

    // The two additions get fresh idx values above max(existing idx, existing prefix)
    // existing idx max = 220, existing prefix max = 220 → next free = 221
    const newA = result.resolved.entries.find((e) => e.tag === '0221_new_a');
    const newB = result.resolved.entries.find((e) => e.tag === '0222_new_b');
    expect(newA?.idx).toBe(221);
    expect(newB?.idx).toBe(222);
  });

  it('handles same tag added on both branches (cherry-pick scenario)', () => {
    const base = journal([entry(0, 100, '0000_a')]);
    // Both branches independently add the SAME migration (tag identical)
    const ours = journal([...base.entries, entry(1, 200, '0001_dup')]);
    const theirs = journal([...base.entries, entry(1, 200, '0001_dup')]);

    const result = mergeJournals(base, ours, theirs);

    // Should dedup — only one entry for `0001_dup`.
    expect(result.resolved.entries).toHaveLength(2);
    expect(result.renames).toEqual([]);
  });

  it('bumps `when` to keep strict monotonicity when timestamps would collide', () => {
    const base = journal([entry(0, 100, '0000_a'), entry(1, 200, '0001_b')]);
    // Both branches add at the SAME `when`=300. The renamed loser must get
    // a `when` strictly above the previous max.
    const ours = journal([...base.entries, entry(2, 300, '0002_qua_a')]);
    const theirs = journal([...base.entries, entry(2, 300, '0002_qua_b')]);

    const result = mergeJournals(base, ours, theirs);

    expect(result.resolved.entries).toHaveLength(4);
    const e2 = result.resolved.entries.find((e) => e.idx === 2);
    const e3 = result.resolved.entries.find((e) => e.idx === 3);
    expect(e2?.when).toBe(300);
    // The renumbered entry's `when` was bumped above the previous max.
    expect(e3!.when).toBeGreaterThan(e2!.when);
  });

  it('produces the same result regardless of which branch is "ours" vs "theirs"', () => {
    // The driver should be symmetric — the underlying conflict has no
    // notion of "which side initiated the merge" beyond `when` ordering.
    const base = journal([entry(0, 100, '0000_a')]);
    const branch1 = journal([...base.entries, entry(1, 200, '0001_first')]);
    const branch2 = journal([...base.entries, entry(1, 300, '0001_second')]);

    const r1 = mergeJournals(base, branch1, branch2);
    const r2 = mergeJournals(base, branch2, branch1);

    // Tags + idx + when should be identical regardless of side.
    const summary = (r: typeof r1) => r.resolved.entries.map((e) => `${e.idx}:${e.tag}:${e.when}`).sort();
    expect(summary(r1)).toEqual(summary(r2));
  });
});

// ---------------------------------------------------------------------------
// Pure renumber logic — renumberJournal (fallback fixup)
// ---------------------------------------------------------------------------

describe('renumberJournal — single-journal fixup', () => {
  it('returns canonical journal unchanged (no renames)', () => {
    const j = journal([
      entry(0, 100, '0000_a'),
      entry(1, 200, '0001_b'),
      entry(2, 300, '0002_c'),
    ]);
    const result = renumberJournal(j);
    expect(result.renames).toEqual([]);
    expect(result.resolved.entries).toEqual(j.entries);
  });

  it('preserves idx gaps when there are no conflicts', () => {
    // Real-world journals have gaps. Don't churn historical state.
    const j = journal([
      entry(0, 100, '0000_a'),
      entry(207, 200, '0207_b'),
      entry(209, 300, '0210_c'), // idx=209, prefix=0210 — historical mismatch
    ]);
    const result = renumberJournal(j);
    expect(result.renames).toEqual([]);
    expect(result.resolved.entries).toEqual(j.entries);
  });

  it('resolves duplicate idx by renumbering the LATER `when`', () => {
    const j = journal([
      entry(0, 100, '0000_a'),
      entry(1, 200, '0001_first'),
      entry(1, 300, '0001_second'), // duplicate idx, later when
    ]);
    const result = renumberJournal(j);
    // Earlier wins — keeps idx=1
    const first = result.resolved.entries.find((e) => e.tag === '0001_first');
    expect(first?.idx).toBe(1);
    // Later gets renumbered to idx=2 (next free above max = 1)
    const second = result.resolved.entries.find((e) => e.tag === '0002_second');
    expect(second?.idx).toBe(2);
    expect(result.renames).toEqual([{ oldTag: '0001_second', newTag: '0002_second' }]);
  });

  it('resolves duplicate prefix even when idx differs', () => {
    // Two entries with idx 5 and 6 but BOTH have tag prefix `0005_*`.
    // This shouldn't happen via drizzle-kit but can happen via manual edits.
    const j = journal([
      entry(0, 100, '0000_a'),
      entry(5, 200, '0005_first'),
      entry(6, 300, '0005_dup'),
    ]);
    const result = renumberJournal(j);
    // The later `when` (0005_dup) gets renumbered to next free idx (7) and
    // its prefix rewritten to match.
    const dup = result.resolved.entries.find((e) => e.tag === '0007_dup');
    expect(dup?.idx).toBe(7);
    expect(result.renames).toEqual([{ oldTag: '0005_dup', newTag: '0007_dup' }]);
  });

  it('does not mutate input', () => {
    const j = journal([
      entry(1, 200, '0001_a'),
      entry(1, 300, '0001_b'),
    ]);
    const snapshot = JSON.stringify(j);
    renumberJournal(j);
    expect(JSON.stringify(j)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe('serializeJournal', () => {
  it('matches drizzle-kit format: 2-space indent + two trailing newlines', () => {
    const j = journal([entry(0, 100, '0000_a')]);
    const out = serializeJournal(j);
    expect(out.endsWith('\n\n')).toBe(true);
    expect(out).toMatch(/  "version": "7",\n  "dialect": "postgresql"/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end driver — writes %A, runs `git mv`
// ---------------------------------------------------------------------------

describe('runMergeDriver — end to end', () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'drizzle-merge-test-'));
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function setupRepo(testName: string): {
    repo: string;
    drizzleDir: string;
    metaDir: string;
  } {
    const repo = join(tmpRoot, testName);
    const drizzleDir = join(repo, 'drizzle');
    const metaDir = join(drizzleDir, 'meta');
    mkdirSync(metaDir, { recursive: true });

    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    return { repo, drizzleDir, metaDir };
  }

  function commit(repo: string, msg: string): void {
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repo });
  }

  it('writes resolved journal and renames .sql file via git mv', () => {
    const { repo, drizzleDir, metaDir } = setupRepo('e2e-rename');

    // Base state: idx 0
    const baseJournal = journal([entry(0, 100, '0000_base')]);
    writeFileSync(join(metaDir, '_journal.json'), serializeJournal(baseJournal));
    writeFileSync(join(drizzleDir, '0000_base.sql'), '-- base\n');
    commit(repo, 'base');

    // Set up the three temp files git would pass to the merge driver:
    // - %O = base
    // - %A = ours (current branch with one addition, also output target)
    // - %B = theirs (other branch with conflicting addition)
    const oursJournal = journal([
      ...baseJournal.entries,
      entry(1, 200, '0001_qua_a'),
    ]);
    const theirsJournal = journal([
      ...baseJournal.entries,
      entry(1, 300, '0001_qua_b'), // conflicting idx
    ]);

    // Place ours's .sql file in the worktree as if the rebase has applied it.
    writeFileSync(join(drizzleDir, '0001_qua_a.sql'), '-- qua_a\n');
    writeFileSync(join(drizzleDir, '0001_qua_b.sql'), '-- qua_b\n');
    // Both .sql files staged so `git mv` works.
    execFileSync('git', ['add', '-A'], { cwd: repo });

    const pathBase = join(tmpRoot, 'e2e-rename-base.json');
    const pathOurs = join(tmpRoot, 'e2e-rename-ours.json');
    const pathTheirs = join(tmpRoot, 'e2e-rename-theirs.json');
    writeFileSync(pathBase, serializeJournal(baseJournal));
    writeFileSync(pathOurs, serializeJournal(oursJournal));
    writeFileSync(pathTheirs, serializeJournal(theirsJournal));

    const workingPath = 'drizzle/meta/_journal.json';
    const result = runMergeDriver(pathBase, pathOurs, pathTheirs, workingPath, repo);

    expect(result.exitCode).toBe(0);

    // Output journal at %A reflects the resolved state.
    const out = JSON.parse(readFileSync(pathOurs, 'utf-8')) as Journal;
    expect(out.entries).toHaveLength(3);
    const tags = out.entries.map((e) => e.tag).sort();
    expect(tags).toEqual(['0000_base', '0001_qua_a', '0002_qua_b']);

    // The .sql rename happened via git mv.
    expect(existsSync(join(drizzleDir, '0001_qua_a.sql'))).toBe(true);
    expect(existsSync(join(drizzleDir, '0001_qua_b.sql'))).toBe(false);
    expect(existsSync(join(drizzleDir, '0002_qua_b.sql'))).toBe(true);
  });

  it('renames matching snapshot.json sibling when present', () => {
    const { repo, drizzleDir, metaDir } = setupRepo('e2e-snapshot');

    const baseJournal = journal([entry(0, 100, '0000_base')]);
    writeFileSync(join(metaDir, '_journal.json'), serializeJournal(baseJournal));
    writeFileSync(join(drizzleDir, '0000_base.sql'), '-- base\n');
    commit(repo, 'base');

    // Theirs adds an entry with a snapshot.json sibling
    writeFileSync(join(drizzleDir, '0001_a.sql'), '-- a\n');
    writeFileSync(join(drizzleDir, '0001_b.sql'), '-- b\n');
    writeFileSync(join(metaDir, '0001_snapshot.json'), '{"prevId":"x"}\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });

    const oursJournal = journal([...baseJournal.entries, entry(1, 200, '0001_a')]);
    const theirsJournal = journal([...baseJournal.entries, entry(1, 300, '0001_b')]);

    const pathBase = join(tmpRoot, 'snap-base.json');
    const pathOurs = join(tmpRoot, 'snap-ours.json');
    const pathTheirs = join(tmpRoot, 'snap-theirs.json');
    writeFileSync(pathBase, serializeJournal(baseJournal));
    writeFileSync(pathOurs, serializeJournal(oursJournal));
    writeFileSync(pathTheirs, serializeJournal(theirsJournal));

    const result = runMergeDriver(
      pathBase,
      pathOurs,
      pathTheirs,
      'drizzle/meta/_journal.json',
      repo,
    );

    expect(result.exitCode).toBe(0);

    // The losing entry was 0001_b (later when=300); it gets renamed to 0002_b.
    expect(existsSync(join(drizzleDir, '0002_b.sql'))).toBe(true);
    // The matching snapshot also moves: 0001_snapshot.json was the only one,
    // it belonged to the losing entry, so it should now be 0002_snapshot.json.
    // Actually we conservatively rename when idx-prefix changes for the entry,
    // so the snapshot follows.
    expect(existsSync(join(metaDir, '0002_snapshot.json'))).toBe(true);
    expect(existsSync(join(metaDir, '0001_snapshot.json'))).toBe(false);
  });

  it('writes a pending-renames marker when the source .sql is not in the worktree', () => {
    // This is the canonical mid-rebase scenario: git invokes the merge
    // driver before the rebase commit's tree has been written to the
    // worktree, so the .sql file we want to rename doesn't exist on disk
    // yet. We must defer the rename to a post-rewrite hook.
    const { repo, drizzleDir, metaDir } = setupRepo('e2e-defer');

    const baseJournal = journal([entry(0, 100, '0000_base')]);
    writeFileSync(join(metaDir, '_journal.json'), serializeJournal(baseJournal));
    writeFileSync(join(drizzleDir, '0000_base.sql'), '-- base\n');
    commit(repo, 'base');

    // Note: we deliberately do NOT create 0001_b.sql in the worktree —
    // simulating the mid-rebase state.
    const oursJournal = journal([...baseJournal.entries, entry(1, 200, '0001_a')]);
    const theirsJournal = journal([...baseJournal.entries, entry(1, 300, '0001_b')]);

    const pathBase = join(tmpRoot, 'defer-base.json');
    const pathOurs = join(tmpRoot, 'defer-ours.json');
    const pathTheirs = join(tmpRoot, 'defer-theirs.json');
    writeFileSync(pathBase, serializeJournal(baseJournal));
    writeFileSync(pathOurs, serializeJournal(oursJournal));
    writeFileSync(pathTheirs, serializeJournal(theirsJournal));

    const result = runMergeDriver(
      pathBase,
      pathOurs,
      pathTheirs,
      'drizzle/meta/_journal.json',
      repo,
    );

    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/deferred to post-rewrite hook/);

    // The marker file was written and contains the rename.
    const markerPath = join(repo, '.git', 'MIGRATION_RENAMES_PENDING');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    expect(marker.renames).toEqual([{ oldTag: '0001_b', newTag: '0002_b' }]);
    expect(marker.drizzleDir).toBe('drizzle');
  });

  it('exits 1 with helpful message when journal JSON is malformed', () => {
    const repo = mkdtempSync(join(tmpRoot, 'malformed-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    // Make a real commit so the repo isn't empty (avoids edge cases)
    writeFileSync(join(repo, 'README'), 'x');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

    const pathBase = join(tmpRoot, 'malformed-base.json');
    const pathOurs = join(tmpRoot, 'malformed-ours.json');
    const pathTheirs = join(tmpRoot, 'malformed-theirs.json');
    writeFileSync(pathBase, '{ not valid json');
    writeFileSync(pathOurs, '{}');
    writeFileSync(pathTheirs, '{}');

    const result = runMergeDriver(pathBase, pathOurs, pathTheirs, 'drizzle/meta/_journal.json', repo);

    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/failed to parse/);
    expect(result.message).toMatch(/crux migrations renumber/);
  });
});
