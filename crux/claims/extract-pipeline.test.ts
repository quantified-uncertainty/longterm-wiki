/**
 * Claims Extraction Pipeline — Unit Tests
 *
 * Tests the claims extraction and resource ingestion pipelines,
 * including LLM response parsing with mocked callOpenRouter.
 *
 * Addresses issue #1079: 1,300 lines of untested code in extract.ts,
 * ingest-resource.ts, and verify.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  cleanMdxForExtraction,
  splitIntoSections,
  EXTRACT_SYSTEM_PROMPT,
} from './extract.ts';
import {
  buildExtractionPrompt,
  buildInsertItem,
  extractClaimsForEntity,
  type ExtractedResourceClaim,
} from './ingest-resource.ts';
import {
  parseNumericValue,
  claimTypeToCategory,
  VALID_CLAIM_TYPES,
} from '../lib/claim-utils.ts';

// ---------------------------------------------------------------------------
// Mock callOpenRouter for LLM-dependent tests
// ---------------------------------------------------------------------------

vi.mock('../lib/quote-extractor.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/quote-extractor.ts')>('../lib/quote-extractor.ts');
  return {
    ...actual,
    callOpenRouter: vi.fn(),
  };
});

// Import the mocked function
import { callOpenRouter } from '../lib/quote-extractor.ts';
const mockCallOpenRouter = vi.mocked(callOpenRouter);

// ---------------------------------------------------------------------------
// parseNumericValue — pure function tests
// ---------------------------------------------------------------------------

describe('parseNumericValue', () => {
  it('parses finite numbers', () => {
    expect(parseNumericValue(42)).toBe(42);
    expect(parseNumericValue(0.92)).toBe(0.92);
    expect(parseNumericValue(-100)).toBe(-100);
  });

  it('parses string numbers', () => {
    expect(parseNumericValue('7300000000')).toBe(7300000000);
    expect(parseNumericValue('0.92')).toBe(0.92);
    expect(parseNumericValue('-50')).toBe(-50);
  });

  it('parses comma-separated string numbers', () => {
    expect(parseNumericValue('1,000,000')).toBe(1000000);
    expect(parseNumericValue('7,300,000,000')).toBe(7300000000);
  });

  it('parses scientific notation', () => {
    expect(parseNumericValue('1e9')).toBe(1e9);
    expect(parseNumericValue(1e9)).toBe(1e9);
  });

  it('returns undefined for NaN', () => {
    expect(parseNumericValue(NaN)).toBeUndefined();
  });

  it('returns undefined for Infinity', () => {
    expect(parseNumericValue(Infinity)).toBeUndefined();
    expect(parseNumericValue(-Infinity)).toBeUndefined();
  });

  it('returns undefined for non-numeric strings', () => {
    expect(parseNumericValue('hello')).toBeUndefined();
    expect(parseNumericValue('')).toBeUndefined();
  });

  it('returns undefined for null/undefined/objects', () => {
    expect(parseNumericValue(null)).toBeUndefined();
    expect(parseNumericValue(undefined)).toBeUndefined();
    expect(parseNumericValue({})).toBeUndefined();
    expect(parseNumericValue([])).toBeUndefined();
  });

  it('returns undefined for booleans', () => {
    expect(parseNumericValue(true)).toBeUndefined();
    expect(parseNumericValue(false)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// claimTypeToCategory — pure function tests
// ---------------------------------------------------------------------------

describe('claimTypeToCategory', () => {
  it('maps factual types to factual category', () => {
    expect(claimTypeToCategory('factual')).toBe('factual');
    expect(claimTypeToCategory('numeric')).toBe('factual');
    expect(claimTypeToCategory('historical')).toBe('factual');
  });

  it('maps evaluative and consensus to opinion', () => {
    expect(claimTypeToCategory('evaluative')).toBe('opinion');
    expect(claimTypeToCategory('consensus')).toBe('opinion');
  });

  it('maps causal to analytical', () => {
    expect(claimTypeToCategory('causal')).toBe('analytical');
  });

  it('maps speculative to speculative', () => {
    expect(claimTypeToCategory('speculative')).toBe('speculative');
  });

  it('maps relational to relational', () => {
    expect(claimTypeToCategory('relational')).toBe('relational');
  });

  it('covers all VALID_CLAIM_TYPES', () => {
    // Ensure no new type is added without a category mapping
    for (const t of VALID_CLAIM_TYPES) {
      expect(typeof claimTypeToCategory(t)).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// cleanMdxForExtraction — edge cases beyond source-linking.test.ts
// ---------------------------------------------------------------------------

describe('cleanMdxForExtraction edge cases', () => {
  it('handles nested JSX components', () => {
    const input = '<Callout type="info">Some <strong>bold</strong> text</Callout>';
    const result = cleanMdxForExtraction(input);
    expect(result).not.toContain('<Callout');
  });

  it('removes MDX curly expressions', () => {
    const input = 'Value is {someVariable} and {/* a comment */} more text.';
    const result = cleanMdxForExtraction(input);
    expect(result).not.toContain('{someVariable}');
    expect(result).not.toContain('{/* a comment */}');
    expect(result).toContain('more text');
  });

  it('collapses multiple blank lines', () => {
    const input = 'Line 1\n\n\n\n\nLine 2';
    const result = cleanMdxForExtraction(input);
    expect(result).toBe('Line 1\n\nLine 2');
  });

  it('handles empty input', () => {
    expect(cleanMdxForExtraction('')).toBe('');
  });

  it('handles multiple <R> tags in same text', () => {
    const input = 'See <R id="abc">First</R> and <R id="def">Second</R>.';
    const result = cleanMdxForExtraction(input);
    expect(result).toContain('[^R:abc]');
    expect(result).toContain('[^R:def]');
  });
});

// ---------------------------------------------------------------------------
// splitIntoSections — edge cases
// ---------------------------------------------------------------------------

describe('splitIntoSections edge cases', () => {
  it('handles empty document', () => {
    expect(splitIntoSections('')).toHaveLength(0);
  });

  it('handles document with only H2 headings and no content', () => {
    const body = '## Heading 1\n## Heading 2\n## Heading 3';
    expect(splitIntoSections(body)).toHaveLength(0);
  });

  it('handles H3 headings', () => {
    const body = `### Sub-section

This sub-section has enough content to be included in the output for extraction purposes here.`;
    const sections = splitIntoSections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('Sub-section');
    expect(sections[0].level).toBe(3);
  });

  it('preserves content between headings exactly at boundary (50 chars)', () => {
    // Exactly 50 chars - should be included (>50 is the threshold, so 50 chars is NOT included)
    const body = '## Section\n' + 'a'.repeat(50);
    const sections = splitIntoSections(body);
    expect(sections).toHaveLength(0); // 50 chars is NOT > 50
  });

  it('includes content at 51 chars', () => {
    const body = '## Section\n' + 'a'.repeat(51);
    const sections = splitIntoSections(body);
    expect(sections).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildInsertItem — edge cases beyond source-linking.test.ts
// ---------------------------------------------------------------------------

describe('buildInsertItem edge cases', () => {
  const baseResource = {
    id: 'resource-123',
    title: 'Example',
    url: 'https://example.com',
    type: 'article' as const,
    authors: ['Jane Doe'],
    published_date: '2024-03-15',
  };

  it('falls back attributedTo to resource author for attributed claims', () => {
    const claim: ExtractedResourceClaim = {
      claimText: 'The company plans to expand.',
      claimType: 'factual',
      relevance: 'direct',
      claimMode: 'attributed',
      relatedEntities: [],
    };
    const item = buildInsertItem(claim, 'kalshi', baseResource);
    expect(item.attributedTo).toBe('Jane Doe');
  });

  it('falls back asOf to resource published_date', () => {
    const claim: ExtractedResourceClaim = {
      claimText: 'Revenue was $100M.',
      claimType: 'numeric',
      relevance: 'direct',
      claimMode: 'endorsed',
      relatedEntities: [],
    };
    const item = buildInsertItem(claim, 'kalshi', baseResource);
    expect(item.asOf).toBe('2024-03-15');
  });

  it('preserves numeric fields', () => {
    const claim: ExtractedResourceClaim = {
      claimText: 'Revenue was between $90M and $110M.',
      claimType: 'numeric',
      relevance: 'direct',
      claimMode: 'endorsed',
      valueNumeric: 100000000,
      valueLow: 90000000,
      valueHigh: 110000000,
      measure: 'revenue',
      relatedEntities: [],
    };
    const item = buildInsertItem(claim, 'kalshi', baseResource);
    expect(item.valueNumeric).toBe(100000000);
    expect(item.valueLow).toBe(90000000);
    expect(item.valueHigh).toBe(110000000);
    expect(item.measure).toBe('revenue');
  });

  it('preserves relatedEntities', () => {
    const claim: ExtractedResourceClaim = {
      claimText: 'Kalshi competes with Polymarket.',
      claimType: 'relational',
      relevance: 'direct',
      claimMode: 'endorsed',
      relatedEntities: ['polymarket'],
    };
    const item = buildInsertItem(claim, 'kalshi', baseResource);
    expect(item.relatedEntities).toEqual(['polymarket']);
  });

  it('sets resourceIds to contain resource ID', () => {
    const claim: ExtractedResourceClaim = {
      claimText: 'Some claim.',
      claimType: 'factual',
      relevance: 'direct',
      claimMode: 'endorsed',
      relatedEntities: [],
    };
    const item = buildInsertItem(claim, 'kalshi', baseResource);
    expect(item.resourceIds).toEqual(['resource-123']);
  });
});

// ---------------------------------------------------------------------------
// extractClaimsForEntity — LLM response parsing (mocked)
// ---------------------------------------------------------------------------

describe('extractClaimsForEntity (mocked LLM)', () => {
  const resource = {
    id: 'test-resource',
    title: 'Test Article',
    url: 'https://example.com/article',
    authors: ['Jane Doe'],
    type: 'article' as const,
  };

  beforeEach(() => {
    mockCallOpenRouter.mockReset();
  });

  it('parses well-formed LLM response with sourceQuote', async () => {
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({
      claims: [{
        claimText: 'Kalshi was founded in 2018.',
        claimType: 'factual',
        relevance: 'direct',
        claimMode: 'endorsed',
        sourceQuote: 'Kalshi, founded in 2018, is an event-based trading platform.',
        relatedEntities: [],
      }],
    }));

    const claims = await extractClaimsForEntity('Some resource text', resource, 'kalshi');
    expect(claims).toHaveLength(1);
    expect(claims[0].claimText).toBe('Kalshi was founded in 2018.');
    expect(claims[0].sourceQuote).toBe('Kalshi, founded in 2018, is an event-based trading platform.');
    expect(claims[0].claimMode).toBe('endorsed');
  });

  it('handles code-fenced JSON response', async () => {
    mockCallOpenRouter.mockResolvedValue('```json\n{"claims": [{"claimText": "Kalshi raised $30M.", "claimType": "numeric", "relevance": "direct", "claimMode": "endorsed", "sourceQuote": "raised $30M", "relatedEntities": [], "valueNumeric": 30000000}]}\n```');

    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims).toHaveLength(1);
    expect(claims[0].claimText).toBe('Kalshi raised $30M.');
    expect(claims[0].valueNumeric).toBe(30000000);
  });

  it('filters out claims with short claimText (<= 10 chars)', async () => {
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({
      claims: [
        { claimText: 'Short', claimType: 'factual', relevance: 'direct', claimMode: 'endorsed', relatedEntities: [] },
        { claimText: 'This claim is long enough to pass the filter.', claimType: 'factual', relevance: 'direct', claimMode: 'endorsed', relatedEntities: [] },
      ],
    }));

    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims).toHaveLength(1);
    expect(claims[0].claimText).toBe('This claim is long enough to pass the filter.');
  });

  it('defaults invalid claimType to factual', async () => {
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({
      claims: [{
        claimText: 'Kalshi was founded in 2018.',
        claimType: 'invented_type',
        relevance: 'direct',
        claimMode: 'endorsed',
        relatedEntities: [],
      }],
    }));

    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims[0].claimType).toBe('factual');
  });

  it('defaults invalid relevance to contextual', async () => {
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({
      claims: [{
        claimText: 'Kalshi was founded in 2018.',
        claimType: 'factual',
        relevance: 'tangential',
        claimMode: 'endorsed',
        relatedEntities: [],
      }],
    }));

    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims[0].relevance).toBe('contextual');
  });

  it('defaults non-attributed claimMode to endorsed', async () => {
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({
      claims: [{
        claimText: 'Kalshi was founded in 2018.',
        claimType: 'factual',
        relevance: 'direct',
        claimMode: 'something_else',
        relatedEntities: [],
      }],
    }));

    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims[0].claimMode).toBe('endorsed');
  });

  it('handles empty claims array', async () => {
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({ claims: [] }));
    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims).toHaveLength(0);
  });

  it('handles missing claims field', async () => {
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({ result: 'no claims found' }));
    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims).toHaveLength(0);
  });

  it('handles LLM error gracefully (returns empty array)', async () => {
    mockCallOpenRouter.mockRejectedValue(new Error('Rate limit exceeded'));
    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims).toHaveLength(0);
  });

  it('validates asOf date format', async () => {
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({
      claims: [
        { claimText: 'Valid date claim one.', claimType: 'factual', relevance: 'direct', claimMode: 'endorsed', asOf: '2024-03', relatedEntities: [] },
        { claimText: 'Invalid date claim.', claimType: 'factual', relevance: 'direct', claimMode: 'endorsed', asOf: 'March 2024', relatedEntities: [] },
        { claimText: 'Full date claim here.', claimType: 'factual', relevance: 'direct', claimMode: 'endorsed', asOf: '2024-03-15', relatedEntities: [] },
      ],
    }));

    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims[0].asOf).toBe('2024-03');
    expect(claims[1].asOf).toBeUndefined(); // Invalid format filtered
    expect(claims[2].asOf).toBe('2024-03-15');
  });

  it('truncates sourceQuote to 500 chars', async () => {
    const longQuote = 'a'.repeat(600);
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({
      claims: [{
        claimText: 'Claim with very long quote.',
        claimType: 'factual',
        relevance: 'direct',
        claimMode: 'endorsed',
        sourceQuote: longQuote,
        relatedEntities: [],
      }],
    }));

    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims[0].sourceQuote!.length).toBe(500);
  });

  it('rejects sourceQuote <= 5 chars', async () => {
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({
      claims: [{
        claimText: 'Claim with tiny source quote.',
        claimType: 'factual',
        relevance: 'direct',
        claimMode: 'endorsed',
        sourceQuote: 'tiny',
        relatedEntities: [],
      }],
    }));

    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims[0].sourceQuote).toBeUndefined();
  });

  it('preserves attributed claimMode and attributedTo', async () => {
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({
      claims: [{
        claimText: 'According to the CEO, revenue doubled.',
        claimType: 'factual',
        relevance: 'direct',
        claimMode: 'attributed',
        attributedTo: 'the CEO',
        relatedEntities: [],
      }],
    }));

    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims[0].claimMode).toBe('attributed');
    expect(claims[0].attributedTo).toBe('the CEO');
  });

  it('handles relatedEntities as strings', async () => {
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({
      claims: [{
        claimText: 'Kalshi competes with Polymarket in event markets.',
        claimType: 'relational',
        relevance: 'direct',
        claimMode: 'endorsed',
        relatedEntities: ['polymarket', 'metaculus'],
      }],
    }));

    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims[0].relatedEntities).toEqual(['polymarket', 'metaculus']);
  });

  it('handles non-array relatedEntities (defaults to empty)', async () => {
    mockCallOpenRouter.mockResolvedValue(JSON.stringify({
      claims: [{
        claimText: 'Some claim without entities.',
        claimType: 'factual',
        relevance: 'direct',
        claimMode: 'endorsed',
        relatedEntities: 'polymarket',
      }],
    }));

    const claims = await extractClaimsForEntity('Some text', resource, 'kalshi');
    expect(claims[0].relatedEntities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildExtractionPrompt — edge cases
// ---------------------------------------------------------------------------

describe('buildExtractionPrompt edge cases', () => {
  it('handles missing title and authors', () => {
    const resource = {
      id: 'minimal-resource',
      url: 'https://example.com',
      title: 'Unknown',
      type: 'article' as const,
    };
    const prompt = buildExtractionPrompt(resource, 'kalshi');
    expect(prompt).toContain('Unknown');
    expect(prompt).toContain('kalshi');
  });

  it('includes entity name in relevance guidance', () => {
    const resource = {
      id: 'test',
      title: 'Test',
      url: 'https://example.com',
      type: 'article' as const,
    };
    const prompt = buildExtractionPrompt(resource, 'anthropic');
    expect(prompt).toContain('"anthropic"');
    expect(prompt).toContain('direct');
    expect(prompt).toContain('contextual');
    expect(prompt).toContain('background');
  });
});

// ---------------------------------------------------------------------------
// EXTRACT_SYSTEM_PROMPT content validation
// ---------------------------------------------------------------------------

describe('EXTRACT_SYSTEM_PROMPT content', () => {
  it('lists all valid claim types', () => {
    for (const t of VALID_CLAIM_TYPES) {
      expect(EXTRACT_SYSTEM_PROMPT).toContain(`"${t}"`);
    }
  });

  it('describes endorsed and attributed claimModes', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain('"endorsed"');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('"attributed"');
  });

  it('describes phase 2 fields', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain('"asOf"');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('"measure"');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('"valueNumeric"');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('"valueLow"');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('"valueHigh"');
  });

  it('includes footnoteRefs instruction', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain('"footnoteRefs"');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('[^N]');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('[^R:HASH]');
  });
});
