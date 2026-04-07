import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyCitations, type VerifyCitationsRequest } from './citation-service.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetchSource = vi.fn();
vi.mock('../search/source-fetcher.ts', () => ({
  fetchSource: (...args: unknown[]) => mockFetchSource(...args),
}));

const mockAuditCitations = vi.fn();
vi.mock('./citation-auditor.ts', async () => {
  const actual = await vi.importActual('./citation-auditor.ts');
  return {
    ...actual,
    auditCitations: (...args: unknown[]) => mockAuditCitations(...args),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchedSource(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com/test',
    title: 'Test Page',
    fetchedAt: new Date().toISOString(),
    content: 'Test content for checking purposes.',
    relevantExcerpts: [],
    status: 'ok',
    httpStatus: 200,
    contentType: 'html',
    ...overrides,
  };
}

const SAMPLE_CONTENT = `---
title: Test Page
---

Some claim here.[^1] Another claim.[^2]

[^1]: [Source A](https://example.com/a)
[^2]: [Source B](https://example.com/b)
`;

// ---------------------------------------------------------------------------
// HTTP mode tests
// ---------------------------------------------------------------------------

describe('verifyCitations — HTTP mode', () => {
  beforeEach(() => {
    mockFetchSource.mockReset();
  });

  it('returns mode: http with correct result shape', async () => {
    mockFetchSource.mockResolvedValue(makeFetchedSource());

    const result = await verifyCitations({
      content: SAMPLE_CONTENT,
      mode: 'http',
      delayMs: 0,
    });

    expect(result.mode).toBe('http');
    if (result.mode === 'http') {
      expect(result.citations).toHaveLength(2);
      expect(result.summary.total).toBe(2);
    }
  });

  it('marks verified for HTTP 200', async () => {
    mockFetchSource.mockResolvedValue(makeFetchedSource({ httpStatus: 200 }));

    const result = await verifyCitations({
      content: SAMPLE_CONTENT,
      mode: 'http',
      delayMs: 0,
    });

    if (result.mode === 'http') {
      expect(result.summary.verified).toBe(2);
      expect(result.citations[0].status).toBe('verified');
    }
  });

  it('marks broken for HTTP 404', async () => {
    mockFetchSource.mockResolvedValue(makeFetchedSource({
      status: 'dead',
      httpStatus: 404,
      content: '',
      title: '',
    }));

    const result = await verifyCitations({
      content: SAMPLE_CONTENT,
      mode: 'http',
      delayMs: 0,
    });

    if (result.mode === 'http') {
      expect(result.summary.broken).toBe(2);
      expect(result.citations[0].status).toBe('broken');
    }
  });

  it('marks unverifiable for httpStatus 0 (timeout/error)', async () => {
    mockFetchSource.mockResolvedValue(makeFetchedSource({
      status: 'error',
      httpStatus: 0,
      content: '',
      title: '',
    }));

    const result = await verifyCitations({
      content: SAMPLE_CONTENT,
      mode: 'http',
      delayMs: 0,
    });

    if (result.mode === 'http') {
      expect(result.summary.unverifiable).toBe(2);
      expect(result.citations[0].status).toBe('unverifiable');
    }
  });

  it('extracts page title and content snippet', async () => {
    mockFetchSource.mockResolvedValue(makeFetchedSource({
      title: 'My Source Page',
      content: 'This is a long article about AI safety that provides supporting evidence.',
    }));

    const result = await verifyCitations({
      content: SAMPLE_CONTENT,
      mode: 'http',
      delayMs: 0,
    });

    if (result.mode === 'http') {
      expect(result.citations[0].pageTitle).toBe('My Source Page');
      expect(result.citations[0].contentSnippet).toContain('AI safety');
    }
  });

  it('calls fetchSource with extractMode: full', async () => {
    mockFetchSource.mockResolvedValue(makeFetchedSource());

    const content = `Claim.[^1]\n\n[^1]: [Source](https://example.com/test)`;
    await verifyCitations({ content, mode: 'http', delayMs: 0 });

    expect(mockFetchSource).toHaveBeenCalledWith({
      url: 'https://example.com/test',
      extractMode: 'full',
    });
  });
});

// ---------------------------------------------------------------------------
// LLM mode tests
// ---------------------------------------------------------------------------

describe('verifyCitations — LLM mode', () => {
  beforeEach(() => {
    mockAuditCitations.mockReset();
  });

  it('returns mode: llm with correct result shape', async () => {
    mockAuditCitations.mockResolvedValue({
      citations: [],
      summary: { total: 0, verified: 0, failed: 0, misattributed: 0, unchecked: 0, unsourcedTableCells: 0 },
      newUngroundedClaims: [],
      unsourcedTableCells: [],
      pass: true,
    });

    const result = await verifyCitations({
      content: SAMPLE_CONTENT,
      mode: 'llm',
      fetchMissing: true,
    });

    expect(result.mode).toBe('llm');
    if (result.mode === 'llm') {
      expect(result.pass).toBe(true);
    }
  });

  it('passes through sourceCache and claimMap to auditCitations', async () => {
    mockAuditCitations.mockResolvedValue({
      citations: [],
      summary: { total: 0, verified: 0, failed: 0, misattributed: 0, unchecked: 0, unsourcedTableCells: 0 },
      newUngroundedClaims: [],
      unsourcedTableCells: [],
      pass: true,
    });

    const sourceCache = new Map();
    const claimMap = new Map();

    await verifyCitations({
      content: SAMPLE_CONTENT,
      mode: 'llm',
      sourceCache,
      claimMap,
      fetchMissing: false,
      passThreshold: 0.5,
      model: 'test-model',
      llmConcurrency: 5,
    });

    expect(mockAuditCitations).toHaveBeenCalledWith({
      content: SAMPLE_CONTENT,
      sourceCache,
      claimMap,
      fetchMissing: false,
      passThreshold: 0.5,
      model: 'test-model',
      delayMs: 300,
      concurrency: 5,
    });
  });

  it('defaults fetchMissing to true', async () => {
    mockAuditCitations.mockResolvedValue({
      citations: [],
      summary: { total: 0, verified: 0, failed: 0, misattributed: 0, unchecked: 0, unsourcedTableCells: 0 },
      newUngroundedClaims: [],
      unsourcedTableCells: [],
      pass: true,
    });

    await verifyCitations({ content: SAMPLE_CONTENT, mode: 'llm' });

    const call = mockAuditCitations.mock.calls[0][0];
    expect(call.fetchMissing).toBe(true);
  });
});
