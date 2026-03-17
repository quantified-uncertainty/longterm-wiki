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
});
