/**
 * Tests for claim-verification handler — LLM output validation logic.
 *
 * Covers:
 *  - Unknown claimId in LLM response is skipped
 *  - Duplicate claimId in LLM response is skipped (second occurrence)
 *  - Omitted claimId gets an "LLM omitted this claim" error entry
 *  - Verdict write failure causes handler to return { success: false }
 *
 * All external calls (apiRequest, callLlm, etc.) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleClaimVerification } from '../claim-verification.ts';
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
// Mock: LLM layer
// ---------------------------------------------------------------------------

const mockCallLlm = vi.fn<() => Promise<{ text: string }>>();

vi.mock('../../llm.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../llm.ts')>();
  return {
    ...actual,
    createLlmClient: vi.fn(() => ({})),
    callLlm: (...args: unknown[]) => mockCallLlm(),
    MODELS: { haiku: 'claude-haiku-test', sonnet: 'claude-sonnet-test' },
  };
});

// ---------------------------------------------------------------------------
// Mock: citations (getCitationContentByUrl)
// ---------------------------------------------------------------------------

vi.mock('../../wiki-server/citations.ts', () => ({
  getCitationContentByUrl: vi.fn(async () => ({
    ok: false,
    data: null,
    message: 'not found',
  })),
}));

// ---------------------------------------------------------------------------
// Mock: source-check evidence storage
// ---------------------------------------------------------------------------

vi.mock('../../source-check/verdict-handler.ts', () => ({
  storeSourceCheckEvidence: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CTX: JobHandlerContext = {
  workerId: 'test-worker',
  projectRoot: '/tmp/test',
  verbose: false,
};

/** Build a minimal ClaimRow for testing. */
function makeClaim(id: number, text = `Claim ${id}`) {
  return {
    id,
    claim_text: text,
    source_url: 'https://example.com/source',
    target_table: 'fact',
    target_field: 'value',
    proposed_value: 'test',
    agent_evidence: null,
    resource_id: null,
  };
}

/** Build the default job params. */
function makeParams(claimIds: number[], batchId = 'batch-test') {
  return {
    claimIds,
    resourceId: 'res-1',
    batchId,
    entityId: 'ent-1',
  };
}

/**
 * Set up standard mocks for a test run:
 *  - GET /api/claims/by-ids returns the given claims
 *  - GET /api/resources/.../content returns source content
 *  - POST /api/claims/verdicts succeeds by default
 */
function setupStandardMocks(claims: ReturnType<typeof makeClaim>[]) {
  mockApiRequest.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path.startsWith('/api/claims/by-ids')) {
      return { ok: true, data: { claims } };
    }
    if (method === 'GET' && path.includes('/api/resources/') && path.includes('/content')) {
      return {
        ok: true,
        data: {
          url: 'https://example.com/source',
          title: 'Test Source',
          content: { fullText: 'Source content about AI safety.', pageTitle: 'Test' },
        },
      };
    }
    if (method === 'POST' && path === '/api/claims/verdicts') {
      return { ok: true, data: { updated: claims.length, total: claims.length } };
    }
    return { ok: false, message: `Unexpected request: ${method} ${path}` };
  });
}

/** Build a JSON LLM response string from claim verification results. */
function llmResponse(results: Array<{
  claimId: number;
  verdict?: string;
  confidence?: number;
  extracted_value?: string;
  reasoning?: string;
}>): string {
  return JSON.stringify(
    results.map((r) => ({
      claimId: r.claimId,
      verdict: r.verdict ?? 'confirmed',
      confidence: r.confidence ?? 0.9,
      extracted_value: r.extracted_value ?? 'extracted text',
      reasoning: r.reasoning ?? 'test reasoning',
    })),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleClaimVerification — LLM output validation', () => {
  it('skips unknown claimIds and marks expected claims as unverifiable', async () => {
    const claims = [makeClaim(1), makeClaim(2)];
    setupStandardMocks(claims);

    // LLM returns claim 999 (unknown) and claim 1 (valid), omits claim 2
    mockCallLlm.mockResolvedValueOnce({
      text: llmResponse([
        { claimId: 999, verdict: 'confirmed' },
        { claimId: 1, verdict: 'confirmed' },
      ]),
    });

    const result = await handleClaimVerification(makeParams([1, 2]), CTX);

    expect(result.success).toBe(true);

    // Only claim 1 should be in the successful results
    const data = result.data as { results: Array<{ claimId: number }>; errors: number };
    expect(data.results).toHaveLength(1);
    expect(data.results[0].claimId).toBe(1);

    // Claim 2 was omitted — should be counted as an error
    expect(data.errors).toBe(1);

    // The verdicts POST should include claim 2 as unverifiable
    const verdictsCall = mockApiRequest.mock.calls.find(
      (call) => call[0] === 'POST' && call[1] === '/api/claims/verdicts',
    );
    expect(verdictsCall).toBeDefined();
    const verdicts = verdictsCall![2].verdicts as Array<{ claimId: number; status: string; reasoning: string }>;

    // Claim 2 should be unverifiable with "LLM omitted" reasoning
    const claim2Verdict = verdicts.find((v) => v.claimId === 2);
    expect(claim2Verdict).toBeDefined();
    expect(claim2Verdict!.status).toBe('unverifiable');
    expect(claim2Verdict!.reasoning).toContain('LLM omitted this claim');

    // Unknown claim 999 should NOT appear in verdicts at all
    const claim999Verdict = verdicts.find((v) => v.claimId === 999);
    expect(claim999Verdict).toBeUndefined();
  });

  it('skips duplicate claimIds (keeps first occurrence only)', async () => {
    const claims = [makeClaim(10), makeClaim(20)];
    setupStandardMocks(claims);

    // LLM returns claim 10 twice and claim 20 once
    mockCallLlm.mockResolvedValueOnce({
      text: llmResponse([
        { claimId: 10, verdict: 'confirmed', confidence: 0.95 },
        { claimId: 10, verdict: 'contradicted', confidence: 0.5 },
        { claimId: 20, verdict: 'partial', confidence: 0.7 },
      ]),
    });

    const result = await handleClaimVerification(makeParams([10, 20]), CTX);

    expect(result.success).toBe(true);

    const data = result.data as {
      results: Array<{ claimId: number; verdict: string; confidence: number }>;
      errors: number;
      confirmed: number;
      contradicted: number;
    };

    // Both claims should be in results (first occurrence of 10, and 20)
    expect(data.results).toHaveLength(2);
    expect(data.results.find((r) => r.claimId === 10)?.verdict).toBe('confirmed');
    expect(data.results.find((r) => r.claimId === 10)?.confidence).toBe(0.95);

    // No errors — both claims were covered
    expect(data.errors).toBe(0);

    // Confirm the duplicate "contradicted" verdict for claim 10 was dropped
    expect(data.confirmed).toBe(1); // claim 10 = confirmed (first)
    expect(data.contradicted).toBe(0); // duplicate contradicted was skipped
  });

  it('marks omitted claims as unverifiable with error entry', async () => {
    const claims = [makeClaim(100), makeClaim(200), makeClaim(300)];
    setupStandardMocks(claims);

    // LLM only returns verdict for claim 200, omitting 100 and 300
    mockCallLlm.mockResolvedValueOnce({
      text: llmResponse([
        { claimId: 200, verdict: 'confirmed' },
      ]),
    });

    const result = await handleClaimVerification(makeParams([100, 200, 300]), CTX);

    expect(result.success).toBe(true);

    const data = result.data as {
      results: Array<{ claimId: number }>;
      errors: number;
      unverifiable: number;
      confirmed: number;
      totalClaims: number;
    };

    // Only claim 200 verified successfully
    expect(data.results).toHaveLength(1);
    expect(data.results[0].claimId).toBe(200);
    expect(data.confirmed).toBe(1);

    // Claims 100 and 300 omitted → 2 errors
    expect(data.errors).toBe(2);
    // Unverifiable count = LLM unverifiable verdicts (0) + errors (2)
    expect(data.unverifiable).toBe(2);
    expect(data.totalClaims).toBe(3);

    // Verify the verdicts POST includes unverifiable entries for omitted claims
    const verdictsCall = mockApiRequest.mock.calls.find(
      (call) => call[0] === 'POST' && call[1] === '/api/claims/verdicts',
    );
    const verdicts = verdictsCall![2].verdicts as Array<{ claimId: number; status: string; reasoning: string }>;

    for (const omittedId of [100, 300]) {
      const v = verdicts.find((vv) => vv.claimId === omittedId);
      expect(v).toBeDefined();
      expect(v!.status).toBe('unverifiable');
      expect(v!.reasoning).toContain('LLM omitted this claim');
    }
  });

  it('returns failure when verdict write fails', async () => {
    // Note: In production, the /api/claims/verdicts endpoint returns HTTP 200 even on
    // partial failures. This test mocks apiRequest returning { ok: false } to simulate
    // network errors, timeouts, or future error status codes from the endpoint.
    const claims = [makeClaim(5)];

    mockApiRequest.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/api/claims/by-ids')) {
        return { ok: true, data: { claims } };
      }
      if (method === 'GET' && path.includes('/api/resources/') && path.includes('/content')) {
        return {
          ok: true,
          data: {
            url: 'https://example.com/source',
            title: 'Test Source',
            content: { fullText: 'Source content.', pageTitle: 'Test' },
          },
        };
      }
      if (method === 'POST' && path === '/api/claims/verdicts') {
        return { ok: false, message: 'Database connection failed' };
      }
      return { ok: false, message: `Unexpected: ${method} ${path}` };
    });

    mockCallLlm.mockResolvedValueOnce({
      text: llmResponse([{ claimId: 5, verdict: 'confirmed' }]),
    });

    const result = await handleClaimVerification(makeParams([5]), CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to persist verdicts');
    expect(result.error).toContain('Database connection failed');
  });
});
