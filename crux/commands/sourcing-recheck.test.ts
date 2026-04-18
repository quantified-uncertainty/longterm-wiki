/**
 * Tests for the --verdict flag added in QUA-546 — force-recheck of specific
 * verdict types (bypassing the due-date filter). Focused on the code path
 * that differs from the default due-for-recheck flow: input validation,
 * which API is called, pagination, and empty-result handling.
 *
 * Uses --dry-run so the LLM layer doesn't need stubbing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListVerdicts = vi.fn();
const mockGetDueForRecheck = vi.fn();
const mockGetEvidenceByRecords = vi.fn();
const mockStoreVerdict = vi.fn();

vi.mock('../lib/wiki-server/sourcing-client.ts', () => ({
  listVerdicts: (...args: unknown[]) => mockListVerdicts(...args),
  getDueForRecheck: (...args: unknown[]) => mockGetDueForRecheck(...args),
  getEvidenceByRecords: (...args: unknown[]) => mockGetEvidenceByRecords(...args),
  storeVerdict: (...args: unknown[]) => mockStoreVerdict(...args),
  evidenceRecordKey: (rt: string, rid: string) => `${rt}|${rid}`,
}));

vi.mock('../lib/llm.ts', () => ({
  createLlmClient: vi.fn(() => ({})),
  callLlm: vi.fn(),
}));

vi.mock('../lib/sourcing/index.ts', () => ({
  fetchSourceContent: vi.fn(),
  callLlmForSourcing: vi.fn(),
  storeSourcingEvidence: vi.fn(),
  storeAggregateVerdict: vi.fn(),
  SOURCE_CHECK_CONSTANTS: {
    ESTIMATED_COST_PER_VERIFICATION: 0.01,
    PROMPT_CONTENT_LENGTH: 50000,
  },
}));

import { commands } from './sourcing-recheck.ts';

const recheck = commands.default;

function makeVerdict(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    recordType: 'grant',
    recordId: 'g_test_1',
    fieldName: null,
    entityId: 'anthropic',
    displayName: 'Test grant',
    entityDisplayName: 'Anthropic',
    verdict: 'partial',
    confidence: 0.6,
    reasoning: 'Source partially confirms amount',
    sourcesChecked: 1,
    needsRecheck: false,
    nextCheckDue: '2026-05-17',
    lastComputedAt: '2026-04-16',
    createdAt: '2026-04-01',
    updatedAt: '2026-04-16',
    ...overrides,
  };
}

describe('sourcing-recheck --verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unknown verdict values', async () => {
    const result = await recheck([], { verdict: 'typo', 'dry-run': true } as never);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid --verdict');
    expect(mockListVerdicts).not.toHaveBeenCalled();
    expect(mockGetDueForRecheck).not.toHaveBeenCalled();
  });

  it('calls listVerdicts (not getDueForRecheck) when --verdict is set', async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [makeVerdict()], total: 1 },
    });
    const result = await recheck([], {
      verdict: 'partial',
      limit: '5',
      budget: '1',
      'dry-run': true,
    } as never);
    expect(result.exitCode).toBe(0);
    expect(mockListVerdicts).toHaveBeenCalledTimes(1);
    expect(mockListVerdicts).toHaveBeenCalledWith({
      verdict: 'partial',
      recordType: undefined,
      limit: 5,
      offset: 0,
    });
    expect(mockGetDueForRecheck).not.toHaveBeenCalled();
    expect(result.output).toContain('partial');
  });

  it('passes --type through to listVerdicts as recordType', async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [makeVerdict({ recordType: 'personnel' })], total: 1 },
    });
    await recheck([], {
      verdict: 'partial',
      type: 'personnel',
      limit: '10',
      'dry-run': true,
    } as never);
    expect(mockListVerdicts).toHaveBeenCalledWith(
      expect.objectContaining({ recordType: 'personnel', verdict: 'partial' }),
    );
  });

  it('paginates when server total exceeds the 200-row per-page cap', async () => {
    // Simulate 350 matching rows. With a 200-row page size, the command
    // should make two calls: offset=0 (200 rows) and offset=200 (150 rows).
    const page1 = Array.from({ length: 200 }, (_, i) =>
      makeVerdict({ recordId: `g_${i}` }),
    );
    const page2 = Array.from({ length: 150 }, (_, i) =>
      makeVerdict({ recordId: `g_${200 + i}` }),
    );
    mockListVerdicts
      .mockResolvedValueOnce({ ok: true, data: { verdicts: page1, total: 350 } })
      .mockResolvedValueOnce({ ok: true, data: { verdicts: page2, total: 350 } });

    const result = await recheck([], {
      verdict: 'partial',
      limit: '500',
      budget: '10',
      'dry-run': true,
    } as never);
    expect(result.exitCode).toBe(0);
    expect(mockListVerdicts).toHaveBeenCalledTimes(2);
    expect(mockListVerdicts).toHaveBeenNthCalledWith(1, expect.objectContaining({ offset: 0, limit: 200 }));
    expect(mockListVerdicts).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 200, limit: 200 }));
  });

  it('stops paginating once itemLimit is satisfied', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => makeVerdict({ recordId: `g_${i}` }));
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: page1, total: 2000 },
    });
    await recheck([], {
      verdict: 'partial',
      limit: '200',
      budget: '10',
      'dry-run': true,
    } as never);
    expect(mockListVerdicts).toHaveBeenCalledTimes(1);
  });

  it('shrinks the final page request to remaining itemLimit (mid-page truncation)', async () => {
    // itemLimit=250 → page 1 asks for 200, page 2 asks for 50 (not another 200).
    const page1 = Array.from({ length: 200 }, (_, i) => makeVerdict({ recordId: `g_${i}` }));
    const page2 = Array.from({ length: 50 }, (_, i) => makeVerdict({ recordId: `g_${200 + i}` }));
    mockListVerdicts
      .mockResolvedValueOnce({ ok: true, data: { verdicts: page1, total: 2000 } })
      .mockResolvedValueOnce({ ok: true, data: { verdicts: page2, total: 2000 } });

    await recheck([], {
      verdict: 'partial',
      limit: '250',
      budget: '10',
      'dry-run': true,
    } as never);
    expect(mockListVerdicts).toHaveBeenCalledTimes(2);
    expect(mockListVerdicts).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 200, offset: 0 }));
    expect(mockListVerdicts).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 50, offset: 200 }));
  });

  it('aborts if pagination exceeds MAX_ITERATIONS (broken server metadata)', async () => {
    // Simulate a broken server that returns 1 row but claims total=99999
    // every time. Without a max-iterations guard, the command would loop
    // until it hit --limit. With the guard, it aborts at 100 iterations.
    mockListVerdicts.mockResolvedValue({
      ok: true,
      data: { verdicts: [makeVerdict()], total: 99999 },
    });
    const result = await recheck([], {
      verdict: 'partial',
      limit: '100000',
      budget: '1000',
      'dry-run': true,
    } as never);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/pagination exceeded/i);
    // Should have bailed well before the --limit of 100000 would naturally stop it.
    expect(mockListVerdicts.mock.calls.length).toBeLessThanOrEqual(101);
  });

  it('returns a friendly message when no verdicts match', async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [], total: 0 },
    });
    const result = await recheck([], {
      verdict: 'contradicted',
      'dry-run': true,
    } as never);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/No verdicts matched/i);
  });

  it('surfaces listVerdicts failures as exit=1', async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: false,
      message: 'boom',
      error: { code: 'HTTP_500' },
    });
    const result = await recheck([], {
      verdict: 'partial',
      'dry-run': true,
    } as never);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('boom');
  });
});
