import { describe, it, expect } from 'vitest';
import {
  extractSectionContext,
  extractSection,
  groupFlaggedBySection,
  findAllFootnotesInSection,
  applySectionRewrites,
  parseLLMFixResponse,
  applyFixes,
  enrichFromSqlite,
} from './fix-inaccuracies.ts';
import type { FlaggedCitation } from './export-dashboard.ts';
import type { SectionRewrite } from './fix-inaccuracies.ts';

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
    const modified = result.content;
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
    const modified = result.content;
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
    expect(result.content).toBeNull();
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

// ---------------------------------------------------------------------------
// Section extraction (escalation support)
// ---------------------------------------------------------------------------

describe('extractSection', () => {
  const body = [
    '## Overview',
    '',
    'First paragraph about the topic.',
    '',
    'Second paragraph with a claim[^1] that is cited.',
    '',
    'Third paragraph with more claims[^2] here.',
    '',
    '## History',
    '',
    'The organization was founded in 2015[^3].',
    '',
    '### Early Days',
    '',
    'During early days, they achieved[^4] a lot.',
    '',
    '## Footnotes',
    '',
    '[^1]: https://example.com/source1',
    '[^2]: https://example.com/source2',
    '[^3]: https://example.com/source3',
    '[^4]: https://example.com/source4',
  ].join('\n');

  it('extracts section bounded by headings', () => {
    const result = extractSection(body, 1);
    expect(result).not.toBeNull();
    expect(result!.heading).toBe('## Overview');
    expect(result!.text).toContain('## Overview');
    expect(result!.text).toContain('claim[^1]');
    expect(result!.text).toContain('[^2]');
    expect(result!.text).not.toContain('## History');
  });

  it('extracts section for footnote in second section', () => {
    const result = extractSection(body, 3);
    expect(result).not.toBeNull();
    expect(result!.heading).toBe('## History');
    expect(result!.text).toContain('founded in 2015[^3]');
  });

  it('handles subsections', () => {
    const result = extractSection(body, 4);
    expect(result).not.toBeNull();
    expect(result!.heading).toBe('### Early Days');
    expect(result!.text).toContain('achieved[^4]');
    expect(result!.text).not.toContain('## Footnotes');
  });

  it('excludes footnote definition lines', () => {
    const result = extractSection(body, 1);
    expect(result).not.toBeNull();
    expect(result!.text).not.toContain('[^1]: https://');
  });

  it('returns null for missing footnote', () => {
    expect(extractSection(body, 99)).toBeNull();
  });

  it('returns null when footnote only appears in definitions', () => {
    const bodyOnlyDefs = [
      '## Section',
      '',
      'No references in text.',
      '',
      '[^5]: https://example.com',
    ].join('\n');
    expect(extractSection(bodyOnlyDefs, 5)).toBeNull();
  });
});

describe('groupFlaggedBySection', () => {
  const body = [
    '## Overview',
    '',
    'A claim[^1] and another[^2] in same section.',
    '',
    '## Details',
    '',
    'A different claim[^3] here.',
  ].join('\n');

  const makeFlagged = (fn: number): FlaggedCitation => ({
    pageId: 'test',
    footnote: fn,
    claimText: `claim ${fn}`,
    sourceTitle: 'Source',
    url: 'https://example.com',
    verdict: 'inaccurate',
    score: 0.3,
    issues: 'Wrong',
    difficulty: 'easy',
    checkedAt: '2025-01-01',
  });

  it('groups citations in the same section together', () => {
    const groups = groupFlaggedBySection(body, [makeFlagged(1), makeFlagged(2)]);
    expect(groups.size).toBe(1);
    const [entry] = [...groups.values()];
    expect(entry.citations).toHaveLength(2);
    expect(entry.section.heading).toBe('## Overview');
  });

  it('separates citations across different sections', () => {
    const groups = groupFlaggedBySection(body, [makeFlagged(1), makeFlagged(3)]);
    expect(groups.size).toBe(2);
  });

  it('skips citations with no matching section', () => {
    const groups = groupFlaggedBySection(body, [makeFlagged(99)]);
    expect(groups.size).toBe(0);
  });
});

describe('findAllFootnotesInSection', () => {
  it('finds all footnote references', () => {
    const text = 'Some text[^1] and more[^3] and also[^2].';
    expect(findAllFootnotesInSection(text)).toEqual([1, 2, 3]);
  });

  it('deduplicates footnotes appearing multiple times', () => {
    const text = 'A claim[^1] confirmed by[^1] the same source.';
    expect(findAllFootnotesInSection(text)).toEqual([1]);
  });

  it('excludes footnote definition lines', () => {
    const text = [
      'Some text[^1] in the section.',
      '',
      '[^1]: https://example.com',
      '[^2]: https://other.com',
    ].join('\n');
    expect(findAllFootnotesInSection(text)).toEqual([1]);
  });

  it('returns empty array for no footnotes', () => {
    expect(findAllFootnotesInSection('Just plain text.')).toEqual([]);
  });
});

describe('applySectionRewrites', () => {
  const content = [
    '---',
    'title: Test Page',
    '---',
    '',
    '## Overview',
    '',
    'The project started in 2015[^1] and grew rapidly.',
    '',
    '## Details',
    '',
    'It has 500 members[^2] worldwide.',
  ].join('\n');

  it('applies a single section rewrite', () => {
    const rewrites: SectionRewrite[] = [
      {
        heading: '## Overview',
        originalSection: '## Overview\n\nThe project started in 2015[^1] and grew rapidly.',
        rewrittenSection: '## Overview\n\nThe project started in 2016[^1] and grew steadily.',
        startLine: 4,
        endLine: 6,
      },
    ];

    const result = applySectionRewrites(content, rewrites);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.content).toContain('started in 2016[^1]');
    expect(result.content).toContain('grew steadily');
    expect(result.content).toContain('500 members[^2]'); // unchanged
  });

  it('applies multiple rewrites bottom-to-top', () => {
    const rewrites: SectionRewrite[] = [
      {
        heading: '## Overview',
        originalSection: '## Overview\n\nThe project started in 2015[^1] and grew rapidly.',
        rewrittenSection: '## Overview\n\nThe project launched in 2016[^1].',
        startLine: 4,
        endLine: 6,
      },
      {
        heading: '## Details',
        originalSection: '## Details\n\nIt has 500 members[^2] worldwide.',
        rewrittenSection: '## Details\n\nIt has approximately 500 members[^2] globally.',
        startLine: 8,
        endLine: 10,
      },
    ];

    const result = applySectionRewrites(content, rewrites);
    expect(result.applied).toBe(2);
    expect(result.content).toContain('launched in 2016[^1]');
    expect(result.content).toContain('approximately 500 members[^2]');
  });

  it('skips rewrites where original section is not found', () => {
    const rewrites: SectionRewrite[] = [
      {
        heading: '## Missing',
        originalSection: '## Missing\n\nThis section does not exist.',
        rewrittenSection: '## Missing\n\nRewritten.',
        startLine: 0,
        endLine: 2,
      },
    ];

    const result = applySectionRewrites(content, rewrites);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.content).toBe(content);
  });
});
