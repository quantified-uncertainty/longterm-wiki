/**
 * Tests for id-registry.mjs extracted module
 */

import { describe, it, expect } from 'vitest';
import { buildIdRegistry, extendIdRegistryWithPages } from '../id-registry.mjs';

describe('buildIdRegistry', () => {
  it('maps slugs to wiki IDs', () => {
    const entities = [
      { id: 'anthropic', wikiId: 'E1' },
      { id: 'openai', wikiId: 'E2' },
    ];
    const result = buildIdRegistry(entities);
    expect(result.slugToWikiId['anthropic']).toBe('E1');
    expect(result.wikiIdToSlug['E1']).toBe('anthropic');
    expect(result.nextId).toBe(3);
  });

  it('assigns fallback IDs to entities without wikiId', () => {
    const entities = [
      { id: 'entity-a', wikiId: 'E5' },
      { id: 'entity-b' }, // no wikiId
    ];
    const result = buildIdRegistry(entities);
    expect(result.slugToWikiId['entity-b']).toBe('E6');
    expect(result.wikiIdToSlug['E6']).toBe('entity-b');
    expect(entities[1].wikiId).toBe('E6'); // mutates in-place
  });

  it('finds next available ID correctly', () => {
    const entities = [
      { id: 'a', wikiId: 'E100' },
      { id: 'b', wikiId: 'E50' },
    ];
    const result = buildIdRegistry(entities);
    expect(result.nextId).toBe(101);
  });

  it('pre-seeds wikiIds from the persistent id_registry (QUA-521)', () => {
    const entities = [
      { id: 'anthropic' }, // no wikiId; should be recovered from persistent map
      { id: 'openai', wikiId: 'E2' },
    ];
    const persisted = new Map([
      ['anthropic', 'E42'],
      ['unrelated', 'E99'],
    ]);
    const result = buildIdRegistry(entities, new Set(), {
      persistedSlugToWikiId: persisted,
    });
    expect(result.slugToWikiId['anthropic']).toBe('E42');
    expect(entities[0].wikiId).toBe('E42');
    // nextId advances past E42
    expect(result.nextId).toBe(43);
  });

  it('fallback allocation preserves input order (QUA-521)', () => {
    // The fallback allocator iterates entities in input order. This matters
    // because MDX content references specific E-numbers minted by this
    // ordering (e.g. `<EntityLink id="E2886" name="baidu">`); reordering
    // would renumber those entities and break deployed content refs.
    //
    // Cross-pipeline determinism (the QUA-521 symptom where YAML and PG
    // pipelines produced different E-numbers for the same slug) is achieved
    // via the persistent-registry pre-seed, NOT via sorting. See the
    // persistent-pre-seed tests below.
    const entities = [
      { id: 'b' },
      { id: 'a' },
      { id: 'c' },
    ];
    const result = buildIdRegistry(entities);
    // Input order: b=E1, a=E2, c=E3
    expect(result.slugToWikiId.b).toBe('E1');
    expect(result.slugToWikiId.a).toBe('E2');
    expect(result.slugToWikiId.c).toBe('E3');
  });

  it('persistent pre-seed produces identical IDs across input orderings (QUA-521)', () => {
    // This is the real QUA-521 fix: when both pipelines consult the same
    // persistent registry, they produce the same IDs regardless of input
    // iteration order.
    const persisted = { a: 'E10', b: 'E20', c: 'E30' };
    const orderA = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
    const orderB = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    const rA = buildIdRegistry(orderA, new Set(), { persistedSlugToWikiId: persisted });
    const rB = buildIdRegistry(orderB, new Set(), { persistedSlugToWikiId: persisted });
    expect(rA.slugToWikiId).toEqual(rB.slugToWikiId);
    expect(rA.slugToWikiId.a).toBe('E10');
    expect(rA.slugToWikiId.b).toBe('E20');
    expect(rA.slugToWikiId.c).toBe('E30');
  });

  it('persistent pre-seed takes precedence over fallback allocation', () => {
    const entities = [{ id: 'a' }, { id: 'b' }];
    const persisted = { a: 'E500' };
    const result = buildIdRegistry(entities, new Set(), {
      persistedSlugToWikiId: persisted,
    });
    expect(result.slugToWikiId.a).toBe('E500');
    // b still needs fallback; nextId starts at 501 after a recovered E500
    expect(result.slugToWikiId.b).toBe('E501');
  });

  it('flags drift when input wikiId disagrees with persistent registry', () => {
    // If the input row carries a denormalized wikiId that disagrees with
    // the authoritative entity_ids mapping, the registry must fail loudly
    // rather than silently letting the stale value win.
    const entities = [{ id: 'a', wikiId: 'E1' }];
    const persisted = { a: 'E2' };
    const origExit = process.exit;
    const origError = console.error;
    let exitCode = null;
    const errLines = [];
    process.exit = (code) => { exitCode = code; throw new Error('__exit__'); };
    console.error = (msg) => { errLines.push(msg); };
    try {
      expect(() =>
        buildIdRegistry(entities, new Set(), { persistedSlugToWikiId: persisted })
      ).toThrow('__exit__');
      expect(exitCode).toBe(1);
      expect(errLines.join('\n')).toContain('input wikiId E1');
      expect(errLines.join('\n')).toContain('persisted registry says E2');
    } finally {
      process.exit = origExit;
      console.error = origError;
    }
  });

  it('no-op when input wikiId matches persistent registry', () => {
    const entities = [{ id: 'a', wikiId: 'E42' }];
    const persisted = { a: 'E42' };
    const result = buildIdRegistry(entities, new Set(), {
      persistedSlugToWikiId: persisted,
    });
    expect(result.slugToWikiId.a).toBe('E42');
  });

  it('accepts a plain object for persistedSlugToWikiId', () => {
    const entities = [{ id: 'a' }];
    const result = buildIdRegistry(entities, new Set(), {
      persistedSlugToWikiId: { a: 'E7' },
    });
    expect(result.slugToWikiId.a).toBe('E7');
  });
});

describe('extendIdRegistryWithPages', () => {
  it('assigns IDs to pages without entities', () => {
    const pages = [
      { id: 'page-one', category: 'knowledge-base' },
    ];
    const entityIds = new Set();
    const slugToWikiId = {};
    const wikiIdToSlug = {};
    const pathRegistry = {};

    const result = extendIdRegistryWithPages({
      pages, entityIds, slugToWikiId, wikiIdToSlug, pathRegistry, nextId: 1,
    });

    expect(result.pageIdAssignments).toBe(1);
    expect(slugToWikiId['page-one']).toBe('E1');
    expect(pages[0].wikiId).toBe('E1');
  });

  it('skips pages that already have an entity', () => {
    const pages = [
      { id: 'existing-entity', category: 'knowledge-base' },
    ];
    const entityIds = new Set(['existing-entity']);
    const slugToWikiId = { 'existing-entity': 'E5' };
    const wikiIdToSlug = { 'E5': 'existing-entity' };

    const result = extendIdRegistryWithPages({
      pages, entityIds, slugToWikiId, wikiIdToSlug, pathRegistry: {}, nextId: 6,
    });

    expect(result.pageIdAssignments).toBe(0);
  });

  it('skips infrastructure categories', () => {
    const pages = [
      { id: 'my-tool', category: 'tools' },
      { id: 'my-guide', category: 'guides' },
    ];
    const result = extendIdRegistryWithPages({
      pages, entityIds: new Set(), slugToWikiId: {}, wikiIdToSlug: {}, pathRegistry: {}, nextId: 1,
    });

    expect(result.pageIdAssignments).toBe(0);
  });

  it('skips dashboard content format', () => {
    const pages = [
      { id: 'my-dash', category: 'knowledge-base', contentFormat: 'dashboard' },
    ];
    const result = extendIdRegistryWithPages({
      pages, entityIds: new Set(), slugToWikiId: {}, wikiIdToSlug: {}, pathRegistry: {}, nextId: 1,
    });

    expect(result.pageIdAssignments).toBe(0);
  });

  it('skips wikiIds already claimed when advancing the fallback counter', () => {
    // If a page was already assigned E5 in pass 1 (frontmatter), pass 2b
    // must not redundantly assign E5 to the next needy page. Previously
    // the loop blindly used `E${nextId}` which could collide with any ID
    // already in wikiIdToSlug.
    const pages = [
      { id: 'needy-page', category: 'knowledge-base' },
    ];
    // nextId starts at 5, but E5, E6, E7 are already claimed by pages
    // (simulating a wider registry with scattered claimed IDs).
    const slugToWikiId = { 'other-page-5': 'E5', 'other-page-6': 'E6', 'other-page-7': 'E7' };
    const wikiIdToSlug = {
      'E5': 'other-page-5',
      'E6': 'other-page-6',
      'E7': 'other-page-7',
    };
    const result = extendIdRegistryWithPages({
      pages, entityIds: new Set(), slugToWikiId, wikiIdToSlug,
      pathRegistry: {}, nextId: 5,
    });
    // Should skip E5, E6, E7 and land on E8
    expect(slugToWikiId['needy-page']).toBe('E8');
    expect(wikiIdToSlug['E8']).toBe('needy-page');
    // Ensure we didn't overwrite the existing claims
    expect(wikiIdToSlug['E5']).toBe('other-page-5');
    expect(wikiIdToSlug['E6']).toBe('other-page-6');
    expect(wikiIdToSlug['E7']).toBe('other-page-7');
    expect(result.pageIdAssignments).toBe(1);
  });
});
