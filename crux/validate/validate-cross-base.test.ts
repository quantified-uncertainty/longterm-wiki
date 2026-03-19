/**
 * Tests for cross-base consistency validator.
 *
 * Tests the core check functions with synthetic data to verify
 * error/warning/info classification and edge case handling.
 */

import { describe, it, expect } from 'vitest';
import {
  checkPageEntityCoverage,
  checkTitleConsistency,
  checkEntityPageCoverage,
  checkFactBaseCoverage,
  extractFactBaseStableId,
  type EntityRecord,
  type PageRecord,
  type FactBaseRecord,
} from './validate-cross-base.ts';

// ============================================================================
// extractFactBaseStableId
// ============================================================================

describe('extractFactBaseStableId', () => {
  it('extracts stableId from entity: format', () => {
    const content = 'entity: mK9pX3rQ7n\nfacts:\n  - id: f_123';
    expect(extractFactBaseStableId(content)).toBe('mK9pX3rQ7n');
  });

  it('extracts stableId from thing: format with stableId field', () => {
    const content = 'thing:\n  id: old-id\n  stableId: abc123def0\n  slug: my-entity';
    expect(extractFactBaseStableId(content)).toBe('abc123def0');
  });

  it('extracts stableId from thing: format with id + slug', () => {
    const content = 'thing:\n  id: xY7zW2qR9n\n  slug: my-entity';
    expect(extractFactBaseStableId(content)).toBe('xY7zW2qR9n');
  });

  it('returns null for empty content', () => {
    expect(extractFactBaseStableId('')).toBeNull();
  });

  it('returns null for content without entity or thing', () => {
    const content = 'facts:\n  - id: f_123\n    property: revenue';
    expect(extractFactBaseStableId(content)).toBeNull();
  });

  it('returns null for thing: format without stableId or slug', () => {
    const content = 'thing:\n  id: old-id\n  name: test';
    expect(extractFactBaseStableId(content)).toBeNull();
  });

  it('prefers entity: format when thing: is absent', () => {
    const content = 'entity: abc123\nfacts: []';
    expect(extractFactBaseStableId(content)).toBe('abc123');
  });
});

// ============================================================================
// checkPageEntityCoverage
// ============================================================================

describe('checkPageEntityCoverage', () => {
  it('reports info when page has wikiId but no matching entity', () => {
    const pages: PageRecord[] = [
      { filePath: 'content/docs/test.mdx', wikiId: 'E999', title: 'Test Page' },
    ];
    const entityByWikiId = new Map<string, EntityRecord>();

    const issues = checkPageEntityCoverage(pages, entityByWikiId);

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
    expect(issues[0].id).toBe('page-no-entity');
    expect(issues[0].wikiId).toBe('E999');
  });

  it('reports no issues when page wikiId matches an entity', () => {
    const pages: PageRecord[] = [
      { filePath: 'content/docs/test.mdx', wikiId: 'E22', title: 'Anthropic' },
    ];
    const entityByWikiId = new Map<string, EntityRecord>([
      ['E22', { id: 'anthropic', wikiId: 'E22', type: 'organization', title: 'Anthropic', sourceFile: 'organizations.yaml' }],
    ]);

    const issues = checkPageEntityCoverage(pages, entityByWikiId);

    expect(issues).toHaveLength(0);
  });

  it('skips pages without wikiId', () => {
    const pages: PageRecord[] = [
      { filePath: 'content/docs/test.mdx', title: 'Test Page' },
    ];
    const entityByWikiId = new Map<string, EntityRecord>();

    const issues = checkPageEntityCoverage(pages, entityByWikiId);

    expect(issues).toHaveLength(0);
  });

  it('handles multiple pages with mixed results', () => {
    const pages: PageRecord[] = [
      { filePath: 'content/docs/a.mdx', wikiId: 'E1', title: 'Good Page' },
      { filePath: 'content/docs/b.mdx', wikiId: 'E999', title: 'No Entity' },
      { filePath: 'content/docs/c.mdx', title: 'No WikiId' },
    ];
    const entityByWikiId = new Map<string, EntityRecord>([
      ['E1', { id: 'good', wikiId: 'E1', type: 'concept', title: 'Good Page', sourceFile: 'concepts.yaml' }],
    ]);

    const issues = checkPageEntityCoverage(pages, entityByWikiId);

    expect(issues).toHaveLength(1);
    expect(issues[0].wikiId).toBe('E999');
    expect(issues[0].severity).toBe('info');
  });
});

// ============================================================================
// checkTitleConsistency
// ============================================================================

describe('checkTitleConsistency', () => {
  it('reports warning when page title differs from entity title', () => {
    const pages: PageRecord[] = [
      { filePath: 'content/docs/test.mdx', wikiId: 'E22', title: 'Anthropic Inc.' },
    ];
    const entityByWikiId = new Map<string, EntityRecord>([
      ['E22', { id: 'anthropic', wikiId: 'E22', type: 'organization', title: 'Anthropic', sourceFile: 'organizations.yaml' }],
    ]);

    const issues = checkTitleConsistency(pages, entityByWikiId);

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].id).toBe('title-mismatch');
    expect(issues[0].message).toContain('Anthropic Inc.');
    expect(issues[0].message).toContain('Anthropic');
  });

  it('reports no issues when titles match', () => {
    const pages: PageRecord[] = [
      { filePath: 'content/docs/test.mdx', wikiId: 'E22', title: 'Anthropic' },
    ];
    const entityByWikiId = new Map<string, EntityRecord>([
      ['E22', { id: 'anthropic', wikiId: 'E22', type: 'organization', title: 'Anthropic', sourceFile: 'organizations.yaml' }],
    ]);

    const issues = checkTitleConsistency(pages, entityByWikiId);

    expect(issues).toHaveLength(0);
  });

  it('skips pages without title', () => {
    const pages: PageRecord[] = [
      { filePath: 'content/docs/test.mdx', wikiId: 'E22' },
    ];
    const entityByWikiId = new Map<string, EntityRecord>([
      ['E22', { id: 'anthropic', wikiId: 'E22', type: 'organization', title: 'Anthropic', sourceFile: 'organizations.yaml' }],
    ]);

    const issues = checkTitleConsistency(pages, entityByWikiId);

    expect(issues).toHaveLength(0);
  });

  it('skips pages whose wikiId has no matching entity (reported elsewhere)', () => {
    const pages: PageRecord[] = [
      { filePath: 'content/docs/test.mdx', wikiId: 'E999', title: 'Nonexistent' },
    ];
    const entityByWikiId = new Map<string, EntityRecord>();

    const issues = checkTitleConsistency(pages, entityByWikiId);

    expect(issues).toHaveLength(0);
  });
});

// ============================================================================
// checkEntityPageCoverage
// ============================================================================

describe('checkEntityPageCoverage', () => {
  it('reports warning when entity has wikiId but no matching page', () => {
    const entities: EntityRecord[] = [
      { id: 'orphan', wikiId: 'E888', type: 'concept', title: 'Orphaned Entity', sourceFile: 'concepts.yaml' },
    ];
    const pageByWikiId = new Map<string, PageRecord>();

    const issues = checkEntityPageCoverage(entities, pageByWikiId);

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].id).toBe('entity-missing-page');
    expect(issues[0].wikiId).toBe('E888');
  });

  it('reports no issues when entity has a matching page', () => {
    const entities: EntityRecord[] = [
      { id: 'anthropic', wikiId: 'E22', type: 'organization', title: 'Anthropic', sourceFile: 'organizations.yaml' },
    ];
    const pageByWikiId = new Map<string, PageRecord>([
      ['E22', { filePath: 'content/docs/anthropic.mdx', wikiId: 'E22', title: 'Anthropic' }],
    ]);

    const issues = checkEntityPageCoverage(entities, pageByWikiId);

    expect(issues).toHaveLength(0);
  });

  it('skips entities without wikiId', () => {
    const entities: EntityRecord[] = [
      { id: 'no-wiki', type: 'person', title: 'Minor Person', sourceFile: 'people.yaml' },
    ];
    const pageByWikiId = new Map<string, PageRecord>();

    const issues = checkEntityPageCoverage(entities, pageByWikiId);

    expect(issues).toHaveLength(0);
  });
});

// ============================================================================
// checkFactBaseCoverage
// ============================================================================

describe('checkFactBaseCoverage', () => {
  it('reports warning when FactBase entity has no TableBase entry', () => {
    const records: FactBaseRecord[] = [
      { filename: 'mystery.yaml', entityStableId: 'notInTableBase' },
    ];
    const stableIdSet = new Set<string>();

    const issues = checkFactBaseCoverage(records, stableIdSet);

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].id).toBe('factbase-missing-tablebase');
    expect(issues[0].entityId).toBe('notInTableBase');
  });

  it('reports warning when FactBase entity has no stableId', () => {
    const records: FactBaseRecord[] = [
      { filename: 'broken.yaml', entityStableId: null },
    ];
    const stableIdSet = new Set<string>();

    const issues = checkFactBaseCoverage(records, stableIdSet);

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].id).toBe('factbase-no-stableid');
  });

  it('reports no issues when FactBase entity is in TableBase', () => {
    const records: FactBaseRecord[] = [
      { filename: 'anthropic.yaml', entityStableId: 'mK9pX3rQ7n' },
    ];
    const stableIdSet = new Set<string>(['mK9pX3rQ7n']);

    const issues = checkFactBaseCoverage(records, stableIdSet);

    expect(issues).toHaveLength(0);
  });

  it('matches by entity id (not just stableId)', () => {
    const records: FactBaseRecord[] = [
      { filename: 'test.yaml', entityStableId: 'anthropic' },
    ];
    // entity id "anthropic" is also added to the set
    const stableIdSet = new Set<string>(['anthropic']);

    const issues = checkFactBaseCoverage(records, stableIdSet);

    expect(issues).toHaveLength(0);
  });

  it('handles empty inputs', () => {
    const issues = checkFactBaseCoverage([], new Set<string>());
    expect(issues).toHaveLength(0);
  });

  it('handles multiple records with mixed results', () => {
    const records: FactBaseRecord[] = [
      { filename: 'good.yaml', entityStableId: 'known' },
      { filename: 'bad.yaml', entityStableId: 'unknown' },
      { filename: 'null.yaml', entityStableId: null },
    ];
    const stableIdSet = new Set<string>(['known']);

    const issues = checkFactBaseCoverage(records, stableIdSet);

    expect(issues).toHaveLength(2);
    expect(issues[0].id).toBe('factbase-missing-tablebase');
    expect(issues[1].id).toBe('factbase-no-stableid');
  });
});
