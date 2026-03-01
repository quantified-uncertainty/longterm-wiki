/**
 * Tests for the citation-audit phase.
 *
 * Tests cover:
 *   - buildAuditorSourceCache(): converting SourceCacheEntry[] → Map<string, FetchedSource>
 *   - citationAuditPhase(): advisory/gate logging, empty-citation handling, source cache
 *     passthrough, undefined-cache behaviour, and option forwarding.
 *
 * All tests are offline — no network calls, no LLM calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAuditorSourceCache, citationAuditPhase } from './citation-audit.ts';
import { MIN_SOURCE_CONTENT_LENGTH } from '../../../lib/citation-auditor.ts';
import type { AuditResult } from '../../../lib/citation-auditor.ts';
import type { SourceCacheEntry } from '../../../lib/section-writer.ts';
import type { ResearchResult, PipelineOptions, PageData } from '../types.ts';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock auditCitations to avoid LLM/network calls; preserve MIN_SOURCE_CONTENT_LENGTH
// and other non-function exports so buildAuditorSourceCache tests continue to work.
vi.mock('../../../lib/citation-auditor.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/citation-auditor.ts')>();
  return { ...actual, auditCitations: vi.fn() };
});

// Mock log and writeTemp to avoid console output and file-system access in tests.
vi.mock('../utils.ts', () => ({
  log: vi.fn(),
  writeTemp: vi.fn(),
}));

// Pull the mocked references after vi.mock declarations so vitest hoisting works.
import { auditCitations } from '../../../lib/citation-auditor.ts';
import { log, writeTemp } from '../utils.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<SourceCacheEntry> = {}): SourceCacheEntry {
  return {
    id: 'SRC-1',
    url: 'https://example.com/article',
    title: 'Example Article',
    content: 'This is a long enough content string that passes the MIN_SOURCE_CONTENT_LENGTH threshold for ok status.',
    ...overrides,
  };
}

const mockPage: PageData = {
  id: 'test-page',
  title: 'Test Page',
  path: '/test-page',
};

function makeAuditResult(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    citations: [],
    summary: { total: 0, verified: 0, failed: 0, misattributed: 0, unchecked: 0, unsourcedTableCells: 0 },
    newUngroundedClaims: [],
    unsourcedTableCells: [],
    pass: true,
    ...overrides,
  };
}

/** Extract message arguments from all `log` calls (log is called as log(phase, message)). */
function getLogMessages(): string[] {
  return vi.mocked(log).mock.calls.map(c => c[1] as string);
}

// ---------------------------------------------------------------------------
// buildAuditorSourceCache tests
// ---------------------------------------------------------------------------

describe('buildAuditorSourceCache', () => {
  it('converts SourceCacheEntry[] into a Map keyed by URL', () => {
    const entries: SourceCacheEntry[] = [
      makeEntry({ url: 'https://example.com/a', content: 'A'.repeat(100) }),
      makeEntry({ id: 'SRC-2', url: 'https://example.com/b', content: 'B'.repeat(100) }),
    ];

    const cache = buildAuditorSourceCache(entries);
    expect(cache.size).toBe(2);
    expect(cache.has('https://example.com/a')).toBe(true);
    expect(cache.has('https://example.com/b')).toBe(true);
  });

  it('sets status=ok for entries with content longer than MIN_SOURCE_CONTENT_LENGTH chars', () => {
    const entry = makeEntry({ content: 'A'.repeat(MIN_SOURCE_CONTENT_LENGTH + 1) });
    const cache = buildAuditorSourceCache([entry]);
    expect(cache.get(entry.url)?.status).toBe('ok');
  });

  it('sets status=error for entries with content shorter than or equal to MIN_SOURCE_CONTENT_LENGTH chars', () => {
    const entry = makeEntry({ content: 'short' });
    const cache = buildAuditorSourceCache([entry]);
    expect(cache.get(entry.url)?.status).toBe('error');
  });

  it('sets status=error for entries with empty content', () => {
    const entry = makeEntry({ content: '' });
    const cache = buildAuditorSourceCache([entry]);
    expect(cache.get(entry.url)?.status).toBe('error');
  });

  it('preserves content and title from the source cache entry', () => {
    const entry = makeEntry({ title: 'My Title', content: 'Content text that is long enough to be valid.' + ' Extra text padding here.' });
    const cache = buildAuditorSourceCache([entry]);
    const fetched = cache.get(entry.url);
    expect(fetched?.title).toBe('My Title');
    expect(fetched?.content).toBe(entry.content);
  });

  it('returns empty Map for empty input', () => {
    const cache = buildAuditorSourceCache([]);
    expect(cache.size).toBe(0);
  });

  it('skips entries with no URL', () => {
    const entries: SourceCacheEntry[] = [
      makeEntry({ url: '' }),
      makeEntry({ id: 'SRC-2', url: 'https://example.com/valid', content: 'Valid content that is definitely long enough.' }),
    ];
    const cache = buildAuditorSourceCache(entries);
    expect(cache.size).toBe(1);
    expect(cache.has('https://example.com/valid')).toBe(true);
  });

  it('last entry wins for duplicate URLs', () => {
    const entries: SourceCacheEntry[] = [
      makeEntry({ id: 'SRC-1', url: 'https://example.com/dup', content: 'First content that is long enough to pass threshold.' }),
      makeEntry({ id: 'SRC-2', url: 'https://example.com/dup', content: 'Second content that is long enough to pass threshold.' }),
    ];
    const cache = buildAuditorSourceCache(entries);
    expect(cache.size).toBe(1);
    expect(cache.get('https://example.com/dup')?.content).toBe('Second content that is long enough to pass threshold.');
  });

  it('populates relevantExcerpts as empty array (adapts from SourceCacheEntry format)', () => {
    const entry = makeEntry({ content: 'A'.repeat(100) });
    const cache = buildAuditorSourceCache([entry]);
    expect(cache.get(entry.url)?.relevantExcerpts).toEqual([]);
  });

  it('handles entries at exactly the MIN_SOURCE_CONTENT_LENGTH content boundary', () => {
    // exactly MIN_SOURCE_CONTENT_LENGTH chars → status 'error' (not strictly greater)
    const borderEntry = makeEntry({ content: 'A'.repeat(MIN_SOURCE_CONTENT_LENGTH) });
    const cacheAtBoundary = buildAuditorSourceCache([borderEntry]);
    expect(cacheAtBoundary.get(borderEntry.url)?.status).toBe('error');

    // one char above → status 'ok'
    const aboveBoundaryEntry = makeEntry({ url: 'https://example.com/above', content: 'A'.repeat(MIN_SOURCE_CONTENT_LENGTH + 1) });
    const cacheAbove = buildAuditorSourceCache([aboveBoundaryEntry]);
    expect(cacheAbove.get(aboveBoundaryEntry.url)?.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// citationAuditPhase tests
// ---------------------------------------------------------------------------

describe('citationAuditPhase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the AuditResult from auditCitations', async () => {
    const expected = makeAuditResult({
      summary: { total: 1, verified: 1, failed: 0, misattributed: 0, unchecked: 0, unsourcedTableCells: 0 },
      pass: true,
    });
    vi.mocked(auditCitations).mockResolvedValueOnce(expected);

    const result = await citationAuditPhase(mockPage, 'content', undefined, {});

    expect(result).toBe(expected);
  });

  it('logs "No citations found" when total is 0', async () => {
    vi.mocked(auditCitations).mockResolvedValueOnce(makeAuditResult());  // total: 0 by default

    await citationAuditPhase(mockPage, 'content', undefined, {});

    expect(getLogMessages()).toContain('No citations found — skipping verification');
  });

  it('logs "Citation audit passed" when audit passes with citations', async () => {
    vi.mocked(auditCitations).mockResolvedValueOnce(makeAuditResult({
      summary: { total: 2, verified: 2, failed: 0, misattributed: 0, unchecked: 0, unsourcedTableCells: 0 },
      pass: true,
    }));

    await citationAuditPhase(mockPage, 'content', undefined, {});

    expect(getLogMessages().some(msg => msg.includes('Citation audit passed'))).toBe(true);
  });

  it('logs [WARNING] in advisory mode when audit fails', async () => {
    vi.mocked(auditCitations).mockResolvedValueOnce(makeAuditResult({
      summary: { total: 2, verified: 1, failed: 1, misattributed: 0, unchecked: 0, unsourcedTableCells: 0 },
      pass: false,
    }));

    const options: PipelineOptions = {};  // no citationGate → advisory mode
    await citationAuditPhase(mockPage, 'content', undefined, options);

    const messages = getLogMessages();
    expect(messages.some(msg => msg.includes('[WARNING]'))).toBe(true);
    expect(messages.some(msg => msg.includes('[GATE]'))).toBe(false);
  });

  it('logs [GATE] in gate mode when audit fails', async () => {
    vi.mocked(auditCitations).mockResolvedValueOnce(makeAuditResult({
      summary: { total: 2, verified: 1, failed: 1, misattributed: 0, unchecked: 0, unsourcedTableCells: 0 },
      pass: false,
    }));

    const options: PipelineOptions = { citationGate: true };
    await citationAuditPhase(mockPage, 'content', undefined, options);

    const messages = getLogMessages();
    expect(messages.some(msg => msg.includes('[GATE]'))).toBe(true);
    expect(messages.some(msg => msg.includes('[WARNING]'))).toBe(false);
  });

  it('passes source cache to auditCitations when research includes sourceCache', async () => {
    const sourceCacheEntries: SourceCacheEntry[] = [
      { id: 'SRC-1', url: 'https://example.com/article', title: 'Article', content: 'A'.repeat(MIN_SOURCE_CONTENT_LENGTH + 1) },
    ];
    const research: ResearchResult = { sources: [], sourceCache: sourceCacheEntries };
    vi.mocked(auditCitations).mockResolvedValueOnce(makeAuditResult());

    await citationAuditPhase(mockPage, 'content', research, {});

    const auditCall = vi.mocked(auditCitations).mock.calls[0][0];
    expect(auditCall.sourceCache).toBeDefined();
    expect(auditCall.sourceCache!.has('https://example.com/article')).toBe(true);
  });

  it('passes undefined sourceCache to auditCitations when research is absent', async () => {
    vi.mocked(auditCitations).mockResolvedValueOnce(makeAuditResult());

    await citationAuditPhase(mockPage, 'content', undefined, {});

    const auditCall = vi.mocked(auditCitations).mock.calls[0][0];
    expect(auditCall.sourceCache).toBeUndefined();
  });

  it('passes undefined sourceCache when research exists but has no sourceCache', async () => {
    const research: ResearchResult = { sources: [] };  // no sourceCache field
    vi.mocked(auditCitations).mockResolvedValueOnce(makeAuditResult());

    await citationAuditPhase(mockPage, 'content', research, {});

    const auditCall = vi.mocked(auditCitations).mock.calls[0][0];
    expect(auditCall.sourceCache).toBeUndefined();
  });

  it('forwards citationAuditModel option to auditCitations as model', async () => {
    vi.mocked(auditCitations).mockResolvedValueOnce(makeAuditResult());

    await citationAuditPhase(mockPage, 'content', undefined, { citationAuditModel: 'my-model' });

    const auditCall = vi.mocked(auditCitations).mock.calls[0][0];
    expect(auditCall.model).toBe('my-model');
  });

  it('omits model key when citationAuditModel is not set', async () => {
    vi.mocked(auditCitations).mockResolvedValueOnce(makeAuditResult());

    await citationAuditPhase(mockPage, 'content', undefined, {});

    const auditCall = vi.mocked(auditCitations).mock.calls[0][0];
    expect('model' in auditCall).toBe(false);
  });

  it('always passes fetchMissing: true and passThreshold: 0.8 to auditCitations', async () => {
    vi.mocked(auditCitations).mockResolvedValueOnce(makeAuditResult());

    await citationAuditPhase(mockPage, 'content', undefined, {});

    const auditCall = vi.mocked(auditCitations).mock.calls[0][0];
    expect(auditCall.fetchMissing).toBe(true);
    expect(auditCall.passThreshold).toBe(0.8);
  });

  it('writes the audit result to a temp file via writeTemp', async () => {
    const auditResult = makeAuditResult();
    vi.mocked(auditCitations).mockResolvedValueOnce(auditResult);

    await citationAuditPhase(mockPage, 'content', undefined, {});

    expect(vi.mocked(writeTemp)).toHaveBeenCalledWith(mockPage.id, 'citation-audit.json', auditResult);
  });
});
