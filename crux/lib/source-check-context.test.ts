import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSourceCheckContext } from './source-check-context.ts';

// Mock the wiki-server client
vi.mock('./wiki-server/client.ts', () => ({
  apiRequest: vi.fn(),
}));

// Mock loadDatabase
vi.mock('./content-types.ts', () => ({
  loadDatabase: vi.fn(() => ({
    typedEntities: [
      { id: 'anthropic', stableId: 'ent_abc123', wikiId: 'E22', title: 'Anthropic' },
      { id: 'miri', stableId: 'ent_def456', wikiId: 'E44', title: 'MIRI' },
    ],
  })),
}));

import { apiRequest } from './wiki-server/client.ts';
const mockApiRequest = vi.mocked(apiRequest);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildSourceCheckContext', () => {
  it('returns null when no actionable verdicts exist', async () => {
    mockApiRequest.mockResolvedValue({ ok: true, data: { verdicts: [], total: 0 } });

    const result = await buildSourceCheckContext('anthropic');
    expect(result).toBeNull();
  });

  it('returns formatted context for contradicted verdicts', async () => {
    mockApiRequest.mockImplementation(async (_method, path) => {
      if (typeof path === 'string' && path.includes('verdict=contradicted')) {
        return {
          ok: true as const,
          data: {
            verdicts: [
              {
                recordType: 'fact',
                recordId: 'f_revenue_2025',
                fieldName: null,
                entityId: 'ent_abc123',
                verdict: 'contradicted',
                confidence: 0.92,
                reasoning: 'Source says $9B revenue, page claims $4B',
                sourcesChecked: 2,
                needsRecheck: false,
                nextCheckDue: null,
                lastComputedAt: '2025-01-15T00:00:00Z',
                createdAt: '2025-01-15T00:00:00Z',
                updatedAt: '2025-01-15T00:00:00Z',
              },
            ],
            total: 1,
          },
        };
      }
      return { ok: true as const, data: { verdicts: [], total: 0 } };
    });

    const result = await buildSourceCheckContext('anthropic');
    expect(result).not.toBeNull();
    expect(result).toContain('CONTRADICTED (1)');
    expect(result).toContain('[contradicted]');
    expect(result).toContain('fact/f_revenue_2025');
    expect(result).toContain('Source says $9B revenue');
    expect(result).toContain('confidence: 92%');
  });

  it('returns formatted context for outdated verdicts', async () => {
    mockApiRequest.mockImplementation(async (_method, path) => {
      if (typeof path === 'string' && path.includes('verdict=outdated')) {
        return {
          ok: true as const,
          data: {
            verdicts: [
              {
                recordType: 'personnel',
                recordId: 'p_ceo_role',
                fieldName: 'headcount',
                entityId: 'ent_abc123',
                verdict: 'outdated',
                confidence: 0.85,
                reasoning: 'Headcount was 500, now 1,035 per Sep 2024 report',
                sourcesChecked: 1,
                needsRecheck: false,
                nextCheckDue: null,
                lastComputedAt: '2025-01-15T00:00:00Z',
                createdAt: '2025-01-15T00:00:00Z',
                updatedAt: '2025-01-15T00:00:00Z',
              },
            ],
            total: 1,
          },
        };
      }
      return { ok: true as const, data: { verdicts: [], total: 0 } };
    });

    const result = await buildSourceCheckContext('anthropic');
    expect(result).not.toBeNull();
    expect(result).toContain('OUTDATED (1)');
    expect(result).toContain('[outdated]');
    expect(result).toContain('[field: headcount]');
    expect(result).toContain('personnel/p_ceo_role');
  });

  it('includes both contradicted and outdated verdicts', async () => {
    mockApiRequest.mockImplementation(async (_method, path) => {
      if (typeof path === 'string' && path.includes('verdict=contradicted')) {
        return {
          ok: true as const,
          data: {
            verdicts: [
              {
                recordType: 'fact',
                recordId: 'f1',
                fieldName: null,
                entityId: 'ent_abc123',
                verdict: 'contradicted',
                confidence: 0.9,
                reasoning: 'Wrong value',
                sourcesChecked: 1,
                needsRecheck: false,
                nextCheckDue: null,
                lastComputedAt: null,
                createdAt: null,
                updatedAt: null,
              },
            ],
            total: 1,
          },
        };
      }
      if (typeof path === 'string' && path.includes('verdict=outdated')) {
        return {
          ok: true as const,
          data: {
            verdicts: [
              {
                recordType: 'fact',
                recordId: 'f2',
                fieldName: null,
                entityId: 'ent_abc123',
                verdict: 'outdated',
                confidence: 0.8,
                reasoning: 'Old data',
                sourcesChecked: 1,
                needsRecheck: false,
                nextCheckDue: null,
                lastComputedAt: null,
                createdAt: null,
                updatedAt: null,
              },
            ],
            total: 1,
          },
        };
      }
      return { ok: true as const, data: { verdicts: [], total: 0 } };
    });

    const result = await buildSourceCheckContext('anthropic');
    expect(result).not.toBeNull();
    expect(result).toContain('2 issues');
    expect(result).toContain('CONTRADICTED (1)');
    expect(result).toContain('OUTDATED (1)');
  });

  it('returns null when wiki-server is unavailable', async () => {
    mockApiRequest.mockResolvedValue({
      ok: false as const,
      error: 'unavailable' as const,
      message: 'LONGTERMWIKI_SERVER_URL not set',
    });

    const result = await buildSourceCheckContext('anthropic');
    expect(result).toBeNull();
  });

  it('returns null on unexpected errors without throwing', async () => {
    mockApiRequest.mockRejectedValue(new Error('network error'));

    const result = await buildSourceCheckContext('anthropic');
    expect(result).toBeNull();
  });

  it('deduplicates verdicts found under multiple entity IDs', async () => {
    // The same verdict returned under both slug and stableId queries
    const sharedVerdict = {
      recordType: 'fact',
      recordId: 'f_revenue',
      fieldName: null,
      entityId: 'ent_abc123',
      verdict: 'contradicted',
      confidence: 0.9,
      reasoning: 'Revenue mismatch',
      sourcesChecked: 1,
      needsRecheck: false,
      nextCheckDue: null,
      lastComputedAt: null,
      createdAt: null,
      updatedAt: null,
    };

    mockApiRequest.mockImplementation(async (_method, path) => {
      if (typeof path === 'string' && path.includes('verdict=contradicted')) {
        return {
          ok: true as const,
          data: { verdicts: [sharedVerdict], total: 1 },
        };
      }
      return { ok: true as const, data: { verdicts: [], total: 0 } };
    });

    const result = await buildSourceCheckContext('anthropic');
    expect(result).not.toBeNull();
    // Should have exactly 1 issue despite being returned for multiple entity ID queries
    expect(result).toContain('1 issue');
    // Count occurrences of the verdict — should appear only once
    const matches = result!.match(/fact\/f_revenue/g);
    expect(matches).toHaveLength(1);
  });

  it('queries both slug and stableId', async () => {
    mockApiRequest.mockResolvedValue({ ok: true, data: { verdicts: [], total: 0 } });

    await buildSourceCheckContext('anthropic');

    // Should have queried for both 'anthropic', 'ent_abc123', and 'E22'
    const calls = mockApiRequest.mock.calls.map(c => c[1]);
    const entityIdsQueried = calls.map(path =>
      typeof path === 'string' ? decodeURIComponent(path.match(/entity_id=([^&]+)/)?.[1] ?? '') : '',
    ).filter(Boolean);

    expect(entityIdsQueried).toContain('anthropic');
    expect(entityIdsQueried).toContain('ent_abc123');
    expect(entityIdsQueried).toContain('E22');
  });
});
