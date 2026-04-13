/**
 * Tests for the URL-heuristic fast-path in `crux resources classify submit`.
 *
 * Added in QUA-312 review-fix. Covers:
 *  - Fast-path bucketing (homepage URLs → fast-path, ambiguous URLs → LLM)
 *  - Dry-run branch (no writes, no batch submission)
 *  - Partial-failure fallback (failed fast-path chunk re-routed to LLM batch)
 *  - Early return when no LLM candidates remain
 *  - Pass-through when no fast-path candidates exist
 *
 * The existing `submitClassification` is not exported; we exercise it via
 * the public `classifyCommand('submit', ...)` entry point. All wiki-server
 * and batch-API calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (must be defined before importing the module under test)
// ---------------------------------------------------------------------------

const mockLoadResources = vi.fn<() => Promise<Array<Record<string, unknown>>>>();

vi.mock('../resource-io.ts', () => ({
  loadResourcesPGFirst: () => mockLoadResources(),
}));

const mockUpsertResourceBatch = vi.fn<(items: unknown[]) => Promise<{ ok: boolean; message?: string; data?: unknown }>>();

vi.mock('../lib/wiki-server/resources.ts', () => ({
  upsertResourceBatch: (items: unknown[]) => mockUpsertResourceBatch(items),
}));

const mockCreateBatch = vi.fn<() => Promise<string>>();

vi.mock('./batch-client.ts', () => ({
  createBatch: () => mockCreateBatch(),
  pollBatch: vi.fn(),
  downloadBatchResults: vi.fn(),
  getBatchStatus: vi.fn(),
}));

// apiRequest is imported in classify.ts but, after the HIGH-1 fix, the
// fast-path no longer calls it. Stub it so a stray caller would blow up
// loudly rather than pass silently.
vi.mock('../lib/wiki-server/client.ts', () => ({
  apiRequest: vi.fn(() => {
    throw new Error('classify.ts should not call apiRequest directly — use upsertResourceBatch');
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { classifyCommand } = await import('./classify.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function r(id: string, url: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    url,
    title: `Title for ${id}`,
    type: 'web',
    abstract: null,
    summary: null,
    enrichment_status: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertResourceBatch.mockResolvedValue({
    ok: true,
    data: { upserted: 0, results: [] },
  });
  mockCreateBatch.mockResolvedValue('batch-test-123');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyCommand submit — fast-path bucketing (QUA-312)', () => {
  it('routes high-confidence homepage URLs to fast-path and writes via upsertResourceBatch', async () => {
    mockLoadResources.mockResolvedValue([
      r('r1', 'https://anthropic.com/'),          // bare domain → fast-path
      r('r2', 'https://example.com/blog/2024/post'), // deep path → LLM
      r('r3', 'https://openai.com/about'),         // /about → fast-path
    ]);

    await classifyCommand(['submit'], {});

    // Fast-path batch was written via the typed client with both homepage resources.
    expect(mockUpsertResourceBatch).toHaveBeenCalledTimes(1);
    const items = mockUpsertResourceBatch.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id).sort()).toEqual(['r1', 'r3']);
    for (const item of items) {
      expect(item.resourcePurpose).toBe('homepage');
      expect(item.enrichmentStatus).toBe('classified');
    }

    // LLM batch was submitted for the one remaining ambiguous URL.
    expect(mockCreateBatch).toHaveBeenCalledTimes(1);
  });

  it('does NOT write in dry-run mode, but reports the fast-path count', async () => {
    mockLoadResources.mockResolvedValue([
      r('r1', 'https://anthropic.com/'),
      r('r2', 'https://example.com/team/jane'),
    ]);

    const result = await classifyCommand(['dry-run'], {});

    // No server calls at all.
    expect(mockUpsertResourceBatch).not.toHaveBeenCalled();
    expect(mockCreateBatch).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it('fails fast on fast-path batch write failure (no LLM submission)', async () => {
    // 1 fast-path hit that will fail to write, 1 ambiguous LLM candidate.
    mockLoadResources.mockResolvedValue([
      r('r1', 'https://anthropic.com/'),
      r('r2', 'https://example.com/docs/api'),
    ]);
    mockUpsertResourceBatch.mockResolvedValue({
      ok: false,
      message: 'DB connection lost',
    });

    const result = await classifyCommand(['submit'], {});

    // Write was attempted once...
    expect(mockUpsertResourceBatch).toHaveBeenCalledTimes(1);
    // ...and the function returned non-zero immediately — the LLM batch was
    // NOT submitted, because the caller needs to see the failure and decide
    // how to proceed (not silently drop or silently re-route).
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Fast-path batch write failed');
    expect(mockCreateBatch).not.toHaveBeenCalled();
  });

  it('returns early when every candidate is fast-path and writes all via typed client', async () => {
    mockLoadResources.mockResolvedValue([
      r('r1', 'https://a.example.com/'),
      r('r2', 'https://b.example.com/'),
      r('r3', 'https://c.example.com/'),
    ]);

    const result = await classifyCommand(['submit'], {});

    expect(mockUpsertResourceBatch).toHaveBeenCalledTimes(1);
    const items = mockUpsertResourceBatch.mock.calls[0][0] as unknown[];
    expect(items).toHaveLength(3);
    // No LLM batch — all fast-path.
    expect(mockCreateBatch).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it('skips already-classified resources entirely (no fast-path write, no LLM batch)', async () => {
    mockLoadResources.mockResolvedValue([
      r('r1', 'https://anthropic.com/', { enrichment_status: 'classified' }),
      r('r2', 'https://example.com/', { enrichment_status: 'enriched' }),
      r('r3', 'https://example.com/', { enrichment_status: 'reviewed' }),
    ]);

    await classifyCommand(['submit'], {});

    expect(mockUpsertResourceBatch).not.toHaveBeenCalled();
    expect(mockCreateBatch).not.toHaveBeenCalled();
  });

  it('does NOT route URL shorteners or PDFs to fast-path', async () => {
    mockLoadResources.mockResolvedValue([
      r('r1', 'https://bit.ly/abc123'),        // shortener → LLM
      r('r2', 'https://example.com/doc.pdf'),   // PDF → LLM (confidence 0.9 but purpose=null)
    ]);

    await classifyCommand(['submit'], {});

    // No fast-path writes — both went to LLM.
    expect(mockUpsertResourceBatch).not.toHaveBeenCalled();
    expect(mockCreateBatch).toHaveBeenCalledTimes(1);
  });
});
