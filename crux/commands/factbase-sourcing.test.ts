/**
 * Tests for the FactBase sourcing CLI command.
 *
 * Tests the dry-run mode with real KB data (no LLM calls needed).
 * The sourcing logic itself is tested via integration with the command handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commands } from './factbase.ts';

const sourcing = commands['sourcing'];

// ---------------------------------------------------------------------------
// Mock verdict-handler so storeSourcingResult tests don't hit the wiki-server.
// Issue #4017 — ensure the command goes through storeSourcingEvidence
// (which auto-resolves resourceId) instead of the raw storeEvidence RPC.
// ---------------------------------------------------------------------------

const mockStoreSourcingEvidence = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const mockStoreAggregateVerdict = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});

vi.mock('../lib/sourcing/verdict-handler.ts', () => ({
  storeSourcingEvidence: (...args: unknown[]) => mockStoreSourcingEvidence(...args),
  storeAggregateVerdict: (...args: unknown[]) => mockStoreAggregateVerdict(...args),
}));

// QUA-851: mock fetchVerdictRecordIds so --where-no-verdict tests don't hit
// the wiki-server. The default returns an empty set (no verdicts yet).
const mockFetchVerdictRecordIds = vi.fn<
  (...args: unknown[]) => Promise<{ ok: true; data: Set<string> } | { ok: false; error: string; message: string }>
>(async () => ({ ok: true, data: new Set<string>() }));

vi.mock('../lib/wiki-server/sourcing-client.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchVerdictRecordIds: (...args: unknown[]) => mockFetchVerdictRecordIds(...args),
  };
});

describe('crux fb sourcing --dry-run', () => {
  it('lists facts to verify for a specific entity', async () => {
    const result = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      limit: '3',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Dry run');
    expect(result.output).toContain('Anthropic');
    expect(result.output).toContain('would be verified');
  });

  it('returns JSON in CI mode', async () => {
    const result = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      limit: '2',
      ci: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeLessThanOrEqual(2);
    expect(data[0]).toHaveProperty('factId');
    expect(data[0]).toHaveProperty('entityId');
    expect(data[0]).toHaveProperty('entityName');
    expect(data[0]).toHaveProperty('source');
  });

  it('finds a specific fact by ID', async () => {
    const result = await sourcing([], {
      fact: 'f_dW5cR9mJ8q',
      'dry-run': true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('1 fact(s)');
    expect(result.output).toContain('Anthropic');
    expect(result.output).toContain('Revenue');
  });

  it('reports no facts when entity has none with sources', async () => {
    const result = await sourcing([], {
      entity: 'nonexistent-entity',
      'dry-run': true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No facts with source URLs');
  });

  it('reports no facts when fact ID does not exist', async () => {
    const result = await sourcing([], {
      fact: 'f_nonexistent',
      'dry-run': true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('not found or has no source URL');
  });

  it('respects --limit option', async () => {
    const result = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      limit: '2',
      ci: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.length).toBe(2);
  });

  it('skips inverse facts (inv_ prefix)', async () => {
    // All facts in the dry-run output should be non-inverse
    const result = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      ci: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output) as Array<{ factId: string }>;
    for (const fact of data) {
      expect(fact.factId).not.toMatch(/^inv_/);
    }
  });

  it('all listed facts have source URLs', async () => {
    const result = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      ci: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output) as Array<{ source: string }>;
    for (const fact of data) {
      expect(fact.source).toBeTruthy();
      expect(fact.source).toMatch(/^https?:\/\//);
    }
  });

  it('--where-no-verdict skips facts whose IDs are in the verdict set (QUA-851)', async () => {
    // Get the full list of fact IDs first, no filter
    const baseline = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      ci: true,
    });
    expect(baseline.exitCode).toBe(0);
    const baselineFacts = JSON.parse(baseline.output) as Array<{ factId: string }>;
    expect(baselineFacts.length).toBeGreaterThan(1);

    // Mark the first one as already-verified; it should be skipped
    const skipId = baselineFacts[0].factId;
    mockFetchVerdictRecordIds.mockResolvedValueOnce({
      ok: true,
      data: new Set([skipId]),
    });

    const result = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      ci: true,
      'where-no-verdict': true,
    });
    expect(result.exitCode).toBe(0);
    const filteredFacts = JSON.parse(result.output) as Array<{ factId: string }>;
    expect(filteredFacts.map((f) => f.factId)).not.toContain(skipId);
    expect(filteredFacts.length).toBe(baselineFacts.length - 1);

    expect(mockFetchVerdictRecordIds).toHaveBeenCalledWith('fact');
  });

  it('--where-no-verdict aborts when verdict fetch fails (fail-closed)', async () => {
    mockFetchVerdictRecordIds.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'wiki-server unreachable',
    });

    const result = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      'where-no-verdict': true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Failed to fetch existing fact verdicts');
    expect(result.output).toContain('wiki-server unreachable');
  });

  it('--where-no-verdict --limit=N counts AFTER filtering (QUA-851 headline use case)', async () => {
    // Get baseline list of fact IDs for the entity
    const baseline = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      ci: true,
    });
    const baselineFacts = JSON.parse(baseline.output) as Array<{ factId: string }>;
    expect(baselineFacts.length).toBeGreaterThanOrEqual(3);

    // Mark the first two as already-verified
    mockFetchVerdictRecordIds.mockResolvedValueOnce({
      ok: true,
      data: new Set([baselineFacts[0].factId, baselineFacts[1].factId]),
    });

    // Ask for 3 — we should get 3 _unverified_ facts, none being the skipped two
    const result = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      ci: true,
      'where-no-verdict': true,
      limit: '3',
    });
    expect(result.exitCode).toBe(0);
    const filteredFacts = JSON.parse(result.output) as Array<{ factId: string }>;
    expect(filteredFacts.length).toBe(3);
    expect(filteredFacts.map((f) => f.factId)).not.toContain(baselineFacts[0].factId);
    expect(filteredFacts.map((f) => f.factId)).not.toContain(baselineFacts[1].factId);
  });

  it('--where-no-verdict --fact=X bypasses the filter (explicit fact lookup)', async () => {
    const factId = 'f_dW5cR9mJ8q';
    // Even if the fact's ID is in the verified set, --fact=X should still find it.
    mockFetchVerdictRecordIds.mockResolvedValueOnce({
      ok: true,
      data: new Set([factId]),
    });

    const result = await sourcing([], {
      fact: factId,
      'dry-run': true,
      'where-no-verdict': true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('1 fact(s)');
  });

  it('--where-no-verdict applied to all-entities branch (no entity/fact filter)', async () => {
    // Get a sample fact ID that exists in the global pool
    const sample = await sourcing([], {
      'dry-run': true,
      ci: true,
      limit: '1',
    });
    const sampleFacts = JSON.parse(sample.output) as Array<{ factId: string }>;
    expect(sampleFacts.length).toBe(1);
    const skipId = sampleFacts[0].factId;

    // Ask for 5 facts globally, with the sample one in the verified set.
    mockFetchVerdictRecordIds.mockResolvedValueOnce({
      ok: true,
      data: new Set([skipId]),
    });
    const result = await sourcing([], {
      'dry-run': true,
      ci: true,
      'where-no-verdict': true,
      limit: '5',
    });
    expect(result.exitCode).toBe(0);
    const filteredFacts = JSON.parse(result.output) as Array<{ factId: string }>;
    expect(filteredFacts.length).toBe(5);
    expect(filteredFacts.map((f) => f.factId)).not.toContain(skipId);
  });

  it('--where-no-verdict with empty verdict set returns all facts unchanged', async () => {
    // Default mock returns empty set
    mockFetchVerdictRecordIds.mockResolvedValueOnce({
      ok: true,
      data: new Set<string>(),
    });

    const baseline = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      ci: true,
    });
    const baselineFacts = JSON.parse(baseline.output) as Array<{ factId: string }>;

    const result = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      ci: true,
      'where-no-verdict': true,
    });
    expect(result.exitCode).toBe(0);
    const filteredFacts = JSON.parse(result.output) as Array<{ factId: string }>;
    expect(filteredFacts.length).toBe(baselineFacts.length);
  });

  it('skips facts with non-verifiable properties (QUA-247)', async () => {
    // Anthropic has secondary-valuation, equity-stake-percent, equity-value,
    // and employee-tender-offer facts — all marked verifiable:false in properties.yaml.
    // These should be excluded from the dry-run output.
    const NON_VERIFIABLE_PROPERTIES = [
      'secondary-valuation',
      'equity-stake-percent',
      'equity-value',
      'employee-tender-offer',
    ];

    const result = await sourcing([], {
      entity: 'anthropic',
      'dry-run': true,
      ci: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output) as Array<{ propertyId: string }>;

    for (const fact of data) {
      expect(NON_VERIFIABLE_PROPERTIES).not.toContain(fact.propertyId);
    }
  });
});

// ---------------------------------------------------------------------------
// storeSourcingResult — issue #4017
// ---------------------------------------------------------------------------

describe('storeSourcingResult (issue #4017)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreSourcingEvidence.mockImplementation(async () => {});
    mockStoreAggregateVerdict.mockImplementation(async () => {});
  });

  it('routes through storeSourcingEvidence with sourceUrl so resourceId can be auto-resolved', async () => {
    // Re-import after mocks are set up
    const { storeSourcingResult } = await import('./factbase-sourcing.ts');

    await storeSourcingResult({
      factId: 'f_abc1234567',
      entityId: 'sid_anthropic',
      entityName: 'Anthropic',
      propertyId: 'revenue',
      propertyName: 'Revenue',
      formattedValue: '$3B',
      sourceUrl: 'https://example.com/anthropic-revenue',
      verdict: 'confirmed',
      confidence: 0.9,
      extractedValue: '$3 billion',
      reasoning: 'Confirmed by source',
    });

    expect(mockStoreSourcingEvidence).toHaveBeenCalledOnce();
    const args = mockStoreSourcingEvidence.mock.calls[0][0] as {
      sourceUrl: string;
      recordType: string;
      recordId: string;
      verdict: string;
    };
    // Critical: sourceUrl is forwarded — verdict-handler will look up the
    // matching resourceId via lookupResourceByUrl(). The previous direct
    // storeEvidence RPC call didn't pass enough info for auto-resolution.
    expect(args.sourceUrl).toBe('https://example.com/anthropic-revenue');
    expect(args.recordType).toBe('fact');
    expect(args.recordId).toBe('f_abc1234567');
    expect(args.verdict).toBe('confirmed');

    expect(mockStoreAggregateVerdict).toHaveBeenCalledOnce();
  });

  it('propagates storage failure as a thrown error', async () => {
    const { storeSourcingResult } = await import('./factbase-sourcing.ts');

    mockStoreSourcingEvidence.mockRejectedValueOnce(new Error('wiki-server down'));

    await expect(
      storeSourcingResult({
        factId: 'f_xyz',
        entityId: 'sid_x',
        entityName: 'X',
        propertyId: 'revenue',
        propertyName: 'Revenue',
        formattedValue: '$1B',
        sourceUrl: 'https://example.com',
        verdict: 'confirmed',
        confidence: 0.9,
        extractedValue: '$1 billion',
        reasoning: 'ok',
      }),
    ).rejects.toThrow(/wiki-server down/);
  });
});
