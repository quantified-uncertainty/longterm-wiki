/**
 * Tests for ID stability check (issue #148)
 *
 * Verifies that detectReassignments correctly identifies when entity
 * numeric IDs are silently reassigned between builds, and that
 * scanEntityLinkRefs correctly scans content files for broken refs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectReassignments, formatReassignments, scanEntityLinkRefs } from '../id-stability.mjs';

describe('detectReassignments', () => {
  it('returns empty array when no previous registry exists', () => {
    const result = detectReassignments(null, { E1: 'anthropic' }, { anthropic: 'E1' });
    expect(result).toEqual([]);
  });

  it('returns empty array when previous registry has no entities', () => {
    const result = detectReassignments({}, { E1: 'anthropic' }, { anthropic: 'E1' });
    expect(result).toEqual([]);
  });

  it('returns empty array when IDs are stable', () => {
    const prev = { entities: { E1: 'anthropic', E2: 'openai' } };
    const numericIdToSlug = { E1: 'anthropic', E2: 'openai' };
    const slugToNumericId = { anthropic: 'E1', openai: 'E2' };

    const result = detectReassignments(prev, numericIdToSlug, slugToNumericId);
    expect(result).toEqual([]);
  });

  it('returns empty array when new entities are added', () => {
    const prev = { entities: { E1: 'anthropic' } };
    const numericIdToSlug = { E1: 'anthropic', E2: 'openai' };
    const slugToNumericId = { anthropic: 'E1', openai: 'E2' };

    const result = detectReassignments(prev, numericIdToSlug, slugToNumericId);
    expect(result).toEqual([]);
  });

  it('detects when a slug gets a different numeric ID', () => {
    const prev = { entities: { E694: 'diversification' } };
    const numericIdToSlug = { E697: 'diversification' };
    const slugToNumericId = { diversification: 'E697' };

    const result = detectReassignments(prev, numericIdToSlug, slugToNumericId);
    expect(result).toContainEqual({
      type: 'slug-changed',
      slug: 'diversification',
      oldId: 'E694',
      newId: 'E697',
    });
  });

  it('detects when a numeric ID points to a different slug', () => {
    const prev = { entities: { E694: 'diversification', E697: 'other-page' } };
    const numericIdToSlug = { E694: 'other-page', E697: 'diversification' };
    const slugToNumericId = { 'other-page': 'E694', diversification: 'E697' };

    const result = detectReassignments(prev, numericIdToSlug, slugToNumericId);

    // Should detect that E694 changed from diversification to other-page
    expect(result).toContainEqual({
      type: 'id-changed',
      numId: 'E694',
      oldSlug: 'diversification',
      newSlug: 'other-page',
    });

    // And E697 changed from other-page to diversification
    expect(result).toContainEqual({
      type: 'id-changed',
      numId: 'E697',
      oldSlug: 'other-page',
      newSlug: 'diversification',
    });
  });

  it('does not flag IDs that are removed entirely (page-level IDs, intentional deletions)', () => {
    // The registry may contain page-level IDs that haven't been collected
    // at the entity level yet, or entities that were intentionally deleted.
    // These are NOT flagged as reassignments — other validation rules (entitylink-ids)
    // catch broken references to deleted entities.
    const prev = { entities: { E1: 'anthropic', E2: 'removed-entity' } };
    const numericIdToSlug = { E1: 'anthropic' };
    const slugToNumericId = { anthropic: 'E1' };

    const result = detectReassignments(prev, numericIdToSlug, slugToNumericId);
    expect(result).toEqual([]);
  });

  it('handles the PR #133 scenario: diversification E694 → E697', () => {
    // Simulates the exact bug from PR #133: diversification's numericId was
    // removed from source, and build-data assigned a new one (E697).
    // E694 is now unused, and diversification's slug still exists with E697.
    const prev = {
      entities: {
        E694: 'diversification',
        E695: 'some-entity',
        E696: 'another-entity',
      },
    };
    const numericIdToSlug = {
      E695: 'some-entity',
      E696: 'another-entity',
      E697: 'diversification',
    };
    const slugToNumericId = {
      'some-entity': 'E695',
      'another-entity': 'E696',
      diversification: 'E697',
    };

    const result = detectReassignments(prev, numericIdToSlug, slugToNumericId);

    // Should detect slug-changed: diversification went from E694 to E697
    expect(result.some(r =>
      r.type === 'slug-changed' &&
      r.slug === 'diversification' &&
      r.oldId === 'E694' &&
      r.newId === 'E697'
    )).toBe(true);

    // E694 is NOT flagged as id-removed because the slug 'diversification'
    // still exists (just with a different ID). The slug-changed detection
    // already covers this case — EntityLink refs using E694 would break.
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('detects multiple simultaneous reassignments', () => {
    const prev = {
      entities: {
        E1: 'alpha',
        E2: 'beta',
        E3: 'gamma',
      },
    };
    const numericIdToSlug = {
      E1: 'beta',    // swapped
      E2: 'alpha',   // swapped
      E3: 'gamma',   // unchanged
    };
    const slugToNumericId = {
      beta: 'E1',
      alpha: 'E2',
      gamma: 'E3',
    };

    const result = detectReassignments(prev, numericIdToSlug, slugToNumericId);

    // Should detect both slug-changed and id-changed for the swapped entities
    expect(result.length).toBeGreaterThanOrEqual(2);

    // alpha changed from E1 to E2
    expect(result.some(r => r.type === 'slug-changed' && r.slug === 'alpha')).toBe(true);
    // beta changed from E2 to E1
    expect(result.some(r => r.type === 'slug-changed' && r.slug === 'beta')).toBe(true);
  });
});

describe('formatReassignments', () => {
  it('formats slug-changed reassignments', () => {
    const reassignments = [
      { type: 'slug-changed', slug: 'diversification', oldId: 'E694', newId: 'E697' },
    ];
    const { lines, affectedIds } = formatReassignments(reassignments);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('diversification');
    expect(lines[0]).toContain('E694');
    expect(lines[0]).toContain('E697');
    expect(affectedIds.has('E694')).toBe(true);
  });

  it('formats id-changed reassignments', () => {
    const reassignments = [
      { type: 'id-changed', numId: 'E694', oldSlug: 'diversification', newSlug: 'other-page' },
    ];
    const { lines, affectedIds } = formatReassignments(reassignments);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('E694');
    expect(lines[0]).toContain('diversification');
    expect(lines[0]).toContain('other-page');
    expect(affectedIds.has('E694')).toBe(true);
  });

  it('collects all affected IDs from mixed reassignment types', () => {
    const reassignments = [
      { type: 'slug-changed', slug: 'alpha', oldId: 'E1', newId: 'E4' },
      { type: 'id-changed', numId: 'E2', oldSlug: 'beta', newSlug: 'gamma' },
    ];
    const { affectedIds } = formatReassignments(reassignments);

    expect(affectedIds.has('E1')).toBe(true);
    expect(affectedIds.has('E2')).toBe(true);
    expect(affectedIds.size).toBe(2);
  });
});

describe('scanEntityLinkRefs', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('returns empty array when directory does not exist', () => {
    const result = scanEntityLinkRefs('/nonexistent/path/that/does/not/exist', new Set(['E1']));
    expect(result).toEqual([]);
  });

  it('returns empty array when no matching IDs found in files', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'id-stability-test-'));
    writeFileSync(join(tmpDir, 'page.mdx'), `---
title: Test
---
<EntityLink id="E2">Some entity</EntityLink>
`);
    const result = scanEntityLinkRefs(tmpDir, new Set(['E999']));
    expect(result).toEqual([]);
  });

  it('finds EntityLink refs with matching IDs', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'id-stability-test-'));
    writeFileSync(join(tmpDir, 'page.mdx'), `---
title: Test
---
<EntityLink id="E694">Diversification</EntityLink>
`);
    const result = scanEntityLinkRefs(tmpDir, new Set(['E694']));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('E694');
    expect(result[0].line).toBe(4);
    expect(result[0].file).toContain('page.mdx');
  });

  it('finds multiple refs to the same ID across lines', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'id-stability-test-'));
    writeFileSync(join(tmpDir, 'page.mdx'), `---
title: Test
---
<EntityLink id="E694">First</EntityLink>
Some text.
<EntityLink id="E694">Second</EntityLink>
`);
    const result = scanEntityLinkRefs(tmpDir, new Set(['E694']));
    expect(result).toHaveLength(2);
    expect(result[0].line).toBe(4);
    expect(result[1].line).toBe(6);
  });

  it('finds refs to multiple different IDs', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'id-stability-test-'));
    writeFileSync(join(tmpDir, 'page.mdx'), `<EntityLink id="E1">A</EntityLink>
<EntityLink id="E2">B</EntityLink>
<EntityLink id="E3">C</EntityLink>
`);
    const result = scanEntityLinkRefs(tmpDir, new Set(['E1', 'E3']));
    expect(result).toHaveLength(2);
    expect(result.map(r => r.id).sort()).toEqual(['E1', 'E3']);
  });

  it('scans recursively through subdirectories', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'id-stability-test-'));
    const subDir = join(tmpDir, 'knowledge-base', 'risks');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'nested.mdx'), `<EntityLink id="E694">Deep</EntityLink>
`);
    const result = scanEntityLinkRefs(tmpDir, new Set(['E694']));
    expect(result).toHaveLength(1);
    expect(result[0].file).toContain('nested.mdx');
  });

  it('ignores non-MDX files', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'id-stability-test-'));
    writeFileSync(join(tmpDir, 'data.json'), '{"id": "E694"}');
    writeFileSync(join(tmpDir, 'readme.txt'), '<EntityLink id="E694">Test</EntityLink>');
    const result = scanEntityLinkRefs(tmpDir, new Set(['E694']));
    expect(result).toEqual([]);
  });

  it('matches .md files as well as .mdx', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'id-stability-test-'));
    writeFileSync(join(tmpDir, 'page.md'), `<EntityLink id="E10">Entity</EntityLink>
`);
    const result = scanEntityLinkRefs(tmpDir, new Set(['E10']));
    expect(result).toHaveLength(1);
    expect(result[0].file).toContain('page.md');
  });

  it('does not match IDs that appear in different attributes', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'id-stability-test-'));
    // This should NOT match because the id attribute value is E999, not E694
    writeFileSync(join(tmpDir, 'page.mdx'), `<EntityLink id="E999" data-old="E694">Test</EntityLink>
`);
    const result = scanEntityLinkRefs(tmpDir, new Set(['E694']));
    expect(result).toEqual([]);
  });
});
