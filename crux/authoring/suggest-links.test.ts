/**
 * Tests for suggest-links analysis functions
 *
 * Tests the core cross-linking suggestion engine using synthetic entity data.
 */

import { describe, it, expect } from 'vitest';
import {
  findCoOccurrences,
  findSharedTags,
  findTransitive,
  findReverseLinks,
  generateSuggestions,
  type YamlEntity,
} from './suggest-links.ts';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEntity(overrides: Partial<YamlEntity> & { id: string; title: string; type: string }): YamlEntity {
  return {
    tags: [],
    relatedEntries: [],
    ...overrides,
  };
}

const entityA = makeEntity({
  id: 'org-a',
  title: 'Organization A',
  type: 'organization',
  tags: ['ai-safety', 'alignment', 'interpretability'],
  relatedEntries: [{ id: 'org-b', type: 'organization' }],
});

const entityB = makeEntity({
  id: 'org-b',
  title: 'Organization B',
  type: 'organization',
  tags: ['ai-safety', 'alignment', 'rlhf'],
  relatedEntries: [
    { id: 'org-a', type: 'organization' },
    { id: 'org-c', type: 'organization' },
  ],
});

const entityC = makeEntity({
  id: 'org-c',
  title: 'Organization C',
  type: 'organization',
  tags: ['governance', 'policy'],
  relatedEntries: [{ id: 'org-b', type: 'organization' }],
});

const entityD = makeEntity({
  id: 'org-d',
  title: 'Organization D',
  type: 'organization',
  tags: ['ai-safety', 'interpretability', 'alignment'],
});

const allEntities = [entityA, entityB, entityC, entityD];
const entityIndex = new Map(allEntities.map(e => [e.id, e]));

// ---------------------------------------------------------------------------
// findSharedTags
// ---------------------------------------------------------------------------

describe('findSharedTags', () => {
  it('finds entities with shared tags', () => {
    const result = findSharedTags(entityA, allEntities);
    expect(result.has('org-b')).toBe(true);
    expect(result.get('org-b')!.count).toBe(2); // ai-safety, alignment
    expect(result.get('org-b')!.tags).toContain('ai-safety');
    expect(result.get('org-b')!.tags).toContain('alignment');
  });

  it('finds entities with 3+ shared tags', () => {
    const result = findSharedTags(entityA, allEntities);
    expect(result.has('org-d')).toBe(true);
    expect(result.get('org-d')!.count).toBe(3); // ai-safety, alignment, interpretability
  });

  it('does not include self', () => {
    const result = findSharedTags(entityA, allEntities);
    expect(result.has('org-a')).toBe(false);
  });

  it('does not include entities with no shared tags', () => {
    const result = findSharedTags(entityA, allEntities);
    expect(result.has('org-c')).toBe(false); // governance, policy — no overlap
  });

  it('returns empty for entity with no tags', () => {
    const noTags = makeEntity({ id: 'no-tags', title: 'No Tags', type: 'organization' });
    const result = findSharedTags(noTags, allEntities);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findTransitive
// ---------------------------------------------------------------------------

describe('findTransitive', () => {
  it('finds friend-of-friend connections', () => {
    // A links to B, B links to C → suggest C for A
    const result = findTransitive('org-a', allEntities, entityIndex);
    expect(result.has('org-c')).toBe(true);
    expect(result.get('org-c')![0]).toContain('via org-b');
  });

  it('does not suggest direct links', () => {
    // A already links to B, so B should not be suggested transitively
    const result = findTransitive('org-a', allEntities, entityIndex);
    expect(result.has('org-b')).toBe(false);
  });

  it('does not suggest self', () => {
    // B links to A and C, A links to B → would loop back to A
    const result = findTransitive('org-a', allEntities, entityIndex);
    expect(result.has('org-a')).toBe(false);
  });

  it('returns empty for entity with no relatedEntries', () => {
    const result = findTransitive('org-d', allEntities, entityIndex);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findReverseLinks
// ---------------------------------------------------------------------------

describe('findReverseLinks', () => {
  it('finds entities that link to this entity but are not linked back', () => {
    // C links to B, but B already links to C → no reverse suggestion
    // B links to A, and A links to B → no reverse suggestion
    // Let's test with D which has no relatedEntries
    const result = findReverseLinks('org-d', allEntities, entityIndex);
    // No entity links to org-d, so no reverse links
    expect(result.size).toBe(0);
  });

  it('finds reverse links when they exist', () => {
    // C links to B. B also links to C. So no reverse.
    // But let's create a scenario: E links to A, but A doesn't link to E
    const entityE = makeEntity({
      id: 'org-e',
      title: 'Organization E',
      type: 'organization',
      relatedEntries: [{ id: 'org-a', type: 'organization' }],
    });
    const extended = [...allEntities, entityE];
    const extIndex = new Map(extended.map(e => [e.id, e]));

    const result = findReverseLinks('org-a', extended, extIndex);
    expect(result.has('org-e')).toBe(true);
    expect(result.get('org-e')![0]).toContain('org-e already links to org-a');
  });

  it('does not suggest already-linked entities', () => {
    // A links to B, and B links to A → B should not appear as reverse suggestion
    const result = findReverseLinks('org-a', allEntities, entityIndex);
    expect(result.has('org-b')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findCoOccurrences
// ---------------------------------------------------------------------------

describe('findCoOccurrences', () => {
  it('finds entities linked from the same pages', () => {
    // Simulate page link map: org-a's page links to org-c
    const pageLinkMap = new Map<string, Set<string>>([
      ['org-a', new Set(['org-c', 'org-d'])],
      ['org-c', new Set(['org-a'])],
    ]);

    const result = findCoOccurrences('org-a', pageLinkMap, entityIndex);
    expect(result.has('org-c')).toBe(true); // Mutual linkage
    expect(result.has('org-d')).toBe(true); // org-a's page links to org-d
  });

  it('does not include self', () => {
    const pageLinkMap = new Map<string, Set<string>>([
      ['org-a', new Set(['org-a', 'org-b'])],
    ]);

    const result = findCoOccurrences('org-a', pageLinkMap, entityIndex);
    expect(result.has('org-a')).toBe(false);
  });

  it('returns empty when no page links exist', () => {
    const pageLinkMap = new Map<string, Set<string>>();
    const result = findCoOccurrences('org-a', pageLinkMap, entityIndex);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// generateSuggestions (integration)
// ---------------------------------------------------------------------------

describe('generateSuggestions', () => {
  it('combines signals and scores suggestions', () => {
    const pageLinkMap = new Map<string, Set<string>>([
      ['org-a', new Set(['org-c', 'org-d'])],
      ['org-c', new Set(['org-a'])],
    ]);

    const suggestions = generateSuggestions(entityA, allEntities, entityIndex, pageLinkMap);

    // org-c should be suggested (co-occurrence + transitive)
    const orgCSuggestion = suggestions.find(s => s.suggestedId === 'org-c');
    expect(orgCSuggestion).toBeDefined();
    expect(orgCSuggestion!.score).toBeGreaterThanOrEqual(3);

    // org-d should be suggested (co-occurrence + shared tags)
    const orgDSuggestion = suggestions.find(s => s.suggestedId === 'org-d');
    expect(orgDSuggestion).toBeDefined();
    expect(orgDSuggestion!.score).toBeGreaterThanOrEqual(3);
  });

  it('does not suggest entities already in relatedEntries', () => {
    const pageLinkMap = new Map<string, Set<string>>();
    const suggestions = generateSuggestions(entityA, allEntities, entityIndex, pageLinkMap);

    // org-b is already in entityA's relatedEntries
    const orgBSuggestion = suggestions.find(s => s.suggestedId === 'org-b');
    expect(orgBSuggestion).toBeUndefined();
  });

  it('sorts by score descending', () => {
    const pageLinkMap = new Map<string, Set<string>>([
      ['org-a', new Set(['org-c', 'org-d'])],
      ['org-c', new Set(['org-a'])],
    ]);

    const suggestions = generateSuggestions(entityA, allEntities, entityIndex, pageLinkMap);

    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i].score).toBeLessThanOrEqual(suggestions[i - 1].score);
    }
  });

  it('returns empty when entity has all connections already', () => {
    const fullEntity = makeEntity({
      id: 'full',
      title: 'Fully Connected',
      type: 'organization',
      relatedEntries: allEntities.map(e => ({ id: e.id, type: e.type })),
    });

    const pageLinkMap = new Map<string, Set<string>>();
    const extended = [...allEntities, fullEntity];
    const extIndex = new Map(extended.map(e => [e.id, e]));

    const suggestions = generateSuggestions(fullEntity, extended, extIndex, pageLinkMap);
    expect(suggestions.length).toBe(0);
  });
});
