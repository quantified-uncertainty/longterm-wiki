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
  auditCitations,
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

// Mock knowledge-db (pulled in transitively via citation-archive.ts).
vi.mock('./knowledge-db.ts', () => ({
  citationContent: { getByUrl: vi.fn(() => null), upsert: vi.fn() },
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
