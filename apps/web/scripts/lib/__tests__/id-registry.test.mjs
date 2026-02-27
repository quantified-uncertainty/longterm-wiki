/**
 * Tests for id-registry.mjs extracted module
 */

import { describe, it, expect } from 'vitest';
import { buildIdRegistry, extendIdRegistryWithPages } from '../id-registry.mjs';

describe('buildIdRegistry', () => {
  it('maps slugs to numeric IDs', () => {
    const entities = [
      { id: 'anthropic', numericId: 'E1' },
      { id: 'openai', numericId: 'E2' },
    ];
    const result = buildIdRegistry(entities);
    expect(result.slugToNumericId['anthropic']).toBe('E1');
    expect(result.numericIdToSlug['E1']).toBe('anthropic');
    expect(result.nextId).toBe(3);
  });

  it('assigns fallback IDs to entities without numericId', () => {
    const entities = [
      { id: 'entity-a', numericId: 'E5' },
      { id: 'entity-b' }, // no numericId
    ];
    const result = buildIdRegistry(entities);
    expect(result.slugToNumericId['entity-b']).toBe('E6');
    expect(result.numericIdToSlug['E6']).toBe('entity-b');
    expect(entities[1].numericId).toBe('E6'); // mutates in-place
  });

  it('finds next available ID correctly', () => {
    const entities = [
      { id: 'a', numericId: 'E100' },
      { id: 'b', numericId: 'E50' },
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
    const slugToNumericId = {};
    const numericIdToSlug = {};
    const pathRegistry = {};

    const result = extendIdRegistryWithPages({
      pages, entityIds, slugToNumericId, numericIdToSlug, pathRegistry, nextId: 1,
    });

    expect(result.pageIdAssignments).toBe(1);
    expect(slugToNumericId['page-one']).toBe('E1');
    expect(pages[0].numericId).toBe('E1');
  });

  it('skips pages that already have an entity', () => {
    const pages = [
      { id: 'existing-entity', category: 'knowledge-base' },
    ];
    const entityIds = new Set(['existing-entity']);
    const slugToNumericId = { 'existing-entity': 'E5' };
    const numericIdToSlug = { 'E5': 'existing-entity' };

    const result = extendIdRegistryWithPages({
      pages, entityIds, slugToNumericId, numericIdToSlug, pathRegistry: {}, nextId: 6,
    });

    expect(result.pageIdAssignments).toBe(0);
  });

  it('skips infrastructure categories', () => {
    const pages = [
      { id: 'my-tool', category: 'tools' },
      { id: 'my-guide', category: 'guides' },
    ];
    const result = extendIdRegistryWithPages({
      pages, entityIds: new Set(), slugToNumericId: {}, numericIdToSlug: {}, pathRegistry: {}, nextId: 1,
    });

    expect(result.pageIdAssignments).toBe(0);
  });

  it('skips dashboard content format', () => {
    const pages = [
      { id: 'my-dash', category: 'knowledge-base', contentFormat: 'dashboard' },
    ];
    const result = extendIdRegistryWithPages({
      pages, entityIds: new Set(), slugToNumericId: {}, numericIdToSlug: {}, pathRegistry: {}, nextId: 1,
    });

    expect(result.pageIdAssignments).toBe(0);
  });
});
