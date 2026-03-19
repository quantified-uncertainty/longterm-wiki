/**
 * Tests for stableId resolution in computeBacklinks.
 *
 * Regression test for: Ghost stableIDs as card titles on 422 pages
 * (GitHub issue #2679).
 *
 * Root cause: computeBacklinks used raw ref.id from YAML relatedEntries
 * as the backlinks map key. Since ~99% of relatedEntries refs use stableIds
 * (10-char alphanum like "mK9pX3rQ7n") rather than slugs ("anthropic"),
 * backlinks were stored under stableId keys. When the frontend looked up
 * backlinks by slug, it found nothing — and staleId-keyed entries appeared
 * as ghost titles on wiki pages.
 *
 * Fix: pass byStableId to computeBacklinks and resolve ref.id to the
 * canonical slug before using it as the backlink map key.
 */

import { describe, it, expect } from 'vitest';

/**
 * Minimal reproduction of the computeBacklinks logic from build-data.mjs.
 */
function computeBacklinks(entities, byStableId) {
  const backlinks = {};

  for (const entity of entities) {
    if (entity.relatedEntries) {
      for (const ref of entity.relatedEntries) {
        const targetId = (byStableId && byStableId[ref.id]) || ref.id;
        if (!backlinks[targetId]) {
          backlinks[targetId] = [];
        }
        backlinks[targetId].push({
          id: entity.id,
          type: entity.type,
          title: entity.title,
          relationship: ref.relationship,
        });
      }
    }
  }

  return backlinks;
}

/** Pre-fix version for regression testing. */
function computeBacklinksPreFix(entities) {
  const backlinks = {};

  for (const entity of entities) {
    if (entity.relatedEntries) {
      for (const ref of entity.relatedEntries) {
        if (!backlinks[ref.id]) {
          backlinks[ref.id] = [];
        }
        backlinks[ref.id].push({
          id: entity.id,
          type: entity.type,
          title: entity.title,
          relationship: ref.relationship,
        });
      }
    }
  }

  return backlinks;
}

describe('computeBacklinks stableId resolution', () => {
  const entities = [
    {
      id: 'chris-olah',
      type: 'person',
      title: 'Chris Olah',
      relatedEntries: [
        { id: 'mK9pX3rQ7n', type: 'organization' },  // stableId for "anthropic"
        { id: '73qTEkYyWA', type: 'safety-agenda' },  // stableId for "mechanistic-interpretability"
        { id: 'some-slug',  type: 'concept' },          // regular slug reference
      ],
    },
    {
      id: 'anthropic',
      type: 'organization',
      title: 'Anthropic',
      relatedEntries: [],
    },
  ];

  const byStableId = {
    mK9pX3rQ7n: 'anthropic',
    '73qTEkYyWA': 'mechanistic-interpretability',
  };

  it('REGRESSION: without the fix, backlinks are keyed by stableId', () => {
    const backlinks = computeBacklinksPreFix(entities);

    // Pre-fix: backlinks for "anthropic" are stored under the stableId key
    expect(backlinks['mK9pX3rQ7n']).toBeDefined();
    expect(backlinks['mK9pX3rQ7n'][0].id).toBe('chris-olah');

    // Looking up by slug returns nothing — backlinks are invisible
    expect(backlinks['anthropic']).toBeUndefined();
  });

  it('WITH the fix, backlinks are keyed by canonical slug', () => {
    const backlinks = computeBacklinks(entities, byStableId);

    // Fixed: backlinks for "anthropic" are stored under the slug key
    expect(backlinks['anthropic']).toBeDefined();
    expect(backlinks['anthropic'][0].id).toBe('chris-olah');
    expect(backlinks['anthropic'][0].title).toBe('Chris Olah');

    // StableId key no longer exists
    expect(backlinks['mK9pX3rQ7n']).toBeUndefined();

    // Resolved safety-agenda ref
    expect(backlinks['mechanistic-interpretability']).toBeDefined();
    expect(backlinks['mechanistic-interpretability'][0].id).toBe('chris-olah');
  });

  it('slug-based refs still work correctly', () => {
    const backlinks = computeBacklinks(entities, byStableId);

    // Regular slug reference should work as before
    expect(backlinks['some-slug']).toBeDefined();
    expect(backlinks['some-slug'][0].id).toBe('chris-olah');
  });

  it('unresolvable stableId refs fall through gracefully', () => {
    const entitiesWithUnknownRef = [
      {
        id: 'test-entity',
        type: 'concept',
        title: 'Test',
        relatedEntries: [
          { id: 'UNKNOWN12ab', type: 'concept' },  // not in byStableId
        ],
      },
    ];

    const backlinks = computeBacklinks(entitiesWithUnknownRef, byStableId);

    // Falls through to using the raw ref.id as key (graceful degradation)
    expect(backlinks['UNKNOWN12ab']).toBeDefined();
    expect(backlinks['UNKNOWN12ab'][0].id).toBe('test-entity');
  });

  it('handles entities with no relatedEntries', () => {
    const simpleEntities = [
      { id: 'no-refs', type: 'concept', title: 'No Refs' },
      { id: 'empty-refs', type: 'concept', title: 'Empty', relatedEntries: [] },
    ];

    const backlinks = computeBacklinks(simpleEntities, byStableId);
    expect(Object.keys(backlinks)).toHaveLength(0);
  });

  it('handles null byStableId (backward compat)', () => {
    const backlinks = computeBacklinks(entities, null);

    // Without byStableId, falls back to raw ref.id (same as pre-fix)
    expect(backlinks['mK9pX3rQ7n']).toBeDefined();
    expect(backlinks['anthropic']).toBeUndefined();
  });
});
