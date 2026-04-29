/**
 * Tests for the review-marker check (QUA-849 #7).
 *
 * Covers parsing, the four mismatch modes (missing / malformed / stale-sha
 * / stale-diff), and the happy path. Uses a temp git repo per test so we
 * don't pollute the real working copy.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseMarker,
  computeDiffHash,
  checkReviewMarker,
} from './review-marker.ts';

let tmpRepo: string;

function git(cmd: string): string {
  return execSync(`git ${cmd}`, {
    cwd: tmpRepo,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf-8',
  }).trim();
}

function writeMarker(content: string) {
  mkdirSync(join(tmpRepo, '.claude'), { recursive: true });
  writeFileSync(join(tmpRepo, '.claude', 'review-done'), content);
}

beforeEach(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'review-marker-test-'));
  // Init repo with a `main` branch that has one commit, then branch off
  // and add a feature commit so HEAD differs from merge-base.
  git('init -q -b main');
  git('config user.email "test@example.com"');
  git('config user.name "test"');
  writeFileSync(join(tmpRepo, 'a.txt'), 'a\n');
  git('add .');
  git('commit -q -m base');
  git('checkout -q -b feature');
  writeFileSync(join(tmpRepo, 'b.txt'), 'b\n');
  git('add .');
  git('commit -q -m feature');
});

afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true });
});

describe('parseMarker', () => {
  it('parses a well-formed marker line', () => {
    const m = parseMarker(
      'reviewed 05f97cfa1b51b57e4b4f53d41dec1f93adefa409 2026-04-29T22:09:14Z ec22bfc68c62',
    );
    expect(m).toEqual({
      commitSha: '05f97cfa1b51b57e4b4f53d41dec1f93adefa409',
      isoTime: '2026-04-29T22:09:14Z',
      diffHash: 'ec22bfc68c62',
    });
  });

  it('lowercases the SHA and diff hash for case-insensitive compare', () => {
    const m = parseMarker(
      'reviewed 05F97CFA1B51B57E4B4F53D41DEC1F93ADEFA409 2026-04-29T22:09:14Z EC22BFC68C62',
    );
    expect(m?.commitSha).toBe('05f97cfa1b51b57e4b4f53d41dec1f93adefa409');
    expect(m?.diffHash).toBe('ec22bfc68c62');
  });

  it('tolerates surrounding whitespace and trailing newline', () => {
    const m = parseMarker(
      '  reviewed 05f97cfa1b51b57e4b4f53d41dec1f93adefa409 2026-04-29T22:09:14Z ec22bfc68c62  \n',
    );
    expect(m).not.toBeNull();
  });

  it('rejects a SHA that is not exactly 40 hex chars', () => {
    expect(parseMarker('reviewed abc123 2026-04-29T22:09:14Z ec22bfc68c62')).toBeNull();
    expect(
      parseMarker(
        'reviewed 05f97cfa1b51b57e4b4f53d41dec1f93adefa40 2026-04-29T22:09:14Z ec22bfc68c62',
      ),
    ).toBeNull(); // 39 chars
  });

  it('rejects a diff hash that is not exactly 12 hex chars', () => {
    expect(
      parseMarker(
        'reviewed 05f97cfa1b51b57e4b4f53d41dec1f93adefa409 2026-04-29T22:09:14Z xyz',
      ),
    ).toBeNull();
    expect(
      parseMarker(
        'reviewed 05f97cfa1b51b57e4b4f53d41dec1f93adefa409 2026-04-29T22:09:14Z ec22bfc68c62extra',
      ),
    ).toBeNull();
  });

  it('rejects empty / unrelated input', () => {
    expect(parseMarker('')).toBeNull();
    expect(parseMarker('hello world')).toBeNull();
    expect(parseMarker('not-a-marker')).toBeNull();
  });

  it('rejects a marker that omits the leading `reviewed`', () => {
    expect(
      parseMarker(
        '05f97cfa1b51b57e4b4f53d41dec1f93adefa409 2026-04-29T22:09:14Z ec22bfc68c62',
      ),
    ).toBeNull();
  });
});

describe('computeDiffHash', () => {
  it('produces a stable 12-char hex hash for an unchanged HEAD', () => {
    const h1 = computeDiffHash(tmpRepo);
    const h2 = computeDiffHash(tmpRepo);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{12}$/);
  });

  it('changes when a new commit lands on the branch', () => {
    const before = computeDiffHash(tmpRepo);
    writeFileSync(join(tmpRepo, 'c.txt'), 'c\n');
    git('add .');
    git('commit -q -m more');
    const after = computeDiffHash(tmpRepo);
    expect(after).not.toBe(before);
  });

  it('matches the shell pipeline `git diff ... | shasum -a 256 | cut -c1-12`', () => {
    // Cross-check: the marker writer in /agent-review-pr.md uses the shell
    // pipeline. This test ensures our Node-side hash agrees byte-for-byte.
    const mergeBase = execSync('git merge-base HEAD main', {
      cwd: tmpRepo,
      encoding: 'utf-8',
    }).trim();
    const shellHash = execSync(
      `git diff ${mergeBase}...HEAD | shasum -a 256 | cut -c1-12`,
      { cwd: tmpRepo, encoding: 'utf-8' },
    ).trim();
    expect(computeDiffHash(tmpRepo)).toBe(shellHash);
  });
});

describe('checkReviewMarker', () => {
  it('returns code=missing when the marker file does not exist', () => {
    const result = checkReviewMarker(tmpRepo);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('missing');
    expect(result.message).toContain('/agent-review-pr');
  });

  it('returns code=malformed when the marker file is junk', () => {
    writeMarker('this is not a valid marker line\n');
    const result = checkReviewMarker(tmpRepo);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('malformed');
    expect(result.message).toContain('malformed');
  });

  it('returns code=stale-sha when HEAD has advanced past the reviewed commit', () => {
    const headSha = git('rev-parse HEAD');
    const diffHash = computeDiffHash(tmpRepo);
    writeMarker(`reviewed ${headSha} 2026-04-29T22:09:14Z ${diffHash}\n`);
    // Add a new commit — marker is now stale.
    writeFileSync(join(tmpRepo, 'd.txt'), 'd\n');
    git('add .');
    git('commit -q -m later');
    const result = checkReviewMarker(tmpRepo);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('stale-sha');
    expect(result.message).toContain('stale');
  });

  it('returns code=stale-diff when SHA matches but diff hash differs', () => {
    const headSha = git('rev-parse HEAD');
    // Write a marker with the right SHA but a fake diff hash.
    writeMarker(`reviewed ${headSha} 2026-04-29T22:09:14Z 000000000000\n`);
    const result = checkReviewMarker(tmpRepo);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('stale-diff');
    expect(result.message).toContain('diff hash differs');
  });

  it('returns ok=true when SHA and diff hash both match HEAD', () => {
    const headSha = git('rev-parse HEAD');
    const diffHash = computeDiffHash(tmpRepo);
    writeMarker(`reviewed ${headSha} 2026-04-29T22:09:14Z ${diffHash}\n`);
    const result = checkReviewMarker(tmpRepo);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('ok');
    expect(result.message).toContain('fresh');
  });

  it('returns code=no-base when run outside a git repo', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'review-marker-nonrepo-'));
    try {
      // Write a syntactically-valid marker so we get past the malformed check.
      mkdirSync(join(nonRepo, '.claude'), { recursive: true });
      writeFileSync(
        join(nonRepo, '.claude', 'review-done'),
        'reviewed 0123456789abcdef0123456789abcdef01234567 2026-04-29T22:09:14Z 0123456789ab\n',
      );
      const result = checkReviewMarker(nonRepo);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('no-base');
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('treats uppercase hex in the marker as equivalent to lowercase', () => {
    const headSha = git('rev-parse HEAD');
    const diffHash = computeDiffHash(tmpRepo);
    writeMarker(
      `reviewed ${headSha.toUpperCase()} 2026-04-29T22:09:14Z ${diffHash.toUpperCase()}\n`,
    );
    const result = checkReviewMarker(tmpRepo);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('ok');
  });
});
