/**
 * Tests for frontmatter field ordering utilities and validation rule
 */

import { describe, it, expect } from 'vitest';
import {
  FRONTMATTER_FIELD_ORDER,
  getFieldSortIndex,
  findFirstOutOfOrder,
  sortFields,
} from './frontmatter-order.ts';
import { frontmatterOrderRule } from './rules/frontmatter-order.ts';
import { Severity } from './validation-engine.ts';

// Helper to create a mock content file (cast to any to match existing test patterns)
function mockContent(raw: string): any {
  return {
    path: 'content/docs/test-page.mdx',
    relativePath: 'test-page.mdx',
    body: '',
    raw,
    frontmatter: { title: 'Test' },
    isIndex: false,
  };
}

// ---------------------------------------------------------------------------
// getFieldSortIndex
// ---------------------------------------------------------------------------

describe('getFieldSortIndex', () => {
  it('returns correct index for known fields', () => {
    expect(getFieldSortIndex('title')).toBe(FRONTMATTER_FIELD_ORDER.indexOf('title'));
    expect(getFieldSortIndex('numericId')).toBe(FRONTMATTER_FIELD_ORDER.indexOf('numericId'));
    expect(getFieldSortIndex('clusters')).toBe(FRONTMATTER_FIELD_ORDER.indexOf('clusters'));
  });

  it('returns high index for unknown fields', () => {
    const unknownIdx = getFieldSortIndex('somethingNew');
    const lastKnownIdx = FRONTMATTER_FIELD_ORDER.length - 1;
    expect(unknownIdx).toBeGreaterThan(lastKnownIdx);
  });

  it('identity fields come before metadata fields', () => {
    expect(getFieldSortIndex('title')).toBeLessThan(getFieldSortIndex('quality'));
    expect(getFieldSortIndex('title')).toBeLessThan(getFieldSortIndex('clusters'));
    expect(getFieldSortIndex('numericId')).toBeLessThan(getFieldSortIndex('lastEdited'));
  });

  it('structure fields come before quality fields', () => {
    expect(getFieldSortIndex('entityType')).toBeLessThan(getFieldSortIndex('quality'));
    expect(getFieldSortIndex('sidebar')).toBeLessThan(getFieldSortIndex('readerImportance'));
  });

  it('temporal fields come after quality fields', () => {
    expect(getFieldSortIndex('quality')).toBeLessThan(getFieldSortIndex('lastEdited'));
    expect(getFieldSortIndex('readerImportance')).toBeLessThan(getFieldSortIndex('update_frequency'));
  });

  it('collections come after summaries and ratings', () => {
    expect(getFieldSortIndex('llmSummary')).toBeLessThan(getFieldSortIndex('clusters'));
    expect(getFieldSortIndex('ratings')).toBeLessThan(getFieldSortIndex('clusters'));
    expect(getFieldSortIndex('ratings')).toBeLessThan(getFieldSortIndex('todos'));
  });
});

// ---------------------------------------------------------------------------
// findFirstOutOfOrder
// ---------------------------------------------------------------------------

describe('findFirstOutOfOrder', () => {
  it('returns null for correctly ordered fields', () => {
    expect(findFirstOutOfOrder(['title', 'description', 'sidebar', 'quality'])).toBeNull();
  });

  it('returns null for single field', () => {
    expect(findFirstOutOfOrder(['title'])).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(findFirstOutOfOrder([])).toBeNull();
  });

  it('detects first out-of-order pair', () => {
    const result = findFirstOutOfOrder(['quality', 'title']);
    expect(result).toEqual({ before: 'quality', after: 'title' });
  });

  it('detects clusters before sidebar', () => {
    const result = findFirstOutOfOrder(['title', 'clusters', 'sidebar']);
    expect(result).toEqual({ before: 'clusters', after: 'sidebar' });
  });
});

// ---------------------------------------------------------------------------
// sortFields
// ---------------------------------------------------------------------------

describe('sortFields', () => {
  it('sorts fields to canonical order', () => {
    const input = ['quality', 'title', 'clusters', 'entityType', 'numericId'];
    expect(sortFields(input)).toEqual([
      'numericId', 'title', 'entityType', 'quality', 'clusters',
    ]);
  });

  it('preserves order of already-sorted fields', () => {
    const input = ['title', 'description', 'sidebar', 'quality'];
    expect(sortFields(input)).toEqual(input);
  });

  it('sorts unknown fields alphabetically at the end', () => {
    const input = ['title', 'zzz_custom', 'aaa_custom'];
    const sorted = sortFields(input);
    expect(sorted[0]).toBe('title');
    expect(sorted[1]).toBe('aaa_custom');
    expect(sorted[2]).toBe('zzz_custom');
  });

  it('handles empty input', () => {
    expect(sortFields([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// frontmatterOrderRule
// ---------------------------------------------------------------------------

describe('frontmatter-order rule', () => {
  it('passes for correctly ordered frontmatter', () => {
    const raw = [
      '---',
      'title: Test Page',
      'description: A test',
      'sidebar:',
      '  order: 1',
      'entityType: concept',
      'quality: 50',
      'lastEdited: "2026-01-01"',
      'clusters:',
      '  - ai-safety',
      '---',
      'Body content',
    ].join('\n');
    const content = mockContent(raw);
    const issues = frontmatterOrderRule.check(content, {} as any);
    expect(issues.length).toBe(0);
  });

  it('warns when quality comes before title', () => {
    const raw = [
      '---',
      'quality: 50',
      'title: Test Page',
      '---',
      'Body',
    ].join('\n');
    const content = mockContent(raw);
    const issues = frontmatterOrderRule.check(content, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.WARNING);
    expect(issues[0].message).toContain('quality');
    expect(issues[0].message).toContain('title');
  });

  it('warns when clusters comes before entityType', () => {
    const raw = [
      '---',
      'title: Test',
      'clusters:',
      '  - ai-safety',
      'entityType: risk',
      '---',
      'Body',
    ].join('\n');
    const content = mockContent(raw);
    const issues = frontmatterOrderRule.check(content, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.WARNING);
  });

  it('skips files with no frontmatter', () => {
    const content = mockContent('Just some body text');
    const issues = frontmatterOrderRule.check(content, {} as any);
    expect(issues.length).toBe(0);
  });

  it('skips files with single field', () => {
    const raw = '---\ntitle: Test\n---\nBody';
    const content = mockContent(raw);
    const issues = frontmatterOrderRule.check(content, {} as any);
    expect(issues.length).toBe(0);
  });

  it('reports at most one issue per file', () => {
    const raw = [
      '---',
      'clusters:',
      '  - ai-safety',
      'quality: 50',
      'title: Test',
      '---',
      'Body',
    ].join('\n');
    const content = mockContent(raw);
    const issues = frontmatterOrderRule.check(content, {} as any);
    // Only one issue even though multiple fields are out of order
    expect(issues.length).toBe(1);
  });
});
