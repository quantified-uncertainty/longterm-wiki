/**
 * Tests for the FactBase source-check CLI command.
 *
 * Tests the dry-run mode with real KB data (no LLM calls needed).
 * The source-check logic itself is tested via integration with the command handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commands } from './factbase.ts';

const sourceCheck = commands['source-check'];

// ---------------------------------------------------------------------------
// Mock verdict-handler so storeSourceCheckResult tests don't hit the wiki-server.
// Issue #4017 — ensure the command goes through storeSourceCheckEvidence
// (which auto-resolves resourceId) instead of the raw storeEvidence RPC.
// ---------------------------------------------------------------------------

const mockStoreSourceCheckEvidence = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const mockStoreAggregateVerdict = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});

vi.mock('../lib/source-check/verdict-handler.ts', () => ({
  storeSourceCheckEvidence: (...args: unknown[]) => mockStoreSourceCheckEvidence(...args),
  storeAggregateVerdict: (...args: unknown[]) => mockStoreAggregateVerdict(...args),
}));

describe('crux fb source-check --dry-run', () => {
  it('lists facts to verify for a specific entity', async () => {
    const result = await sourceCheck([], {
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
    const result = await sourceCheck([], {
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
    const result = await sourceCheck([], {
      fact: 'f_dW5cR9mJ8q',
      'dry-run': true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('1 fact(s)');
    expect(result.output).toContain('Anthropic');
    expect(result.output).toContain('Revenue');
  });

  it('reports no facts when entity has none with sources', async () => {
    const result = await sourceCheck([], {
      entity: 'nonexistent-entity',
      'dry-run': true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No facts with source URLs');
  });

  it('reports no facts when fact ID does not exist', async () => {
    const result = await sourceCheck([], {
      fact: 'f_nonexistent',
      'dry-run': true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('not found or has no source URL');
  });

  it('respects --limit option', async () => {
    const result = await sourceCheck([], {
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
    const result = await sourceCheck([], {
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
    const result = await sourceCheck([], {
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
});

// ---------------------------------------------------------------------------
// storeSourceCheckResult — issue #4017
// ---------------------------------------------------------------------------

describe('storeSourceCheckResult (issue #4017)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreSourceCheckEvidence.mockImplementation(async () => {});
    mockStoreAggregateVerdict.mockImplementation(async () => {});
  });

  it('routes through storeSourceCheckEvidence with sourceUrl so resourceId can be auto-resolved', async () => {
    // Re-import after mocks are set up
    const { storeSourceCheckResult } = await import('./factbase-source-check.ts');

    await storeSourceCheckResult({
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

    expect(mockStoreSourceCheckEvidence).toHaveBeenCalledOnce();
    const args = mockStoreSourceCheckEvidence.mock.calls[0][0] as {
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
    const { storeSourceCheckResult } = await import('./factbase-source-check.ts');

    mockStoreSourceCheckEvidence.mockRejectedValueOnce(new Error('wiki-server down'));

    await expect(
      storeSourceCheckResult({
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
