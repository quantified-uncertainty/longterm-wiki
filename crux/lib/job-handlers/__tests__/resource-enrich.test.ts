/**
 * Tests for resource-enrich job handler.
 *
 * Covers:
 *  - Param validation (missing/invalid resourceId, url)
 *  - Skip guard (already enriched/reviewed resources)
 *  - Successful enrichment with cached content
 *  - Enrichment without content (URL+title only fallback)
 *  - LLM response parse failure
 *  - LLM response Zod validation failure
 *  - API write failure
 *  - Importance score normalization (0-100 → 0-1)
 *  - Title update guard (only updates bad titles)
 *
 * All external calls (apiRequest, callLlm, getCitationContentByUrl) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobHandlerContext } from '../types.ts';

// ---------------------------------------------------------------------------
// Mock: wiki-server client (apiRequest)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockApiRequest = vi.fn<(...args: any[]) => Promise<any>>();

vi.mock('../../wiki-server/client.ts', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiRequest: (...args: any[]) => mockApiRequest(...args),
}));

// ---------------------------------------------------------------------------
// Mock: wiki-server resources (getResource, upsertResourceBatch)
// ---------------------------------------------------------------------------

const mockGetResource = vi.fn();
const mockUpsertResourceBatch = vi.fn();

const mockSuggestResourcesApi = vi.fn();

vi.mock('../../wiki-server/resources.ts', () => ({
  getResource: (...args: unknown[]) => mockGetResource(...args),
  upsertResourceBatch: (...args: unknown[]) => mockUpsertResourceBatch(...args),
  suggestResourcesApi: (...args: unknown[]) => mockSuggestResourcesApi(...args),
}));

// ---------------------------------------------------------------------------
// Mock: LLM layer
// ---------------------------------------------------------------------------

const mockCallLlm = vi.fn<() => Promise<{ text: string; usage: { input_tokens: number; output_tokens: number }; model: string }>>();

vi.mock('../../llm.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../llm.ts')>();
  return {
    ...actual,
    createLlmClient: vi.fn(() => ({})),
    callLlm: (..._args: unknown[]) => mockCallLlm(),
    MODELS: { haiku: 'claude-haiku-test', sonnet: 'claude-sonnet-test' },
  };
});

// ---------------------------------------------------------------------------
// Mock: citations (getCitationContentByUrl)
// ---------------------------------------------------------------------------

const mockGetCitationContent = vi.fn();

vi.mock('../../wiki-server/citations.ts', () => ({
  getCitationContentByUrl: (...args: unknown[]) => mockGetCitationContent(...args),
}));

// ---------------------------------------------------------------------------
// Mock: anthropic (parseJsonResponse)
// ---------------------------------------------------------------------------

vi.mock('../../anthropic.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../anthropic.ts')>();
  return {
    ...actual,
    parseJsonResponse: (text: string) => {
      // Strip code fences like the real implementation
      const cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      return JSON.parse(cleaned);
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CTX: JobHandlerContext = {
  workerId: 'test-worker',
  projectRoot: '/tmp/test',
  verbose: false,
};

/** Valid combined enrichment result from LLM */
function validLlmResult() {
  return {
    resource_subtype: 'blog_post',
    resource_purpose: 'commentary',
    context_note: 'A blog post about AI alignment techniques.',
    clean_title: null as string | null,
    summary: 'This post discusses novel approaches to AI alignment.',
    key_points: ['Introduces a new alignment framework', 'Compares with existing approaches'],
    tags: ['alignment', 'ai-safety'],
    importance_score: 65,
  };
}

/** Build a mock resource record */
function mockResource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    url: 'https://example.com/article',
    title: 'A Good Long Title About AI Safety',
    type: 'web',
    summary: null,
    tags: null,
    enrichmentStatus: null,
    ...overrides,
  };
}

function setupDefaultMocks(resource = mockResource()) {
  mockGetResource.mockResolvedValue({
    ok: true,
    data: resource,
  });

  mockGetCitationContent.mockResolvedValue({
    ok: true,
    data: {
      fullText: 'Full text of the article about AI safety approaches and alignment...',
      fullTextPreview: 'Full text preview...',
      pageTitle: 'AI Safety Article',
    },
  });

  mockCallLlm.mockResolvedValue({
    text: JSON.stringify(validLlmResult()),
    usage: { input_tokens: 1500, output_tokens: 400 },
    model: 'claude-sonnet-test',
  });

  mockUpsertResourceBatch.mockResolvedValue({
    ok: true,
    data: { upserted: 1, results: [{ id: 'res-1', url: 'https://example.com/article' }] },
  });
}

// ---------------------------------------------------------------------------
// Import handler (after mocks are set up)
// ---------------------------------------------------------------------------

const { handleResourceEnrich } = await import('../resource-enrich.ts');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockSuggestResourcesApi.mockResolvedValue({ ok: true, data: { suggested: 0 } });
});

describe('handleResourceEnrich — param validation', () => {
  it('rejects missing resourceId', async () => {
    const result = await handleResourceEnrich(
      { url: 'https://example.com' },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid params');
  });

  it('rejects missing url', async () => {
    const result = await handleResourceEnrich(
      { resourceId: 'res-1' },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid params');
  });

  it('rejects invalid url format', async () => {
    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'not-a-url' },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid params');
  });

  it('rejects empty resourceId', async () => {
    const result = await handleResourceEnrich(
      { resourceId: '', url: 'https://example.com' },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid params');
  });
});

describe('handleResourceEnrich — skip guard', () => {
  it('skips already enriched resources', async () => {
    mockGetResource.mockResolvedValue({
      ok: true,
      data: mockResource({ enrichmentStatus: 'enriched' }),
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.skipped).toBe(true);
    expect(result.data.reason).toContain('enriched');
    // Should NOT call LLM
    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it('skips reviewed resources', async () => {
    mockGetResource.mockResolvedValue({
      ok: true,
      data: mockResource({ enrichmentStatus: 'reviewed' }),
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.skipped).toBe(true);
    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it('processes resources with null enrichmentStatus', async () => {
    setupDefaultMocks(mockResource({ enrichmentStatus: null }));

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.skipped).toBeUndefined();
    expect(mockCallLlm).toHaveBeenCalled();
  });

  it('processes resources with classified status', async () => {
    setupDefaultMocks(mockResource({ enrichmentStatus: 'classified' }));

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.skipped).toBeUndefined();
    expect(mockCallLlm).toHaveBeenCalled();
  });
});

describe('handleResourceEnrich — successful enrichment', () => {
  it('enriches resource with cached content and persists results', async () => {
    setupDefaultMocks();

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.contentAvailable).toBe(true);
    expect(result.data.resourceId).toBe('res-1');
    expect(result.data.inputTokens).toBe(1500);
    expect(result.data.outputTokens).toBe(400);

    // Verify upsertResourceBatch was called with correct fields
    expect(mockUpsertResourceBatch).toHaveBeenCalledTimes(1);
    const batchItems = mockUpsertResourceBatch.mock.calls[0][0];
    expect(batchItems).toHaveLength(1);
    const item = batchItems[0];
    expect(item.id).toBe('res-1');
    expect(item.enrichmentStatus).toBe('enriched');
    expect(item.summary).toBe('This post discusses novel approaches to AI alignment.');
    expect(item.keyPoints).toEqual(['Introduces a new alignment framework', 'Compares with existing approaches']);
    expect(item.tags).toEqual(['alignment', 'ai-safety']);
    expect(item.resourceSubtype).toBe('blog_post');
    expect(item.resourcePurpose).toBe('commentary');
    expect(item.contextNote).toBe('A blog post about AI alignment techniques.');
  });

  it('normalizes importance_score from 0-100 to 0-1', async () => {
    setupDefaultMocks();
    const llmResult = validLlmResult();
    llmResult.importance_score = 80;
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify(llmResult),
      usage: { input_tokens: 1500, output_tokens: 400 },
      model: 'claude-sonnet-test',
    });

    await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    const item = mockUpsertResourceBatch.mock.calls[0][0][0];
    expect(item.importanceScore).toBe(0.8);
  });
});

describe('handleResourceEnrich — content fallback', () => {
  it('enriches from URL+title when no cached content', async () => {
    setupDefaultMocks();
    mockGetCitationContent.mockResolvedValue({
      ok: false,
      data: null,
      message: 'not found',
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.contentAvailable).toBe(false);
    // LLM should still be called
    expect(mockCallLlm).toHaveBeenCalled();
  });

  it('enriches when citation content has empty fullText', async () => {
    setupDefaultMocks();
    mockGetCitationContent.mockResolvedValue({
      ok: true,
      data: { fullText: '', fullTextPreview: '', pageTitle: null },
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.contentAvailable).toBe(false);
  });
});

describe('handleResourceEnrich — title update guard', () => {
  it('does not update a good existing title', async () => {
    const llmResult = validLlmResult();
    llmResult.clean_title = 'LLM Suggested Title';
    setupDefaultMocks(mockResource({ title: 'A Good Long Title About AI Safety' }));
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify(llmResult),
      usage: { input_tokens: 1500, output_tokens: 400 },
      model: 'claude-sonnet-test',
    });

    await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    const item = mockUpsertResourceBatch.mock.calls[0][0][0];
    expect(item.title).toBeUndefined();
  });

  it('updates a short truncated title', async () => {
    const llmResult = validLlmResult();
    llmResult.clean_title = 'Full Restored Title';
    setupDefaultMocks(mockResource({ title: 'Short...' }));
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify(llmResult),
      usage: { input_tokens: 1500, output_tokens: 400 },
      model: 'claude-sonnet-test',
    });

    await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    const item = mockUpsertResourceBatch.mock.calls[0][0][0];
    expect(item.title).toBe('Full Restored Title');
  });
});

describe('handleResourceEnrich — error handling', () => {
  it('returns failure when resource fetch fails', async () => {
    mockGetResource.mockResolvedValue({
      ok: false,
      message: 'Resource not found',
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-missing', url: 'https://example.com/gone' },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to fetch resource');
  });

  it('returns failure on LLM JSON parse error', async () => {
    setupDefaultMocks();
    mockCallLlm.mockResolvedValue({
      text: 'This is not valid JSON at all',
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-sonnet-test',
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/JSON|Unexpected|parse/i);
  });

  it('returns failure on LLM response validation error', async () => {
    setupDefaultMocks();
    // Return valid JSON but missing required fields
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify({ resource_subtype: 'blog_post' }),
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-sonnet-test',
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('validation failed');
  });

  it('returns failure when batch write fails', async () => {
    setupDefaultMocks();
    mockUpsertResourceBatch.mockResolvedValue({
      ok: false,
      message: 'Database connection lost',
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to persist enrichment');
  });

  it('handles LLM exception gracefully', async () => {
    setupDefaultMocks();
    mockCallLlm.mockRejectedValue(new Error('Rate limited'));

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limited');
  });
});
describe('handleResourceEnrich — URL discovery', () => {
  it('suggests discovered URLs via suggestResourcesApi', async () => {
    setupDefaultMocks();
    const llmResult = validLlmResult();
    (llmResult as Record<string, unknown>).discovered_urls = [
      'https://arxiv.org/abs/2301.00001',
      'https://alignment-forum.org/post/123',
    ];
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify(llmResult),
      usage: { input_tokens: 1500, output_tokens: 400 },
      model: 'claude-sonnet-test',
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.discoveredUrls).toEqual([
      'https://arxiv.org/abs/2301.00001',
      'https://alignment-forum.org/post/123',
    ]);
    expect(mockSuggestResourcesApi).toHaveBeenCalledWith({
      urls: [
        'https://arxiv.org/abs/2301.00001',
        'https://alignment-forum.org/post/123',
      ],
    });
  });

  it('filters out the source URL from discovered URLs', async () => {
    setupDefaultMocks();
    const llmResult = validLlmResult();
    (llmResult as Record<string, unknown>).discovered_urls = [
      'https://example.com/article',
      'https://arxiv.org/abs/2301.00001',
    ];
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify(llmResult),
      usage: { input_tokens: 1500, output_tokens: 400 },
      model: 'claude-sonnet-test',
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.discoveredUrls).toEqual(['https://arxiv.org/abs/2301.00001']);
  });

  it('does not call suggestResourcesApi when no URLs discovered', async () => {
    setupDefaultMocks();

    await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(mockSuggestResourcesApi).not.toHaveBeenCalled();
  });

  it('still succeeds when suggestResourcesApi fails', async () => {
    setupDefaultMocks();
    const llmResult = validLlmResult();
    (llmResult as Record<string, unknown>).discovered_urls = ['https://arxiv.org/abs/2301.00001'];
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify(llmResult),
      usage: { input_tokens: 1500, output_tokens: 400 },
      model: 'claude-sonnet-test',
    });
    mockSuggestResourcesApi.mockRejectedValue(new Error('Server down'));

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.discoveredUrls).toEqual(['https://arxiv.org/abs/2301.00001']);
  });
});

// QUA-312 Phase 2 — contentChanged temporal fix + URL fast-path override
describe('handleResourceEnrich — contentChanged skip-guard bypass (QUA-312)', () => {
  it('still skips already-enriched resources when contentChanged is omitted', async () => {
    mockGetResource.mockResolvedValue({
      ok: true,
      data: mockResource({ enrichmentStatus: 'enriched' }),
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.skipped).toBe(true);
    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it('still skips already-enriched resources when contentChanged=false', async () => {
    mockGetResource.mockResolvedValue({
      ok: true,
      data: mockResource({ enrichmentStatus: 'enriched' }),
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article', contentChanged: false },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.skipped).toBe(true);
    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it('bypasses skip guard for "enriched" resources when contentChanged=true', async () => {
    setupDefaultMocks(mockResource({ enrichmentStatus: 'enriched' }));

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article', contentChanged: true },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.skipped).toBeUndefined();
    expect(mockCallLlm).toHaveBeenCalled();
    expect(mockUpsertResourceBatch).toHaveBeenCalled();
  });

  it('bypasses skip guard for "reviewed" resources when contentChanged=true', async () => {
    setupDefaultMocks(mockResource({ enrichmentStatus: 'reviewed' }));

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article', contentChanged: true },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.skipped).toBeUndefined();
    expect(mockCallLlm).toHaveBeenCalled();
  });

  it('rejects non-boolean contentChanged via Zod', async () => {
    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/article', contentChanged: 'yes' },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid params');
  });
});

describe('handleResourceEnrich — URL-heuristic resource_purpose override (QUA-312)', () => {
  it('overrides resource_purpose to "homepage" when URL is a bare domain', async () => {
    setupDefaultMocks(mockResource({ url: 'https://anthropic.com/' }));
    // LLM returns "primary_source", but URL says "homepage" — heuristic wins.
    const llmResult = validLlmResult();
    llmResult.resource_purpose = 'primary_source';
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify(llmResult),
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-sonnet-test',
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://anthropic.com/' },
      CTX,
    );

    expect(result.success).toBe(true);
    // The downstream LLM still ran (we need summary, key_points, etc.)
    expect(mockCallLlm).toHaveBeenCalled();
    const item = mockUpsertResourceBatch.mock.calls[0][0][0];
    // resource_purpose was overridden by the URL heuristic.
    expect(item.resourcePurpose).toBe('homepage');
    // But other fields still come from the LLM.
    expect(item.summary).toBe('This post discusses novel approaches to AI alignment.');
    expect(item.keyPoints).toEqual([
      'Introduces a new alignment framework',
      'Compares with existing approaches',
    ]);
  });

  it('does NOT override resource_purpose for ambiguous URLs', async () => {
    setupDefaultMocks(mockResource({ url: 'https://example.com/blog/2024/post' }));
    const llmResult = validLlmResult();
    llmResult.resource_purpose = 'commentary';
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify(llmResult),
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-sonnet-test',
    });

    await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/blog/2024/post' },
      CTX,
    );

    const item = mockUpsertResourceBatch.mock.calls[0][0][0];
    expect(item.resourcePurpose).toBe('commentary');
  });

  it('overrides resource_purpose for /about-style paths', async () => {
    setupDefaultMocks(mockResource({ url: 'https://openai.com/about' }));
    const llmResult = validLlmResult();
    llmResult.resource_purpose = 'commentary';
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify(llmResult),
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-sonnet-test',
    });

    await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://openai.com/about' },
      CTX,
    );

    const item = mockUpsertResourceBatch.mock.calls[0][0][0];
    expect(item.resourcePurpose).toBe('homepage');
  });

  it('does NOT override resource_purpose for PDF URLs (high confidence non-homepage)', async () => {
    setupDefaultMocks(mockResource({ url: 'https://example.com/report.pdf' }));
    const llmResult = validLlmResult();
    llmResult.resource_purpose = 'primary_source';
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify(llmResult),
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-sonnet-test',
    });

    await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://example.com/report.pdf' },
      CTX,
    );

    const item = mockUpsertResourceBatch.mock.calls[0][0][0];
    expect(item.resourcePurpose).toBe('primary_source');
  });

  it('still writes enrichmentStatus="enriched" (not "classified") on URL override', async () => {
    setupDefaultMocks(mockResource({ url: 'https://anthropic.com/' }));

    await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://anthropic.com/' },
      CTX,
    );

    const item = mockUpsertResourceBatch.mock.calls[0][0][0];
    // Combined enrich step writes "enriched" — only the standalone classify step
    // writes "classified". URL override here doesn't change that.
    expect(item.enrichmentStatus).toBe('enriched');
  });

  it('does NOT apply the URL override when the LLM response fails validation', async () => {
    // Even for a bare-domain homepage URL, if the LLM returns invalid JSON,
    // we must fail the job rather than write a half-populated record using
    // only the URL-derived fields.
    setupDefaultMocks(mockResource({ url: 'https://anthropic.com/' }));
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify({ resource_subtype: 'blog_post' }), // missing required fields
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-sonnet-test',
    });

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://anthropic.com/' },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('validation failed');
    // Crucially: no partial-write leaked to upsertResourceBatch.
    expect(mockUpsertResourceBatch).not.toHaveBeenCalled();
  });

  it('does NOT apply the URL override when the LLM throws', async () => {
    setupDefaultMocks(mockResource({ url: 'https://anthropic.com/' }));
    mockCallLlm.mockRejectedValue(new Error('Rate limited'));

    const result = await handleResourceEnrich(
      { resourceId: 'res-1', url: 'https://anthropic.com/' },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(mockUpsertResourceBatch).not.toHaveBeenCalled();
  });
});

