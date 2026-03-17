/**
 * Tests for ID assignment utilities (id-assignment.mjs)
 *
 * Tests the core pure functions used by assign-ids.mjs and build-data.mjs
 * to compute wiki ID maps and determine which entities/pages need IDs.
 */

import { describe, it, expect } from 'vitest';
import { buildIdMaps, filterEligiblePages } from '../id-assignment.mjs';

// ---------------------------------------------------------------------------
// buildIdMaps
// ---------------------------------------------------------------------------

describe('buildIdMaps', () => {
  it('returns empty maps for empty entity array', () => {
    const { wikiIdToSlug, slugToWikiId, conflicts } = buildIdMaps([]);
    expect(wikiIdToSlug).toEqual({});
    expect(slugToWikiId).toEqual({});
    expect(conflicts).toHaveLength(0);
  });

  it('skips entities without wikiId', () => {
    const entities = [
      { id: 'anthropic' },
      { id: 'openai' },
    ];
    const { wikiIdToSlug, slugToWikiId, conflicts } = buildIdMaps(entities);
    expect(Object.keys(wikiIdToSlug)).toHaveLength(0);
    expect(Object.keys(slugToWikiId)).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
  });

  it('builds correct maps from entities with wikiIds', () => {
    const entities = [
      { id: 'anthropic', wikiId: 'E1' },
      { id: 'openai', wikiId: 'E2' },
      { id: 'deepmind', wikiId: 'E5' },
    ];
    const { wikiIdToSlug, slugToWikiId } = buildIdMaps(entities);

    expect(wikiIdToSlug).toEqual({ E1: 'anthropic', E2: 'openai', E5: 'deepmind' });
    expect(slugToWikiId).toEqual({ anthropic: 'E1', openai: 'E2', deepmind: 'E5' });
  });

  it('handles mix of entities with and without wikiIds', () => {
    const entities = [
      { id: 'anthropic', wikiId: 'E1' },
      { id: 'openai' },                     // no wikiId
      { id: 'deepmind', wikiId: 'E3' },
    ];
    const { wikiIdToSlug, slugToWikiId, conflicts } = buildIdMaps(entities);

    expect(Object.keys(wikiIdToSlug)).toHaveLength(2);
    expect(slugToWikiId['anthropic']).toBe('E1');
    expect(slugToWikiId['openai']).toBeUndefined();
    expect(slugToWikiId['deepmind']).toBe('E3');
    expect(conflicts).toHaveLength(0);
  });

  it('detects conflict when two entities claim the same wikiId', () => {
    const entities = [
      { id: 'anthropic', wikiId: 'E1' },
      { id: 'openai', wikiId: 'E1' },   // duplicate!
    ];
    const { conflicts } = buildIdMaps(entities);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('E1');
    expect(conflicts[0]).toContain('anthropic');
    expect(conflicts[0]).toContain('openai');
  });

  it('does not conflict when same entity appears twice (same id and wikiId)', () => {
    const entities = [
      { id: 'anthropic', wikiId: 'E1' },
      { id: 'anthropic', wikiId: 'E1' }, // duplicate entry, same data
    ];
    const { conflicts } = buildIdMaps(entities);
    // Same entity — no conflict
    expect(conflicts).toHaveLength(0);
  });

  it('detects multiple independent conflicts', () => {
    const entities = [
      { id: 'a', wikiId: 'E1' },
      { id: 'b', wikiId: 'E1' },  // conflict #1
      { id: 'c', wikiId: 'E2' },
      { id: 'd', wikiId: 'E2' },  // conflict #2
    ];
    const { conflicts } = buildIdMaps(entities);
    expect(conflicts).toHaveLength(2);
  });

  it('keeps first entity when conflict — second entity is NOT added to maps', () => {
    const entities = [
      { id: 'original', wikiId: 'E1' },
      { id: 'interloper', wikiId: 'E1' },
    ];
    const { wikiIdToSlug, slugToWikiId } = buildIdMaps(entities);

    // First entity wins
    expect(wikiIdToSlug['E1']).toBe('original');
    expect(slugToWikiId['original']).toBe('E1');
    // Interloper is not added
    expect(slugToWikiId['interloper']).toBeUndefined();
  });

  it('handles wikiId: null/undefined gracefully', () => {
    const entities = [
      { id: 'a', wikiId: null },
      { id: 'b', wikiId: undefined },
      { id: 'c', wikiId: 'E1' },
    ];
    const { wikiIdToSlug, slugToWikiId, conflicts } = buildIdMaps(entities);
    expect(Object.keys(wikiIdToSlug)).toHaveLength(1);
    expect(wikiIdToSlug['E1']).toBe('c');
    expect(conflicts).toHaveLength(0);
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
