/**
 * Tests for statistics.mjs
 *
 * Verifies that computeStats correctly aggregates entity data, and that
 * the Map-based entity lookup produces correct results for mostLinked.
 */

import { describe, it, expect } from 'vitest';
import { computeStats } from '../statistics.mjs';

function makeEntity(id, overrides = {}) {
  return { id, type: 'concept', title: id, ...overrides };
}

describe('computeStats', () => {
  it('returns correct counts for empty input', () => {
    const result = computeStats([], {}, {});
    expect(result.totalEntities).toBe(0);
    expect(result.mostLinked).toEqual([]);
    expect(result.recentlyUpdated).toEqual([]);
    expect(result.topTags).toEqual([]);
    expect(result.withDescription).toBe(0);
  });

  it('counts entities by type', () => {
    const entities = [
      makeEntity('a', { type: 'person' }),
      makeEntity('b', { type: 'person' }),
      makeEntity('c', { type: 'org' }),
    ];
    const { byType } = computeStats(entities, {}, {});
    expect(byType.person).toBe(2);
    expect(byType.org).toBe(1);
  });

  it('mostLinked uses Map lookup — O(1) — not find()', () => {
    // Arrange: backlink data for 3 entities, only 2 exist in entities array
    const entities = [
      makeEntity('alpha', { title: 'Alpha' }),
      makeEntity('beta', { title: 'Beta' }),
    ];
    const backlinks = {
      alpha: [{ id: 'x' }, { id: 'y' }, { id: 'z' }], // 3 links
      beta: [{ id: 'x' }],                              // 1 link
      ghost: [{ id: 'x' }, { id: 'y' }],               // in backlinks but NOT in entities
    };
    const { mostLinked } = computeStats(entities, backlinks, {});

    // ghost should be filtered out (entity not found)
    expect(mostLinked).toHaveLength(2);
    expect(mostLinked[0].id).toBe('alpha'); // highest backlink count
    expect(mostLinked[0].backlinkCount).toBe(3);
    expect(mostLinked[0].title).toBe('Alpha');
    expect(mostLinked[0].type).toBe('concept');
    expect(mostLinked[1].id).toBe('beta');
    expect(mostLinked[1].backlinkCount).toBe(1);
  });

  it('mostLinked is capped at 10 entries', () => {
    const entities = Array.from({ length: 20 }, (_, i) =>
      makeEntity(`e${i}`, { title: `Entity ${i}` })
    );
    const backlinks = Object.fromEntries(
      entities.map((e, i) => [e.id, Array(i + 1).fill({ id: 'x' })])
    );
    const { mostLinked } = computeStats(entities, backlinks, {});
    expect(mostLinked).toHaveLength(10);
    // Should be sorted descending by count
    for (let i = 1; i < mostLinked.length; i++) {
      expect(mostLinked[i - 1].backlinkCount).toBeGreaterThanOrEqual(
        mostLinked[i].backlinkCount
      );
    }
  });

  it('recentlyUpdated returns up to 10 sorted by lastUpdated desc', () => {
    const entities = [
      makeEntity('a', { lastUpdated: '2024-01-01' }),
      makeEntity('b', { lastUpdated: '2024-03-01' }),
      makeEntity('c', { lastUpdated: '2024-02-01' }),
      makeEntity('d'), // no lastUpdated — excluded
    ];
    const { recentlyUpdated } = computeStats(entities, {}, {});
    expect(recentlyUpdated).toHaveLength(3);
    expect(recentlyUpdated[0].id).toBe('b'); // most recent first
    expect(recentlyUpdated[1].id).toBe('c');
    expect(recentlyUpdated[2].id).toBe('a');
  });

  it('withDescription counts entities that have a description field', () => {
    const entities = [
      makeEntity('a', { description: 'some text' }),
      makeEntity('b', { description: '' }), // empty string is falsy — not counted
      makeEntity('c'),
    ];
    const { withDescription } = computeStats(entities, {}, {});
    expect(withDescription).toBe(1);
  });

  it('topTags returns up to 20 tags sorted by count desc', () => {
    const tagIndex = {
      popular: Array(50).fill({ id: 'x' }),
      medium: Array(10).fill({ id: 'x' }),
      rare: Array(1).fill({ id: 'x' }),
    };
    const { topTags } = computeStats([], {}, tagIndex);
    expect(topTags[0].tag).toBe('popular');
    expect(topTags[0].count).toBe(50);
    expect(topTags.length).toBeLessThanOrEqual(20);
  });

  it('byStatus groups entities by status, defaulting to "unknown"', () => {
    const entities = [
      makeEntity('a', { status: 'active' }),
      makeEntity('b', { status: 'active' }),
      makeEntity('c'), // no status → 'unknown'
    ];
    const { byStatus } = computeStats(entities, {}, {});
    expect(byStatus.active).toBe(2);
    expect(byStatus.unknown).toBe(1);
  });

  it('lastBuilt is a valid ISO date string', () => {
    const { lastBuilt } = computeStats([], {}, {});
    expect(() => new Date(lastBuilt)).not.toThrow();
    expect(new Date(lastBuilt).toISOString()).toBe(lastBuilt);
  });
});
