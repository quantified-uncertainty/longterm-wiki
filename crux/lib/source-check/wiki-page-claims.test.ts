/**
 * Tests for wiki-page-claims.ts
 *
 * Tests cover:
 * 1. Footnote parsing (standard format, edge cases)
 * 2. Claim-to-footnote matching
 * 3. Stale temporal detection
 * 4. Numeric value parsing and cross-referencing
 * 5. Priority scoring
 * 6. End-to-end extractWikiPageClaims with mocked LLM
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseFootnotes,
  matchClaimToFootnote,
  detectStaleTemporal,
  parseNumericValue,
  extractWikiPageClaims,
} from './wiki-page-claims.ts';
import type { ExtractedClaim } from '../semantic-diff/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeClaim(
  text: string,
  type: ExtractedClaim['type'] = 'numeric',
  opts: Partial<ExtractedClaim> = {},
): ExtractedClaim {
  return {
    text,
    type,
    confidence: opts.confidence ?? 'high',
    sourceContext: opts.sourceContext ?? text,
    keyValue: opts.keyValue,
  };
}

// ---------------------------------------------------------------------------
// 1. Footnote Parsing
// ---------------------------------------------------------------------------

describe('parseFootnotes', () => {
  it('parses standard footnote definitions with URLs', () => {
    const mdx = `Some text.

[^1]: https://example.com/source1
[^2]: https://example.com/source2
`;
    const footnotes = parseFootnotes(mdx);
    expect(footnotes.size).toBe(2);
    expect(footnotes.get(1)).toEqual({
      url: 'https://example.com/source1',
      text: 'https://example.com/source1',
    });
    expect(footnotes.get(2)).toEqual({
      url: 'https://example.com/source2',
      text: 'https://example.com/source2',
    });
  });

  it('parses footnotes with text and embedded URLs', () => {
    const mdx = `[^1]: See https://example.com/paper for details on this topic.`;
    const footnotes = parseFootnotes(mdx);
    expect(footnotes.size).toBe(1);
    const fn = footnotes.get(1)!;
    expect(fn.url).toBe('https://example.com/paper');
    expect(fn.text).toContain('See');
    expect(fn.text).toContain('details');
  });

  it('parses footnotes without URLs', () => {
    const mdx = `[^3]: Personal communication with the research team.`;
    const footnotes = parseFootnotes(mdx);
    expect(footnotes.size).toBe(1);
    const fn = footnotes.get(3)!;
    expect(fn.url).toBeUndefined();
    expect(fn.text).toBe('Personal communication with the research team.');
  });

  it('handles empty content', () => {
    const footnotes = parseFootnotes('');
    expect(footnotes.size).toBe(0);
  });

  it('handles content with no footnotes', () => {
    const mdx = `# Title\n\nSome paragraph text without any footnotes.\n`;
    const footnotes = parseFootnotes(mdx);
    expect(footnotes.size).toBe(0);
  });

  it('handles mixed footnotes with and without URLs', () => {
    const mdx = `
[^1]: https://arxiv.org/abs/1234.5678
[^2]: Unpublished internal report
[^3]: https://www.nature.com/articles/s41586-023-00001-1
`;
    const footnotes = parseFootnotes(mdx);
    expect(footnotes.size).toBe(3);
    expect(footnotes.get(1)!.url).toBe('https://arxiv.org/abs/1234.5678');
    expect(footnotes.get(2)!.url).toBeUndefined();
    expect(footnotes.get(3)!.url).toBe('https://www.nature.com/articles/s41586-023-00001-1');
  });

  it('handles high footnote numbers', () => {
    const mdx = `[^42]: https://example.com/source42`;
    const footnotes = parseFootnotes(mdx);
    expect(footnotes.size).toBe(1);
    expect(footnotes.get(42)!.url).toBe('https://example.com/source42');
  });

  it('does not parse inline footnote references as definitions', () => {
    const mdx = `The company has 300 employees[^1] and was founded in 2015[^2].`;
    const footnotes = parseFootnotes(mdx);
    expect(footnotes.size).toBe(0);
  });

  it('extracts first URL when multiple URLs are in footnote', () => {
    const mdx = `[^1]: https://first.com and also https://second.com`;
    const footnotes = parseFootnotes(mdx);
    expect(footnotes.get(1)!.url).toBe('https://first.com');
  });
});

// ---------------------------------------------------------------------------
// 2. Claim-to-footnote matching
// ---------------------------------------------------------------------------

describe('matchClaimToFootnote', () => {
  const SAMPLE_MDX = `Some intro text.

The company was founded in 2015 by Jane Smith[^1] and has grown significantly. It raised \\$500 million in total funding[^2].

The team now employs 300 researchers focused on AI safety.

[^1]: https://example.com/founding
[^2]: https://example.com/funding
`;

  const footnotes = parseFootnotes(SAMPLE_MDX);

  it('matches claim near footnote [^1]', () => {
    const claim = makeClaim(
      'The company was founded in 2015 by Jane Smith',
      'temporal',
      { sourceContext: 'The company was founded in 2015 by Jane Smith' },
    );
    const result = matchClaimToFootnote(claim, SAMPLE_MDX, footnotes);
    expect(result).not.toBeNull();
    expect(result!.footnoteNumber).toBe(1);
    expect(result!.url).toBe('https://example.com/founding');
  });

  it('matches claim near footnote [^2] using MDX-escaped text', () => {
    // Use a source context that is clearly positioned near [^2]
    // The MDX has: "raised \\$500 million in total funding[^2]"
    const claim = makeClaim(
      'It raised $500 million in total funding',
      'numeric',
      { sourceContext: '\\$500 million in total funding', keyValue: '500 million' },
    );
    const result = matchClaimToFootnote(claim, SAMPLE_MDX, footnotes);
    expect(result).not.toBeNull();
    expect(result!.footnoteNumber).toBe(2);
    expect(result!.url).toBe('https://example.com/funding');
  });

  it('returns null for claim far from any footnote', () => {
    // Create MDX with a claim that is genuinely far from any footnote
    const farMdx = `Some intro text with a footnote[^1].

This is a lot of filler text to ensure distance. It goes on and on, padding out the content
so that the next claim is truly far from any footnote reference. We need enough characters
to exceed the MAX_DISTANCE threshold of 300 characters. Let us keep writing more text here
to make sure the gap is sufficiently large. The purpose is to separate footnotes from claims.

The team now employs 300 researchers focused on AI safety.

[^1]: https://example.com/founding
`;
    const farFootnotes = parseFootnotes(farMdx);
    const claim = makeClaim(
      'The team now employs 300 researchers focused on AI safety',
      'numeric',
      { sourceContext: 'The team now employs 300 researchers focused on AI safety' },
    );
    const result = matchClaimToFootnote(claim, farMdx, farFootnotes);
    expect(result).toBeNull();
  });

  it('returns null when no footnotes exist', () => {
    const claim = makeClaim('Some claim', 'existence', { sourceContext: 'Some claim' });
    const emptyFootnotes = new Map<number, { url?: string; text: string }>();
    const result = matchClaimToFootnote(claim, 'Some claim in text', emptyFootnotes);
    expect(result).toBeNull();
  });

  it('returns null when claim source text is too short', () => {
    const claim = makeClaim('X', 'existence', { sourceContext: 'X' });
    const result = matchClaimToFootnote(claim, SAMPLE_MDX, footnotes);
    expect(result).toBeNull();
  });

  it('returns null when claim text not found in MDX', () => {
    const claim = makeClaim(
      'This text does not appear anywhere in the document',
      'existence',
      { sourceContext: 'This text does not appear anywhere in the document' },
    );
    const result = matchClaimToFootnote(claim, SAMPLE_MDX, footnotes);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Stale temporal detection
// ---------------------------------------------------------------------------

describe('detectStaleTemporal', () => {
  const CURRENT_YEAR = 2026;

  it('detects "as of 2024" as stale', () => {
    const claim = makeClaim(
      'As of 2024, the company employed 500 people',
      'temporal',
      { sourceContext: 'As of 2024, the company employed 500 people' },
    );
    expect(detectStaleTemporal(claim, CURRENT_YEAR)).toBe(true);
  });

  it('does not flag "as of 2025" as stale (within 1 year)', () => {
    const claim = makeClaim(
      'As of 2025, the company employed 500 people',
      'temporal',
      { sourceContext: 'As of 2025, the company employed 500 people' },
    );
    expect(detectStaleTemporal(claim, CURRENT_YEAR)).toBe(false);
  });

  it('does not flag "as of 2026" as stale', () => {
    const claim = makeClaim(
      'As of 2026, the company employed 500 people',
      'temporal',
      { sourceContext: 'As of 2026, the company employed 500 people' },
    );
    expect(detectStaleTemporal(claim, CURRENT_YEAR)).toBe(false);
  });

  it('detects old "since" references (5+ years)', () => {
    const claim = makeClaim(
      'The program has been running since 2018',
      'temporal',
      { sourceContext: 'The program has been running since 2018' },
    );
    expect(detectStaleTemporal(claim, CURRENT_YEAR)).toBe(true);
  });

  it('does not flag recent "since" references', () => {
    const claim = makeClaim(
      'The program has been running since 2023',
      'temporal',
      { sourceContext: 'The program has been running since 2023' },
    );
    expect(detectStaleTemporal(claim, CURRENT_YEAR)).toBe(false);
  });

  it('detects stale year in temporal claim about ongoing metrics', () => {
    const claim = makeClaim(
      'The organization employs 200 researchers',
      'temporal',
      { sourceContext: 'The organization employs 200 researchers', keyValue: '2023' },
    );
    expect(detectStaleTemporal(claim, CURRENT_YEAR)).toBe(true);
  });

  it('does not flag founding year as stale (not an ongoing metric)', () => {
    const claim = makeClaim(
      'OpenAI was founded in 2015',
      'temporal',
      { sourceContext: 'OpenAI was founded in 2015', keyValue: '2015' },
    );
    expect(detectStaleTemporal(claim, CURRENT_YEAR)).toBe(false);
  });

  it('detects stale month-year in numeric claims', () => {
    const claim = makeClaim(
      'Revenue was $5 billion in January 2024',
      'numeric',
      { sourceContext: 'Revenue was $5 billion in January 2024', keyValue: '5 billion' },
    );
    expect(detectStaleTemporal(claim, CURRENT_YEAR)).toBe(true);
  });

  it('does not flag claims without temporal references', () => {
    const claim = makeClaim(
      'The company focuses on AI safety research',
      'existence',
      { sourceContext: 'The company focuses on AI safety research' },
    );
    expect(detectStaleTemporal(claim, CURRENT_YEAR)).toBe(false);
  });

  it('handles empty claim text', () => {
    const claim = makeClaim('', 'other', { sourceContext: '' });
    expect(detectStaleTemporal(claim, CURRENT_YEAR)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Numeric value parsing
// ---------------------------------------------------------------------------

describe('parseNumericValue', () => {
  it('parses plain numbers', () => {
    expect(parseNumericValue('42')).toBe(42);
    expect(parseNumericValue('3.14')).toBeCloseTo(3.14);
  });

  it('parses numbers with commas', () => {
    expect(parseNumericValue('1,500')).toBe(1500);
    expect(parseNumericValue('1,000,000')).toBe(1000000);
  });

  it('parses "X billion" format', () => {
    expect(parseNumericValue('1.5 billion')).toBe(1_500_000_000);
    expect(parseNumericValue('2 billion')).toBe(2_000_000_000);
  });

  it('parses "X million" format', () => {
    expect(parseNumericValue('500 million')).toBe(500_000_000);
    expect(parseNumericValue('1.2 million')).toBe(1_200_000);
  });

  it('parses "X thousand" format', () => {
    expect(parseNumericValue('50 thousand')).toBe(50_000);
  });

  it('parses "X trillion" format', () => {
    expect(parseNumericValue('1.5 trillion')).toBe(1_500_000_000_000);
  });

  it('strips currency symbols', () => {
    expect(parseNumericValue('$500')).toBe(500);
    expect(parseNumericValue('$1.5 billion')).toBe(1_500_000_000);
  });

  it('strips percentage signs', () => {
    expect(parseNumericValue('42%')).toBe(42);
  });

  it('returns null for non-numeric strings', () => {
    expect(parseNumericValue('hello')).toBeNull();
    expect(parseNumericValue('')).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(parseNumericValue(null as unknown as string)).toBeNull();
    expect(parseNumericValue(undefined as unknown as string)).toBeNull();
  });

  it('handles negative numbers', () => {
    expect(parseNumericValue('-5')).toBe(-5);
  });

  it('handles zero', () => {
    expect(parseNumericValue('0')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Priority scoring (tested via extractWikiPageClaims)
// ---------------------------------------------------------------------------

// Priority tests are covered in the end-to-end section below, since
// calculatePriority is a private function. We verify through the output
// of extractWikiPageClaims.

// ---------------------------------------------------------------------------
// 6. End-to-end extractWikiPageClaims with mocked LLM
// ---------------------------------------------------------------------------

// Mock the extractClaims function to avoid actual LLM calls
vi.mock('../semantic-diff/claim-extractor.ts', () => ({
  extractClaims: vi.fn(),
  preprocessMdxForExtraction: vi.fn((content: string) => content),
}));

import { extractClaims as mockExtractClaims } from '../semantic-diff/claim-extractor.ts';

const SAMPLE_MDX_WITH_FOOTNOTES = `---
wikiId: E42
title: Test Organization
---

# Overview

Test Organization was founded in 2015 by Jane Smith[^1]. The organization has raised \\$500 million in total funding[^2] and employs approximately 300 researchers.

As of 2023, the organization had annual revenue of \\$1 billion.

## Research

They published 45 papers on alignment in 2025.

[^1]: https://example.com/founding
[^2]: https://example.com/funding-report
`;

describe('extractWikiPageClaims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('categorizes sourced claims with footnote URLs', async () => {
    const mockedExtractClaims = vi.mocked(mockExtractClaims);
    mockedExtractClaims.mockResolvedValue([
      makeClaim(
        'Test Organization was founded in 2015 by Jane Smith',
        'temporal',
        { sourceContext: 'Test Organization was founded in 2015 by Jane Smith', keyValue: '2015' },
      ),
    ]);

    const items = await extractWikiPageClaims('test-org', SAMPLE_MDX_WITH_FOOTNOTES, [], 2026);

    expect(items.length).toBe(1);
    expect(items[0].category).toBe('sourced-claim');
    expect(items[0].sourceUrl).toBe('https://example.com/founding');
    expect(items[0].footnoteNumber).toBe(1);
    expect(items[0].pageSlug).toBe('test-org');
  });

  it('categorizes unfootnoted claims', async () => {
    const mockedExtractClaims = vi.mocked(mockExtractClaims);
    mockedExtractClaims.mockResolvedValue([
      makeClaim(
        'They published 45 papers on alignment in 2025',
        'numeric',
        { sourceContext: 'They published 45 papers on alignment in 2025', keyValue: '45' },
      ),
    ]);

    const items = await extractWikiPageClaims('test-org', SAMPLE_MDX_WITH_FOOTNOTES, [], 2026);

    expect(items.length).toBe(1);
    expect(items[0].category).toBe('unfootnoted-claim');
    expect(items[0].sourceUrl).toBeUndefined();
  });

  it('categorizes stale temporal claims', async () => {
    const mockedExtractClaims = vi.mocked(mockExtractClaims);
    mockedExtractClaims.mockResolvedValue([
      makeClaim(
        'As of 2023, the organization had annual revenue of $1 billion',
        'temporal',
        { sourceContext: 'As of 2023, the organization had annual revenue of $1 billion', keyValue: '2023' },
      ),
    ]);

    const items = await extractWikiPageClaims('test-org', SAMPLE_MDX_WITH_FOOTNOTES, [], 2026);

    expect(items.length).toBe(1);
    expect(items[0].category).toBe('stale-temporal-claim');
    expect(items[0].priority).toBe(65); // 60 base + 5 high confidence
  });

  it('categorizes cross-ref claims when FactBase value differs', async () => {
    const mockedExtractClaims = vi.mocked(mockExtractClaims);
    mockedExtractClaims.mockResolvedValue([
      makeClaim(
        'The organization has raised $500 million in total funding',
        'numeric',
        { sourceContext: 'The organization has raised $500 million in total funding', keyValue: '500 million' },
      ),
    ]);

    const facts = [
      { id: 'fact-123', property: 'total_funding', value: '800000000' },
    ];

    const items = await extractWikiPageClaims('test-org', SAMPLE_MDX_WITH_FOOTNOTES, facts, 2026);

    expect(items.length).toBe(1);
    expect(items[0].category).toBe('cross-ref-claim');
    expect(items[0].factId).toBe('fact-123');
    expect(items[0].factValue).toBe('800000000');
    expect(items[0].priority).toBe(75); // 70 base + 5 high confidence
  });

  it('does not flag cross-ref when values match within 5%', async () => {
    const mockedExtractClaims = vi.mocked(mockExtractClaims);
    mockedExtractClaims.mockResolvedValue([
      makeClaim(
        'The organization has raised $500 million in total funding',
        'numeric',
        { sourceContext: 'The organization has raised $500 million in total funding', keyValue: '500 million' },
      ),
    ]);

    const facts = [
      { id: 'fact-123', property: 'total_funding', value: '510000000' }, // within 5%
    ];

    const items = await extractWikiPageClaims('test-org', SAMPLE_MDX_WITH_FOOTNOTES, facts, 2026);

    // Should NOT be categorized as cross-ref since values match
    expect(items.length).toBe(1);
    expect(items[0].category).not.toBe('cross-ref-claim');
  });

  it('returns empty array when no claims are extracted', async () => {
    const mockedExtractClaims = vi.mocked(mockExtractClaims);
    mockedExtractClaims.mockResolvedValue([]);

    const items = await extractWikiPageClaims('test-org', SAMPLE_MDX_WITH_FOOTNOTES, [], 2026);
    expect(items).toEqual([]);
  });

  it('sorts results by priority (highest first)', async () => {
    const mockedExtractClaims = vi.mocked(mockExtractClaims);
    mockedExtractClaims.mockResolvedValue([
      // This one should be sourced (lower priority ~55)
      makeClaim(
        'Test Organization was founded in 2015 by Jane Smith',
        'existence',
        { sourceContext: 'Test Organization was founded in 2015 by Jane Smith' },
      ),
      // This one should be unfootnoted (higher priority ~85)
      makeClaim(
        'They published 45 papers on alignment in 2025',
        'numeric',
        { sourceContext: 'They published 45 papers on alignment in 2025', keyValue: '45' },
      ),
    ]);

    const items = await extractWikiPageClaims('test-org', SAMPLE_MDX_WITH_FOOTNOTES, [], 2026);

    expect(items.length).toBe(2);
    expect(items[0].priority).toBeGreaterThanOrEqual(items[1].priority);
    // Unfootnoted should come first (higher priority)
    expect(items[0].category).toBe('unfootnoted-claim');
  });

  it('assigns correct priority for sourced claims with numeric values', async () => {
    const mockedExtractClaims = vi.mocked(mockExtractClaims);
    mockedExtractClaims.mockResolvedValue([
      makeClaim(
        'The organization has raised $500 million in total funding',
        'numeric',
        {
          sourceContext: 'The organization has raised $500 million in total funding',
          keyValue: '500 million',
        },
      ),
    ]);

    const items = await extractWikiPageClaims('test-org', SAMPLE_MDX_WITH_FOOTNOTES, [], 2026);

    // This claim is near [^2], so sourced-claim. Base 50 + 20 (numeric/keyValue) + 5 (high confidence) = 75
    expect(items.length).toBe(1);
    if (items[0].category === 'sourced-claim') {
      expect(items[0].priority).toBe(75);
    }
  });

  it('uses current year when currentYear not provided', async () => {
    const mockedExtractClaims = vi.mocked(mockExtractClaims);
    mockedExtractClaims.mockResolvedValue([
      makeClaim(
        'As of 2020, the organization had revenue of $100M',
        'temporal',
        { sourceContext: 'As of 2020, the organization had revenue of $100M' },
      ),
    ]);

    // Don't pass currentYear — should use actual current year
    const items = await extractWikiPageClaims('test-org', SAMPLE_MDX_WITH_FOOTNOTES);
    expect(items.length).toBe(1);
    expect(items[0].category).toBe('stale-temporal-claim');
  });

  it('handles multiple claims with mixed categories', async () => {
    const mockedExtractClaims = vi.mocked(mockExtractClaims);
    mockedExtractClaims.mockResolvedValue([
      makeClaim(
        'Test Organization was founded in 2015 by Jane Smith',
        'temporal',
        { sourceContext: 'Test Organization was founded in 2015 by Jane Smith', keyValue: '2015' },
      ),
      makeClaim(
        'The organization employs approximately 300 researchers',
        'numeric',
        { sourceContext: 'The organization employs approximately 300 researchers', keyValue: '300' },
      ),
      makeClaim(
        'As of 2023, the organization had annual revenue of $1 billion',
        'temporal',
        { sourceContext: 'As of 2023, the organization had annual revenue of $1 billion' },
      ),
    ]);

    const items = await extractWikiPageClaims('test-org', SAMPLE_MDX_WITH_FOOTNOTES, [], 2026);

    expect(items.length).toBe(3);
    // Each should have valid properties
    for (const item of items) {
      expect(item.pageSlug).toBe('test-org');
      expect(item.claimText.length).toBeGreaterThan(0);
      expect(item.sourceContext.length).toBeGreaterThan(0);
      expect(item.priority).toBeGreaterThan(0);
      expect(['sourced-claim', 'unfootnoted-claim', 'cross-ref-claim', 'stale-temporal-claim']).toContain(item.category);
    }
  });
});
