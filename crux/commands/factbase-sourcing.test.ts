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

  it('skips facts with nonVerifiable properties (QUA-247)', async () => {
    // Anthropic has secondary-valuation, equity-stake-percent, equity-value,
    // and employee-tender-offer facts — all marked nonVerifiable in properties.yaml.
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
