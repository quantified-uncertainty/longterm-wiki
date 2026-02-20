/**
 * Tests for ID assignment utilities (id-assignment.mjs)
 *
 * Tests the core pure functions used by assign-ids.mjs and build-data.mjs
 * to compute numeric ID maps and determine which entities/pages need IDs.
 */

import { describe, it, expect } from 'vitest';
import { buildIdMaps, computeNextId, filterEligiblePages } from '../id-assignment.mjs';

// ---------------------------------------------------------------------------
// buildIdMaps
// ---------------------------------------------------------------------------

describe('buildIdMaps', () => {
  it('returns empty maps for empty entity array', () => {
    const { numericIdToSlug, slugToNumericId, conflicts } = buildIdMaps([]);
    expect(numericIdToSlug).toEqual({});
    expect(slugToNumericId).toEqual({});
    expect(conflicts).toHaveLength(0);
  });

  it('skips entities without numericId', () => {
    const entities = [
      { id: 'anthropic' },
      { id: 'openai' },
    ];
    const { numericIdToSlug, slugToNumericId, conflicts } = buildIdMaps(entities);
    expect(Object.keys(numericIdToSlug)).toHaveLength(0);
    expect(Object.keys(slugToNumericId)).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
  });

  it('builds correct maps from entities with numericIds', () => {
    const entities = [
      { id: 'anthropic', numericId: 'E1' },
      { id: 'openai', numericId: 'E2' },
      { id: 'deepmind', numericId: 'E5' },
    ];
    const { numericIdToSlug, slugToNumericId } = buildIdMaps(entities);

    expect(numericIdToSlug).toEqual({ E1: 'anthropic', E2: 'openai', E5: 'deepmind' });
    expect(slugToNumericId).toEqual({ anthropic: 'E1', openai: 'E2', deepmind: 'E5' });
  });

  it('handles mix of entities with and without numericIds', () => {
    const entities = [
      { id: 'anthropic', numericId: 'E1' },
      { id: 'openai' },                     // no numericId
      { id: 'deepmind', numericId: 'E3' },
    ];
    const { numericIdToSlug, slugToNumericId, conflicts } = buildIdMaps(entities);

    expect(Object.keys(numericIdToSlug)).toHaveLength(2);
    expect(slugToNumericId['anthropic']).toBe('E1');
    expect(slugToNumericId['openai']).toBeUndefined();
    expect(slugToNumericId['deepmind']).toBe('E3');
    expect(conflicts).toHaveLength(0);
  });

  it('detects conflict when two entities claim the same numericId', () => {
    const entities = [
      { id: 'anthropic', numericId: 'E1' },
      { id: 'openai', numericId: 'E1' },   // duplicate!
    ];
    const { conflicts } = buildIdMaps(entities);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('E1');
    expect(conflicts[0]).toContain('anthropic');
    expect(conflicts[0]).toContain('openai');
  });

  it('does not conflict when same entity appears twice (same id and numericId)', () => {
    const entities = [
      { id: 'anthropic', numericId: 'E1' },
      { id: 'anthropic', numericId: 'E1' }, // duplicate entry, same data
    ];
    const { conflicts } = buildIdMaps(entities);
    // Same entity — no conflict
    expect(conflicts).toHaveLength(0);
  });

  it('detects multiple independent conflicts', () => {
    const entities = [
      { id: 'a', numericId: 'E1' },
      { id: 'b', numericId: 'E1' },  // conflict #1
      { id: 'c', numericId: 'E2' },
      { id: 'd', numericId: 'E2' },  // conflict #2
    ];
    const { conflicts } = buildIdMaps(entities);
    expect(conflicts).toHaveLength(2);
  });

  it('keeps first entity when conflict — second entity is NOT added to maps', () => {
    const entities = [
      { id: 'original', numericId: 'E1' },
      { id: 'interloper', numericId: 'E1' },
    ];
    const { numericIdToSlug, slugToNumericId } = buildIdMaps(entities);

    // First entity wins
    expect(numericIdToSlug['E1']).toBe('original');
    expect(slugToNumericId['original']).toBe('E1');
    // Interloper is not added
    expect(slugToNumericId['interloper']).toBeUndefined();
  });

  it('handles numericId: null/undefined gracefully', () => {
    const entities = [
      { id: 'a', numericId: null },
      { id: 'b', numericId: undefined },
      { id: 'c', numericId: 'E1' },
    ];
    const { numericIdToSlug, slugToNumericId, conflicts } = buildIdMaps(entities);
    expect(Object.keys(numericIdToSlug)).toHaveLength(1);
    expect(numericIdToSlug['E1']).toBe('c');
    expect(conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeNextId
// ---------------------------------------------------------------------------

describe('computeNextId', () => {
  it('returns 1 for empty map', () => {
    expect(computeNextId({})).toBe(1);
  });

  it('returns 2 when only E1 is taken', () => {
    expect(computeNextId({ E1: 'anthropic' })).toBe(2);
  });

  it('returns next after the highest existing ID', () => {
    const map = { E1: 'a', E2: 'b', E5: 'c', E10: 'd' };
    expect(computeNextId(map)).toBe(11);
  });

  it('handles non-contiguous IDs — gaps are NOT filled', () => {
    // Gap filling would be fragile; we always extend past the max
    const map = { E1: 'a', E100: 'b' };
    expect(computeNextId(map)).toBe(101);
  });

  it('factors in additionalReserved IDs', () => {
    const map = { E1: 'a', E2: 'b' };
    const reserved = ['E5', 'E10'];
    expect(computeNextId(map, reserved)).toBe(11);
  });

  it('additionalReserved alone works when map is empty', () => {
    expect(computeNextId({}, ['E50'])).toBe(51);
  });

  it('additionalReserved below existing max has no effect', () => {
    const map = { E100: 'a' };
    const reserved = ['E5', 'E10']; // below max E100
    expect(computeNextId(map, reserved)).toBe(101);
  });

  it('handles single-digit IDs correctly', () => {
    const map = { E1: 'a' };
    expect(computeNextId(map)).toBe(2);
  });

  it('handles large IDs without overflow', () => {
    const map = { E999: 'a' };
    expect(computeNextId(map)).toBe(1000);
  });

  it('ignores malformed keys that are not valid E### format', () => {
    // Should not throw; malformed keys return NaN from parseInt and are skipped
    const map = { E1: 'a', notAnId: 'b', E: 'c' };
    // E1 is valid → nextId should be 2
    expect(computeNextId(map)).toBe(2);
  });

  it('accepts Set as additionalReserved (iterable)', () => {
    const map = { E1: 'a' };
    const reserved = new Set(['E3', 'E7']);
    expect(computeNextId(map, reserved)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// filterEligiblePages
// ---------------------------------------------------------------------------

describe('filterEligiblePages', () => {
  const SKIP_CATEGORIES = new Set(['style-guides', 'tools', 'dashboard', 'project', 'guides']);

  function makePage(id, category = 'knowledge-base', contentFormat = 'article') {
    return { id, category, contentFormat };
  }

  it('returns all pages when no entities or categories match', () => {
    const pages = [
      makePage('ai-risks'),
      makePage('alignment-research'),
    ];
    const result = filterEligiblePages(pages, new Set(), SKIP_CATEGORIES);
    expect(result).toHaveLength(2);
  });

  it('excludes pages whose id matches an entity id', () => {
    const pages = [
      makePage('anthropic'),        // has entity
      makePage('ai-safety-intro'),  // no entity
    ];
    const entityIds = new Set(['anthropic']);
    const result = filterEligiblePages(pages, entityIds, SKIP_CATEGORIES);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ai-safety-intro');
  });

  it('excludes pages in skip categories', () => {
    const pages = [
      makePage('tags', 'tools'),
      makePage('getting-started-guide', 'guides'),
      makePage('ai-risks', 'knowledge-base'),
    ];
    const result = filterEligiblePages(pages, new Set(), SKIP_CATEGORIES);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ai-risks');
  });

  it('excludes pages with dashboard contentFormat', () => {
    const pages = [
      makePage('metrics-dash', 'knowledge-base', 'dashboard'),
      makePage('ai-risks', 'knowledge-base', 'article'),
    ];
    const result = filterEligiblePages(pages, new Set(), SKIP_CATEGORIES);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ai-risks');
  });

  it('applies all three filters together', () => {
    const pages = [
      makePage('anthropic', 'knowledge-base'),        // entity match → excluded
      makePage('tags', 'tools'),                     // skip category → excluded
      makePage('dash', 'knowledge-base', 'dashboard'), // dashboard format → excluded
      makePage('ai-risks', 'knowledge-base'),          // eligible
    ];
    const result = filterEligiblePages(pages, new Set(['anthropic']), SKIP_CATEGORIES);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ai-risks');
  });

  it('returns empty array when all pages are excluded', () => {
    const pages = [
      makePage('tags', 'tools'),
      makePage('anthropic', 'knowledge-base'),
    ];
    const result = filterEligiblePages(pages, new Set(['anthropic']), SKIP_CATEGORIES);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(filterEligiblePages([], new Set(), SKIP_CATEGORIES)).toHaveLength(0);
  });

  it('does not mutate the input pages array', () => {
    const pages = [makePage('ai-risks'), makePage('tags', 'tools')];
    const originalLength = pages.length;
    filterEligiblePages(pages, new Set(), SKIP_CATEGORIES);
    expect(pages).toHaveLength(originalLength);
  });

  it('index pages with __index__ prefix can be eligible', () => {
    // Index pages use __index__/knowledge-base style IDs
    const pages = [makePage('__index__/knowledge-base', 'knowledge-base')];
    const result = filterEligiblePages(pages, new Set(), SKIP_CATEGORIES);
    expect(result).toHaveLength(1);
  });

  it('index pages in skip categories are excluded', () => {
    const pages = [makePage('__index__/browse', 'tools')];
    const result = filterEligiblePages(pages, new Set(), SKIP_CATEGORIES);
    expect(result).toHaveLength(0);
  });
});
