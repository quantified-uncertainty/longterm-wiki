import { describe, it, expect } from 'vitest';
import {
  extractSectionContext,
  parseLLMFixResponse,
  applyFixes,
  enrichFromSqlite,
} from './fix-inaccuracies.ts';
import type { FlaggedCitation } from './export-dashboard.ts';

describe('extractSectionContext', () => {
  const body = [
    '## Overview',
    '',
    'First paragraph with some text.',
    '',
    'Second paragraph with a claim[^1] that is cited.',
    '',
    'Third paragraph with more text.',
    '',
    '## Next Section',
    '',
    'Another paragraph with [^2] reference.',
  ].join('\n');

  it('returns lines around the footnote reference', () => {
    const ctx = extractSectionContext(body, 1);
    expect(ctx).toContain('claim[^1]');
    expect(ctx).toContain('## Overview');
  });

  it('returns empty string for missing footnote', () => {
    expect(extractSectionContext(body, 99)).toBe('');
  });

  it('includes surrounding context', () => {
    const ctx = extractSectionContext(body, 2);
    expect(ctx).toContain('[^2]');
  });
});

describe('parseLLMFixResponse', () => {
  it('parses valid JSON array', () => {
    const input = JSON.stringify([
      {
        footnote: 5,
        original: 'old text',
        replacement: 'new text',
        explanation: 'fixed a number',
        fix_type: 'correct',
      },
    ]);

    const result = parseLLMFixResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].footnote).toBe(5);
    expect(result[0].original).toBe('old text');
    expect(result[0].replacement).toBe('new text');
    expect(result[0].fixType).toBe('correct');
  });

  it('strips code fences', () => {
    const input = '```json\n[{"footnote":1,"original":"a","replacement":"b","explanation":"c","fix_type":"d"}]\n```';
    const result = parseLLMFixResponse(input);
    expect(result).toHaveLength(1);
  });

  it('filters out entries where original equals replacement', () => {
    const input = JSON.stringify([
      { footnote: 1, original: 'same', replacement: 'same', explanation: 'no change', fix_type: 'none' },
      { footnote: 2, original: 'old', replacement: 'new', explanation: 'real fix', fix_type: 'soften' },
    ]);
    const result = parseLLMFixResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].footnote).toBe(2);
  });

  it('filters out entries with empty original', () => {
    const input = JSON.stringify([
      { footnote: 1, original: '', replacement: 'new', explanation: 'x', fix_type: 'y' },
    ]);
    expect(parseLLMFixResponse(input)).toHaveLength(0);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseLLMFixResponse('not json')).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    expect(parseLLMFixResponse('{"key": "value"}')).toEqual([]);
  });
});

describe('applyFixes', () => {
  const content = [
    '---',
    'title: Test',
    '---',
    '',
    'The widget costs $50[^1] and was released in 2020.',
    '',
    'The company has 500 employees[^2] worldwide.',
  ].join('\n');

  it('applies a single fix', () => {
    const proposals = [
      {
        footnote: 1,
        original: 'costs $50[^1]',
        replacement: 'costs approximately $45[^1]',
        explanation: 'Corrected price',
        fixType: 'correct',
      },
    ];

    const result = applyFixes(content, proposals);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    const modified = (result as typeof result & { content: string }).content;
    expect(modified).toContain('costs approximately $45[^1]');
    expect(modified).not.toContain('costs $50[^1]');
  });

  it('applies multiple fixes in correct order', () => {
    const proposals = [
      {
        footnote: 1,
        original: 'costs $50[^1]',
        replacement: 'costs about $50[^1]',
        explanation: 'Softened',
        fixType: 'soften',
      },
      {
        footnote: 2,
        original: '500 employees[^2]',
        replacement: 'approximately 500 employees[^2]',
        explanation: 'Softened',
        fixType: 'soften',
      },
    ];

    const result = applyFixes(content, proposals);
    expect(result.applied).toBe(2);
    const modified = (result as typeof result & { content: string }).content;
    expect(modified).toContain('costs about $50[^1]');
    expect(modified).toContain('approximately 500 employees[^2]');
  });

  it('skips fixes where original text is not found', () => {
    const proposals = [
      {
        footnote: 1,
        original: 'nonexistent text',
        replacement: 'something else',
        explanation: 'Should skip',
        fixType: 'correct',
      },
    ];

    const result = applyFixes(content, proposals);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.details[0].status).toBe('not_found');
  });

  it('does not set content when no fixes applied', () => {
    const proposals = [
      {
        footnote: 1,
        original: 'nonexistent',
        replacement: 'new',
        explanation: 'Missing',
        fixType: 'correct',
      },
    ];

    const result = applyFixes(content, proposals);
    expect((result as typeof result & { content?: string }).content).toBeUndefined();
  });
});

describe('enrichFromSqlite', () => {
  it('returns enriched objects with null fields when SQLite is unavailable', () => {
    // When SQLite is not available (no .cache/knowledge.db), enrichFromSqlite
    // should gracefully return the original data with null enrichment fields
    const flagged: FlaggedCitation[] = [
      {
        pageId: 'test-page',
        footnote: 1,
        claimText: 'truncated claim...',
        sourceTitle: 'Source',
        url: 'https://example.com',
        verdict: 'inaccurate',
        score: 0.3,
        issues: 'Wrong date',
        difficulty: 'easy',
        checkedAt: '2025-01-01',
      },
    ];

    const enriched = enrichFromSqlite(flagged);
    expect(enriched).toHaveLength(1);
    expect(enriched[0].pageId).toBe('test-page');
    expect(enriched[0].claimText).toBe('truncated claim...');
    // Enrichment fields should be present (null if SQLite unavailable)
    expect('fullClaimText' in enriched[0]).toBe(true);
    expect('sourceQuote' in enriched[0]).toBe(true);
    expect('supportingQuotes' in enriched[0]).toBe(true);
    expect('sourceFullText' in enriched[0]).toBe(true);
  });
});
