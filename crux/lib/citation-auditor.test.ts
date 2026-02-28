/**
 * Tests for citation-auditor.ts
 *
 * Covers: parseVerifierResponse, auditCitations with cached sources,
 * pass/fail gate logic, unchecked/dead URL handling, and ClaimMap usage.
 *
 * LLM calls and source-fetcher network calls are mocked so tests run
 * offline and deterministically.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseVerifierResponse,
  parseBatchVerifierResponse,
  auditCitations,
  inferSourceContext,
  detectUnsourcedTableCells,
  NUMERIC_CLAIM_PATTERN,
  type AuditRequest,
  type SourceCache,
  type ClaimMap,
} from './citation-auditor.ts';
import type { FetchedSource } from './source-fetcher.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the LLM layer so tests don't need API keys.
vi.mock('./quote-extractor.ts', () => ({
  callOpenRouter: vi.fn(),
  stripCodeFences: (s: string) => s.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim(),
  truncateSource: (s: string) => s,
  DEFAULT_CITATION_MODEL: 'google/gemini-2.0-flash-001',
}));

// Mock the source-fetcher so network calls don't happen.
vi.mock('./source-fetcher.ts', () => ({
  fetchSource: vi.fn(),
}));

// Mock citation-content-cache (pulled in transitively via citation-archive.ts).
vi.mock('./citation-content-cache.ts', () => ({
  getCachedContent: vi.fn(() => null),
  setCachedContent: vi.fn(),
}));

import { callOpenRouter } from './quote-extractor.ts';
import { fetchSource } from './source-fetcher.ts';

const mockCallOpenRouter = vi.mocked(callOpenRouter);
const mockFetchSource = vi.mocked(fetchSource);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchedSource(overrides: Partial<FetchedSource> = {}): FetchedSource {
  return {
    url: 'https://example.com',
    title: 'Example',
    fetchedAt: new Date().toISOString(),
    // Content must be ≥ 50 chars to pass the minimum-content check in auditCitations.
    content: 'This is the source content. It discusses AI safety at length and provides relevant context.',
    relevantExcerpts: [],
    status: 'ok',
    ...overrides,
  };
}

/** Minimal MDX body with one citation. */
const ONE_CITATION_CONTENT = `---
title: Test Page
---

AI safety is important.[^1]

[^1]: [Example Source](https://example.com/source)
`;

/** MDX body with three citations. */
const THREE_CITATION_CONTENT = `---
title: Test Page
---

First claim.[^1] Second claim.[^2] Third claim.[^3]

[^1]: [Source One](https://example.com/one)
[^2]: [Source Two](https://example.com/two)
[^3]: [Source Three](https://example.com/three)
`;

// ---------------------------------------------------------------------------
// parseVerifierResponse
// ---------------------------------------------------------------------------

describe('parseVerifierResponse', () => {
  it('parses a valid verified response', () => {
    const raw = JSON.stringify({
      verdict: 'verified',
      relevantQuote: 'The source confirms this.',
      explanation: 'The source directly states the claim.',
    });
    const result = parseVerifierResponse(raw);
    expect(result.verdict).toBe('verified');
    expect(result.relevantQuote).toBe('The source confirms this.');
    expect(result.explanation).toBe('The source directly states the claim.');
  });

  it('parses unsupported and misattributed verdicts', () => {
    const unsupported = parseVerifierResponse(JSON.stringify({ verdict: 'unsupported', relevantQuote: '', explanation: 'Not in source.' }));
    expect(unsupported.verdict).toBe('unsupported');

    const misattributed = parseVerifierResponse(JSON.stringify({ verdict: 'misattributed', relevantQuote: 'wrong numbers', explanation: 'Numbers differ.' }));
    expect(misattributed.verdict).toBe('misattributed');
  });

  it('falls back to unchecked for unknown verdicts', () => {
    const result = parseVerifierResponse(JSON.stringify({ verdict: 'fabricated', relevantQuote: '', explanation: 'ok' }));
    expect(result.verdict).toBe('unchecked');
    expect(result.explanation).toContain('Unknown verdict');
  });

  it('handles malformed JSON gracefully as unchecked', () => {
    const result = parseVerifierResponse('not json at all');
    expect(result.verdict).toBe('unchecked');
    expect(result.explanation).toBe('Failed to parse verification response.');
  });

  it('handles missing fields with defaults', () => {
    const result = parseVerifierResponse(JSON.stringify({ verdict: 'verified' }));
    expect(result.verdict).toBe('verified');
    expect(result.relevantQuote).toBe('');
    expect(result.explanation).toBe('No explanation provided.');
  });

  it('strips markdown code fences from response', () => {
    // The stripCodeFences mock just trims the fences
    const raw = '```json\n{"verdict":"verified","relevantQuote":"q","explanation":"e"}\n```';
    const result = parseVerifierResponse(raw);
    expect(result.verdict).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// auditCitations — source cache path (no network calls)
// ---------------------------------------------------------------------------

describe('auditCitations with sourceCache', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns verified when LLM says verified', async () => {
    mockCallOpenRouter.mockResolvedValue(
      JSON.stringify({ verdict: 'verified', relevantQuote: 'AI safety matters.', explanation: 'Directly stated.' }),
    );

    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({ url: 'https://example.com/source', content: 'AI safety matters. The field requires careful work to ensure alignment between AI systems and human values.' })],
    ]);

    const result = await auditCitations({
      content: ONE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
    });

    expect(result.summary.total).toBe(1);
    expect(result.summary.verified).toBe(1);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.unchecked).toBe(0);
    expect(result.pass).toBe(true);
    expect(result.citations[0].verdict).toBe('verified');
    expect(result.citations[0].relevantQuote).toBe('AI safety matters.');
    expect(mockFetchSource).not.toHaveBeenCalled();
  });

  it('returns unsupported when LLM says unsupported', async () => {
    mockCallOpenRouter.mockResolvedValue(
      JSON.stringify({ verdict: 'unsupported', relevantQuote: '', explanation: 'Not found in source.' }),
    );

    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({ url: 'https://example.com/source' })],
    ]);

    const result = await auditCitations({
      content: ONE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      passThreshold: 0.8,
      delayMs: 0,
    });

    expect(result.summary.failed).toBe(1);
    expect(result.summary.verified).toBe(0);
    expect(result.pass).toBe(false);
    expect(result.citations[0].verdict).toBe('unsupported');
  });

  it('returns misattributed verdict correctly', async () => {
    mockCallOpenRouter.mockResolvedValue(
      JSON.stringify({ verdict: 'misattributed', relevantQuote: 'Source says 30%.', explanation: 'Claim says 50% but source says 30%.' }),
    );

    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({ url: 'https://example.com/source' })],
    ]);

    const result = await auditCitations({
      content: ONE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
    });

    expect(result.citations[0].verdict).toBe('misattributed');
    expect(result.citations[0].relevantQuote).toBe('Source says 30%.');
    expect(result.summary.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// auditCitations — unchecked and dead URL cases
// ---------------------------------------------------------------------------

describe('auditCitations URL status handling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('marks citation as unchecked when fetchMissing=false and URL not in cache', async () => {
    const result = await auditCitations({
      content: ONE_CITATION_CONTENT,
      fetchMissing: false,
      delayMs: 0,
    });

    expect(result.summary.unchecked).toBe(1);
    expect(result.summary.verified).toBe(0);
    expect(result.citations[0].verdict).toBe('unchecked');
    expect(result.pass).toBe(true); // nothing checkable → pass
    expect(mockCallOpenRouter).not.toHaveBeenCalled();
    expect(mockFetchSource).not.toHaveBeenCalled();
  });

  it('fetches missing URL when fetchMissing=true', async () => {
    const longContent = 'Some content here about AI safety that is long enough to pass the minimum content length check for verification purposes.';
    mockFetchSource.mockResolvedValue(makeFetchedSource({ url: 'https://example.com/source', content: longContent }));
    mockCallOpenRouter.mockResolvedValue(
      JSON.stringify({ verdict: 'verified', relevantQuote: 'content', explanation: 'Found it.' }),
    );

    const result = await auditCitations({
      content: ONE_CITATION_CONTENT,
      fetchMissing: true,
      delayMs: 0,
    });

    expect(mockFetchSource).toHaveBeenCalledWith({ url: 'https://example.com/source', extractMode: 'full' });
    expect(result.citations[0].verdict).toBe('verified');
  });

  it('marks citation as url-dead when source status is dead', async () => {
    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({ url: 'https://example.com/source', status: 'dead', content: '' })],
    ]);

    const result = await auditCitations({
      content: ONE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
    });

    expect(result.citations[0].verdict).toBe('url-dead');
    expect(result.summary.unchecked).toBe(1); // url-dead counts as unchecked in summary
    expect(mockCallOpenRouter).not.toHaveBeenCalled();
  });

  it('marks citation as unchecked when source status is error', async () => {
    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({ url: 'https://example.com/source', status: 'error', content: '' })],
    ]);

    const result = await auditCitations({
      content: ONE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
    });

    expect(result.citations[0].verdict).toBe('unchecked');
  });

  it('marks citation as unchecked when source is behind a paywall', async () => {
    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({ url: 'https://example.com/source', status: 'paywall', content: 'subscribe to read' })],
    ]);

    const result = await auditCitations({
      content: ONE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
    });

    expect(result.citations[0].verdict).toBe('unchecked');
    expect(result.citations[0].explanation).toContain('paywall');
  });
});

// ---------------------------------------------------------------------------
// auditCitations — pass/fail gate
// ---------------------------------------------------------------------------

describe('auditCitations pass/fail gate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes when all checkable citations are verified', async () => {
    // 3 citations, all verified
    mockCallOpenRouter.mockResolvedValue(
      JSON.stringify({ verdict: 'verified', relevantQuote: '', explanation: 'ok' }),
    );

    const sourceCache: SourceCache = new Map([
      ['https://example.com/one', makeFetchedSource({ url: 'https://example.com/one' })],
      ['https://example.com/two', makeFetchedSource({ url: 'https://example.com/two' })],
      ['https://example.com/three', makeFetchedSource({ url: 'https://example.com/three' })],
    ]);

    const result = await auditCitations({
      content: THREE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      passThreshold: 0.8,
      delayMs: 0,
    });

    expect(result.summary.verified).toBe(3);
    expect(result.pass).toBe(true);
  });

  it('fails when too many citations are unsupported', async () => {
    // 3 citations: 1 verified, 2 unsupported → 33% pass rate < 80% threshold
    mockCallOpenRouter
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'verified', relevantQuote: '', explanation: 'ok' }))
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'unsupported', relevantQuote: '', explanation: 'not found' }))
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'unsupported', relevantQuote: '', explanation: 'not found' }));

    const sourceCache: SourceCache = new Map([
      ['https://example.com/one', makeFetchedSource({ url: 'https://example.com/one' })],
      ['https://example.com/two', makeFetchedSource({ url: 'https://example.com/two' })],
      ['https://example.com/three', makeFetchedSource({ url: 'https://example.com/three' })],
    ]);

    const result = await auditCitations({
      content: THREE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      passThreshold: 0.8,
      delayMs: 0,
    });

    expect(result.summary.verified).toBe(1);
    expect(result.summary.failed).toBe(2);
    expect(result.pass).toBe(false);
  });

  it('passes with passThreshold=0 regardless of verdicts', async () => {
    mockCallOpenRouter.mockResolvedValue(
      JSON.stringify({ verdict: 'unsupported', relevantQuote: '', explanation: 'bad' }),
    );

    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({ url: 'https://example.com/source' })],
    ]);

    const result = await auditCitations({
      content: ONE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      passThreshold: 0,
      delayMs: 0,
    });

    expect(result.pass).toBe(true);
  });

  it('passes when there are no checkable citations', async () => {
    // All citations unchecked (no cache, fetchMissing=false)
    const result = await auditCitations({
      content: THREE_CITATION_CONTENT,
      fetchMissing: false,
      passThreshold: 0.8,
      delayMs: 0,
    });

    expect(result.summary.unchecked).toBe(3);
    expect(result.pass).toBe(true); // 0 checkable → pass by default
  });

  it('hard-fails when any citation is misattributed, even if threshold is met', async () => {
    // 3 citations: 2 verified, 1 misattributed → 67% verified/checkable
    // With passThreshold=0.5, threshold is met (67% > 50%) but misattributed
    // should still cause a hard fail (#678).
    mockCallOpenRouter
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'verified', relevantQuote: '', explanation: 'ok' }))
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'verified', relevantQuote: '', explanation: 'ok' }))
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'misattributed', relevantQuote: 'wrong', explanation: 'Numbers differ.' }));

    const sourceCache: SourceCache = new Map([
      ['https://example.com/one', makeFetchedSource({ url: 'https://example.com/one' })],
      ['https://example.com/two', makeFetchedSource({ url: 'https://example.com/two' })],
      ['https://example.com/three', makeFetchedSource({ url: 'https://example.com/three' })],
    ]);

    const result = await auditCitations({
      content: THREE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      passThreshold: 0.5,
      delayMs: 0,
    });

    expect(result.summary.verified).toBe(2);
    expect(result.summary.misattributed).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.pass).toBe(false); // hard-fail due to misattributed
  });

  it('hard-fails misattributed even with passThreshold=0', async () => {
    mockCallOpenRouter.mockResolvedValue(
      JSON.stringify({ verdict: 'misattributed', relevantQuote: 'wrong', explanation: 'bad' }),
    );

    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({ url: 'https://example.com/source' })],
    ]);

    const result = await auditCitations({
      content: ONE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      passThreshold: 0,
      delayMs: 0,
    });

    expect(result.summary.misattributed).toBe(1);
    expect(result.pass).toBe(false); // hard-fail overrides passThreshold=0
  });
});

// ---------------------------------------------------------------------------
// auditCitations — ClaimMap
// ---------------------------------------------------------------------------

describe('auditCitations claimMap', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses claim text from claimMap instead of extracting from MDX', async () => {
    let capturedUserPrompt = '';
    mockCallOpenRouter.mockImplementation((_sys, user) => {
      capturedUserPrompt = user as string;
      return Promise.resolve(JSON.stringify({ verdict: 'verified', relevantQuote: 'x', explanation: 'ok' }));
    });

    const claimMap: ClaimMap = new Map([['1', 'AI systems need careful alignment work.']]);
    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({ url: 'https://example.com/source' })],
    ]);

    await auditCitations({
      content: ONE_CITATION_CONTENT,
      sourceCache,
      claimMap,
      fetchMissing: false,
      delayMs: 0,
    });

    // The user prompt should contain the claimMap claim, not the extracted one
    expect(capturedUserPrompt).toContain('AI systems need careful alignment work.');
  });
});

// ---------------------------------------------------------------------------
// auditCitations — newUngroundedClaims
// ---------------------------------------------------------------------------

describe('auditCitations newUngroundedClaims', () => {
  it('always returns empty array (full detection out of scope)', async () => {
    const result = await auditCitations({
      content: ONE_CITATION_CONTENT,
      fetchMissing: false,
      delayMs: 0,
    });
    expect(result.newUngroundedClaims).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// auditCitations — LLM error handling
// ---------------------------------------------------------------------------

describe('auditCitations LLM error handling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('marks citation as unchecked when LLM call throws', async () => {
    mockCallOpenRouter.mockRejectedValue(new Error('Rate limit exceeded'));

    // Content must be ≥ 50 chars so it reaches the LLM call
    const longContent = 'This source has plenty of content about AI safety and other relevant topics for verification purposes.';
    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({ url: 'https://example.com/source', content: longContent })],
    ]);

    const result = await auditCitations({
      content: ONE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
    });

    expect(result.citations[0].verdict).toBe('unchecked');
    expect(result.citations[0].explanation).toContain('Rate limit exceeded');
    expect(result.summary.unchecked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// auditCitations — relevantExcerpts (#683)
// ---------------------------------------------------------------------------

describe('auditCitations relevantExcerpts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses relevantExcerpts instead of full content when available', async () => {
    let capturedUserPrompt = '';
    mockCallOpenRouter.mockImplementation((_sys, user) => {
      capturedUserPrompt = user as string;
      return Promise.resolve(JSON.stringify({ verdict: 'verified', relevantQuote: 'excerpt text', explanation: 'ok' }));
    });

    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({
        url: 'https://example.com/source',
        content: 'Full content that is very long and may not contain the relevant passage near the start...',
        relevantExcerpts: ['This is the relevant excerpt about AI safety that directly supports the claim.'],
      })],
    ]);

    await auditCitations({
      content: ONE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
    });

    // Should contain the excerpt, not the full content
    expect(capturedUserPrompt).toContain('This is the relevant excerpt about AI safety');
    expect(capturedUserPrompt).not.toContain('Full content that is very long');
  });

  it('falls back to full content when relevantExcerpts is empty', async () => {
    let capturedUserPrompt = '';
    mockCallOpenRouter.mockImplementation((_sys, user) => {
      capturedUserPrompt = user as string;
      return Promise.resolve(JSON.stringify({ verdict: 'verified', relevantQuote: 'full', explanation: 'ok' }));
    });

    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({
        url: 'https://example.com/source',
        content: 'This is the full source content that should be used when no excerpts are available for verification.',
        relevantExcerpts: [],
      })],
    ]);

    await auditCitations({
      content: ONE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
    });

    expect(capturedUserPrompt).toContain('This is the full source content');
  });
});

// ---------------------------------------------------------------------------
// parseBatchVerifierResponse (#677)
// ---------------------------------------------------------------------------

describe('parseBatchVerifierResponse', () => {
  it('parses a valid batch response with multiple results', () => {
    const raw = JSON.stringify({
      results: [
        { verdict: 'verified', relevantQuote: 'quote 1', explanation: 'ok 1' },
        { verdict: 'unsupported', relevantQuote: '', explanation: 'not found' },
      ],
    });
    const results = parseBatchVerifierResponse(raw, 2);
    expect(results).toHaveLength(2);
    expect(results[0].verdict).toBe('verified');
    expect(results[1].verdict).toBe('unsupported');
  });

  it('fills missing entries with unchecked', () => {
    const raw = JSON.stringify({
      results: [{ verdict: 'verified', relevantQuote: '', explanation: 'ok' }],
    });
    const results = parseBatchVerifierResponse(raw, 3);
    expect(results).toHaveLength(3);
    expect(results[0].verdict).toBe('verified');
    expect(results[1].verdict).toBe('unchecked');
    expect(results[2].verdict).toBe('unchecked');
  });

  it('handles malformed JSON gracefully', () => {
    const results = parseBatchVerifierResponse('not json', 2);
    expect(results).toHaveLength(2);
    expect(results[0].verdict).toBe('unchecked');
    expect(results[1].verdict).toBe('unchecked');
  });
});

// ---------------------------------------------------------------------------
// auditCitations — batching same-URL citations (#677)
// ---------------------------------------------------------------------------

describe('auditCitations URL batching', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('batches multiple claims against the same source URL into a single LLM call', async () => {
    // Content with two footnotes citing the SAME URL
    const sameUrlContent = `---
title: Test
---

First claim.[^1] Second claim.[^2]

[^1]: [Source](https://example.com/same)
[^2]: [Source](https://example.com/same)
`;

    let callCount = 0;
    mockCallOpenRouter.mockImplementation(() => {
      callCount++;
      return Promise.resolve(JSON.stringify({
        results: [
          { verdict: 'verified', relevantQuote: 'q1', explanation: 'e1' },
          { verdict: 'verified', relevantQuote: 'q2', explanation: 'e2' },
        ],
      }));
    });

    const sourceCache: SourceCache = new Map([
      ['https://example.com/same', makeFetchedSource({ url: 'https://example.com/same' })],
    ]);

    const result = await auditCitations({
      content: sameUrlContent,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
      concurrency: 3,
    });

    // Should have made exactly ONE LLM call (batched), not two
    expect(callCount).toBe(1);
    expect(result.summary.total).toBe(2);
    expect(result.summary.verified).toBe(2);
  });

  it('runs concurrent LLM calls for different source URLs', async () => {
    const timestamps: number[] = [];
    mockCallOpenRouter.mockImplementation(() => {
      timestamps.push(Date.now());
      return Promise.resolve(
        JSON.stringify({ verdict: 'verified', relevantQuote: '', explanation: 'ok' }),
      );
    });

    const sourceCache: SourceCache = new Map([
      ['https://example.com/one', makeFetchedSource({ url: 'https://example.com/one' })],
      ['https://example.com/two', makeFetchedSource({ url: 'https://example.com/two' })],
      ['https://example.com/three', makeFetchedSource({ url: 'https://example.com/three' })],
    ]);

    const result = await auditCitations({
      content: THREE_CITATION_CONTENT,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
      concurrency: 3,
    });

    expect(result.summary.total).toBe(3);
    expect(result.summary.verified).toBe(3);
    // All 3 LLM calls should have been made (one per distinct URL)
    expect(timestamps).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// inferSourceContext (#1271)
// ---------------------------------------------------------------------------

describe('inferSourceContext', () => {
  it('returns "table" when footnote appears in a table row', () => {
    const body = `Some text.

| Name | Value |
| --- | --- |
| Org A | 500 employees[^1] |

[^1]: [Source](https://example.com)`;
    expect(inferSourceContext(body, '1')).toBe('table');
  });

  it('returns "list" when footnote appears in an unordered list item', () => {
    const body = `Some text.

- First item with a claim.[^1]
- Second item.

[^1]: [Source](https://example.com)`;
    expect(inferSourceContext(body, '1')).toBe('list');
  });

  it('returns "list" when footnote appears in an ordered list item', () => {
    const body = `Some text.

1. First ordered item with claim.[^2]
2. Second item.

[^2]: [Source](https://example.com)`;
    expect(inferSourceContext(body, '2')).toBe('list');
  });

  it('returns "list" for * bullet list items', () => {
    const body = `Some text.

* A bullet point claim.[^3]

[^3]: [Source](https://example.com)`;
    expect(inferSourceContext(body, '3')).toBe('list');
  });

  it('returns "body" when footnote appears in regular paragraph text', () => {
    const body = `This is a regular paragraph with a claim.[^1]

[^1]: [Source](https://example.com)`;
    expect(inferSourceContext(body, '1')).toBe('body');
  });

  it('returns "body" when footnote reference is not found', () => {
    const body = `This is a paragraph without footnotes.`;
    expect(inferSourceContext(body, '99')).toBe('body');
  });

  it('does not match footnote definition lines (only inline references)', () => {
    // The definition line [^1]: ... should not be matched
    const body = `[^1]: [Source](https://example.com)`;
    expect(inferSourceContext(body, '1')).toBe('body');
  });
});

// ---------------------------------------------------------------------------
// detectUnsourcedTableCells (#1271)
// ---------------------------------------------------------------------------

describe('detectUnsourcedTableCells', () => {
  it('detects a numeric dollar amount in a table cell without footnote', () => {
    const body = `Some text.

| Company | Funding |
| --- | --- |
| Acme | $50M |`;
    const results = detectUnsourcedTableCells(body);
    expect(results).toHaveLength(1);
    expect(results[0].cellText).toBe('$50M');
    expect(results[0].column).toBe('Funding');
    expect(results[0].row).toBe(1);
  });

  it('detects percentages without footnotes', () => {
    const body = `| Metric | Value |
| --- | --- |
| Growth | 25% |`;
    const results = detectUnsourcedTableCells(body);
    expect(results).toHaveLength(1);
    expect(results[0].cellText).toBe('25%');
  });

  it('detects comma-separated numbers', () => {
    const body = `| Item | Count |
| --- | --- |
| Users | 1,500,000 |`;
    const results = detectUnsourcedTableCells(body);
    expect(results).toHaveLength(1);
    expect(results[0].cellText).toBe('1,500,000');
  });

  it('detects years in plausible range (19xx, 20xx)', () => {
    const body = `| Event | Year |
| --- | --- |
| Founded | 2015 |`;
    const results = detectUnsourcedTableCells(body);
    expect(results).toHaveLength(1);
    expect(results[0].cellText).toBe('2015');
  });

  it('detects count + unit phrases like "50 employees"', () => {
    const body = `| Org | Size |
| --- | --- |
| MIRI | 50 researchers |`;
    const results = detectUnsourcedTableCells(body);
    expect(results).toHaveLength(1);
    expect(results[0].cellText).toBe('50 researchers');
  });

  it('skips rows that have a footnote reference anywhere', () => {
    const body = `| Company | Funding | Source |
| --- | --- | --- |
| Acme | $50M | Per report[^1] |

[^1]: [Source](https://example.com)`;
    const results = detectUnsourcedTableCells(body);
    expect(results).toHaveLength(0);
  });

  it('returns empty array for tables with no numeric claims', () => {
    const body = `| Name | Status |
| --- | --- |
| Alice | Active |
| Bob | Inactive |`;
    const results = detectUnsourcedTableCells(body);
    expect(results).toHaveLength(0);
  });

  it('returns empty array when content has no tables', () => {
    const body = `Just a paragraph with $50M mentioned but not in a table.`;
    const results = detectUnsourcedTableCells(body);
    expect(results).toHaveLength(0);
  });

  it('handles multiple tables in the same content', () => {
    const body = `First table:

| A | B |
| --- | --- |
| x | $10M |

Some text.

| C | D |
| --- | --- |
| y | 75% |`;
    const results = detectUnsourcedTableCells(body);
    expect(results).toHaveLength(2);
    expect(results[0].cellText).toBe('$10M');
    expect(results[1].cellText).toBe('75%');
  });

  it('reports correct line numbers', () => {
    const body = `Line 1
Line 2
| Col |
| --- |
| $5M |`;
    const results = detectUnsourcedTableCells(body);
    expect(results).toHaveLength(1);
    // Line 5 in 1-based indexing (index 4 in 0-based + offset for data row)
    expect(results[0].line).toBe(5);
  });

  it('skips tables without a proper separator row', () => {
    const body = `| A | B |
| not a separator |
| $10M | 50% |`;
    const results = detectUnsourcedTableCells(body);
    expect(results).toHaveLength(0);
  });

  it('handles multiple data rows with mixed sourced/unsourced', () => {
    const body = `| Org | Funding |
| --- | --- |
| Acme | $50M |
| Beta | $20M[^1] |
| Gamma | $30M |

[^1]: [Source](https://example.com)`;
    const results = detectUnsourcedTableCells(body);
    expect(results).toHaveLength(2);
    expect(results[0].cellText).toBe('$50M');
    expect(results[1].cellText).toBe('$30M');
  });
});

// ---------------------------------------------------------------------------
// NUMERIC_CLAIM_PATTERN (#1271)
// ---------------------------------------------------------------------------

describe('NUMERIC_CLAIM_PATTERN', () => {
  const matches = (text: string) => NUMERIC_CLAIM_PATTERN.test(text);

  it('matches dollar amounts', () => {
    expect(matches('$100')).toBe(true);
    expect(matches('$1.5M')).toBe(true);
    expect(matches('$2 billion')).toBe(true);
    expect(matches('$50,000')).toBe(true);
  });

  it('matches percentages', () => {
    expect(matches('50%')).toBe(true);
    expect(matches('3.5%')).toBe(true);
    expect(matches('100%')).toBe(true);
  });

  it('matches comma-separated numbers', () => {
    expect(matches('1,000')).toBe(true);
    expect(matches('10,000,000')).toBe(true);
  });

  it('matches years', () => {
    expect(matches('2015')).toBe(true);
    expect(matches('1990')).toBe(true);
    expect(matches('2025')).toBe(true);
  });

  it('matches count+unit phrases', () => {
    expect(matches('50 employees')).toBe(true);
    expect(matches('200 papers')).toBe(true);
    expect(matches('10 researchers')).toBe(true);
  });

  it('does not match short plain numbers', () => {
    // Single digits or small numbers without units should not match
    expect(matches('5')).toBe(false);
    expect(matches('42')).toBe(false);
  });

  it('does not match plain words', () => {
    expect(matches('Active')).toBe(false);
    expect(matches('hello world')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// auditCitations — sourceContext and unsourcedTableCells integration (#1271)
// ---------------------------------------------------------------------------

describe('auditCitations sourceContext and unsourcedTableCells', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('annotates citations with sourceContext', async () => {
    mockCallOpenRouter.mockResolvedValue(
      JSON.stringify({ verdict: 'verified', relevantQuote: '', explanation: 'ok' }),
    );

    const contentWithTable = `---
title: Test
---

Body claim.[^1]

| Col A | Col B |
| --- | --- |
| Data | Value[^2] |

[^1]: [Source One](https://example.com/one)
[^2]: [Source Two](https://example.com/two)
`;

    const sourceCache: SourceCache = new Map([
      ['https://example.com/one', makeFetchedSource({ url: 'https://example.com/one' })],
      ['https://example.com/two', makeFetchedSource({ url: 'https://example.com/two' })],
    ]);

    const result = await auditCitations({
      content: contentWithTable,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
    });

    const cit1 = result.citations.find(c => c.footnoteRef === '1');
    const cit2 = result.citations.find(c => c.footnoteRef === '2');
    expect(cit1?.sourceContext).toBe('body');
    expect(cit2?.sourceContext).toBe('table');
  });

  it('detects unsourced table cells in audit result', async () => {
    const contentWithUnsourcedTable = `---
title: Test
---

Text with citation.[^1]

| Org | Funding |
| --- | --- |
| Acme | $50M |

[^1]: [Source](https://example.com/source)
`;

    mockCallOpenRouter.mockResolvedValue(
      JSON.stringify({ verdict: 'verified', relevantQuote: '', explanation: 'ok' }),
    );

    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({ url: 'https://example.com/source' })],
    ]);

    const result = await auditCitations({
      content: contentWithUnsourcedTable,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
    });

    expect(result.unsourcedTableCells).toHaveLength(1);
    expect(result.unsourcedTableCells[0].cellText).toBe('$50M');
    expect(result.unsourcedTableCells[0].column).toBe('Funding');
    expect(result.summary.unsourcedTableCells).toBe(1);
  });

  it('returns empty unsourcedTableCells when all table data is sourced', async () => {
    const sourcedContent = `---
title: Test
---

| Org | Funding |
| --- | --- |
| Acme | $50M[^1] |

[^1]: [Source](https://example.com/source)
`;

    mockCallOpenRouter.mockResolvedValue(
      JSON.stringify({ verdict: 'verified', relevantQuote: '', explanation: 'ok' }),
    );

    const sourceCache: SourceCache = new Map([
      ['https://example.com/source', makeFetchedSource({ url: 'https://example.com/source' })],
    ]);

    const result = await auditCitations({
      content: sourcedContent,
      sourceCache,
      fetchMissing: false,
      delayMs: 0,
    });

    expect(result.unsourcedTableCells).toHaveLength(0);
    expect(result.summary.unsourcedTableCells).toBe(0);
  });
});
