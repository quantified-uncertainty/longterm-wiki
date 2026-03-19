/**
 * Tests for stableId resolution in the relatedGraph computation.
 *
 * Regression test for: Ghost entity IDs rendered as card titles on approach
 * detail pages (GitHub issue #2637).
 *
 * Root cause: YAML relatedEntries reference entities by stableId (e.g.
 * "ULjDXpSLCI") rather than slug (e.g. "coefficient-giving"). The entityMap
 * in computeRelatedGraph was only keyed by slug, so lookups by stableId
 * failed and the raw stableId fell through to `title: e?.title || targetId`.
 *
 * Fix: pass byStableId to computeRelatedGraph and resolve stableIds to slugs
 * before creating graph edges, so the entityMap.get(targetId) lookup works.
 */

import { describe, it, expect } from 'vitest';

/**
 * Minimal reproduction of the relatedGraph stableId resolution logic.
 * Mirrors the fix applied to computeRelatedGraph in build-data.mjs.
 */
function buildRelatedGraphEntries(entities, relatedEntries, byStableId) {
  // Build entityMap keyed by slug (the pre-fix behaviour used only this)
  const entityMap = new Map(entities.map(e => [e.id, e]));
  // Post-fix: also index by stableId
  if (byStableId) {
    for (const entity of entities) {
      if (entity.stableId) {
        entityMap.set(entity.stableId, entity);
      }
    }
  }

  function resolveRefId(id) {
    if (byStableId && byStableId[id]) return byStableId[id];
    return id;
  }

  const results = [];
  for (const ref of relatedEntries) {
    const resolvedId = resolveRefId(ref.id);
    const e = entityMap.get(resolvedId);
    results.push({
      id: resolvedId,
      title: e?.title || resolvedId,  // The bug: raw stableId appeared here
      type: e?.type || 'concept',
    });
  }
  return results;
}

describe('relatedGraph stableId resolution', () => {
  const entities = [
    { id: 'coefficient-giving', stableId: 'ULjDXpSLCI', type: 'organization', title: 'Coefficient Giving' },
    { id: 'export-controls',    stableId: 'SpFgTz2INg', type: 'policy',       title: 'US AI Chip Export Controls' },
    { id: 'slug-only-entity',                           type: 'approach',      title: 'Slug-Only Entity' },
  ];

  const byStableId = {
    ULjDXpSLCI: 'coefficient-giving',
    SpFgTz2INg: 'export-controls',
  };

  it('REGRESSION: without the fix, stableId refs produce raw IDs as titles', () => {
    // Simulate pre-fix behaviour (no byStableId passed, entityMap only keyed by slug)
    const prefixResults = buildRelatedGraphEntries(
      entities,
      [{ id: 'ULjDXpSLCI' }, { id: 'SpFgTz2INg' }],
      null  // null = pre-fix: no stableId resolution
    );
    // Pre-fix: title falls back to raw stableId
    expect(prefixResults[0].title).toBe('ULjDXpSLCI');
    expect(prefixResults[1].title).toBe('SpFgTz2INg');
  });

  it('WITH the fix, stableId refs resolve to the correct entity title', () => {
    const results = buildRelatedGraphEntries(
      entities,
      [{ id: 'ULjDXpSLCI' }, { id: 'SpFgTz2INg' }],
      byStableId
    );
    expect(results[0].id).toBe('coefficient-giving');
    expect(results[0].title).toBe('Coefficient Giving');
    expect(results[1].id).toBe('export-controls');
    expect(results[1].title).toBe('US AI Chip Export Controls');
  });

  it('slug-based refs (normal case) still work correctly', () => {
    const results = buildRelatedGraphEntries(
      entities,
      [{ id: 'slug-only-entity' }],
      byStableId
    );
    expect(results[0].id).toBe('slug-only-entity');
    expect(results[0].title).toBe('Slug-Only Entity');
  });

  it('missing entity refs fall back gracefully (no crash)', () => {
    const results = buildRelatedGraphEntries(
      entities,
      [{ id: 'nonexistent-entity' }],
      byStableId
    );
    // Should fall back to the ID, not crash
    expect(results[0].id).toBe('nonexistent-entity');
    expect(results[0].title).toBe('nonexistent-entity');
    expect(results[0].type).toBe('concept');
  });

  it('empty relatedEntries produces empty output', () => {
    const results = buildRelatedGraphEntries(entities, [], byStableId);
    expect(results).toHaveLength(0);
  });
});
