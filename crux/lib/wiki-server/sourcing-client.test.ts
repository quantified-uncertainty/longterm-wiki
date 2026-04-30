import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evidenceRecordKey } from './sourcing-client.ts';

describe('evidenceRecordKey', () => {
  // Must match the server's implementation in
  // apps/wiki-server/src/routes/sourcing/sourcing.ts — if either copy
  // drifts from this format, callers of getEvidenceByRecords silently
  // get `undefined` on every lookup.
  it('joins recordType and recordId with a pipe delimiter', () => {
    expect(evidenceRecordKey('fact', 'F1')).toBe('fact|F1');
    expect(evidenceRecordKey('grant', 'g_abc123')).toBe('grant|g_abc123');
    expect(evidenceRecordKey('personnel', '42')).toBe('personnel|42');
  });

  it('produces distinct keys for distinct inputs', () => {
    expect(evidenceRecordKey('fact', 'F1')).not.toBe(
      evidenceRecordKey('grant', 'F1'),
    );
    expect(evidenceRecordKey('fact', 'F1')).not.toBe(
      evidenceRecordKey('fact', 'F2'),
    );
  });
});

// QUA-851: fetchVerdictRecordIds paginates through /api/sourcing/verdicts
// and returns the set of recordIds with row-level verdicts (fieldName == null).
// Mock at the HTTP boundary (`apiRequest` in client.ts) since fetchVerdictRecordIds
// calls listVerdicts via local module binding.
const mockApiRequest = vi.fn();

vi.mock('./client.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  };
});

describe('fetchVerdictRecordIds (QUA-851)', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
  });

  it('paginates and excludes per-field verdicts', async () => {
    const PAGE_SIZE = 200;
    const totalRows = 250;

    mockApiRequest.mockImplementation(async (_method: string, path: string) => {
      const url = new URL(path, 'http://x');
      const limit = Number(url.searchParams.get('limit') ?? PAGE_SIZE);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const remaining = Math.max(0, totalRows - offset);
      const pageCount = Math.min(limit, remaining);

      const verdicts = Array.from({ length: pageCount }, (_, i) => {
        const idx = offset + i;
        return {
          recordType: 'fact',
          recordId: `f_${idx.toString().padStart(10, '0')}`,
          // Mark every 5th row as field-level so we can confirm those are skipped.
          fieldName: idx % 5 === 0 ? 'value' : null,
          entityId: 'sid_x',
          displayName: 'Test',
          entityDisplayName: 'TestEntity',
          verdict: 'confirmed',
          confidence: 0.9,
          reasoning: 'r',
          sourcesChecked: 1,
          needsRecheck: false,
          nextCheckDue: null,
          lastComputedAt: '2026-04-29T00:00:00Z',
          createdAt: '2026-04-29T00:00:00Z',
          updatedAt: '2026-04-29T00:00:00Z',
        };
      });

      return { ok: true, data: { verdicts, total: totalRows } };
    });

    const { fetchVerdictRecordIds } = await import('./sourcing-client.ts');
    const res = await fetchVerdictRecordIds('fact');

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 250 total rows, 50 are field-level (every 5th: 0,5,...,245 → 50 rows), so 200 row-level
    expect(res.data.size).toBe(200);

    // Should have paginated: 200 rows on page 1, then 50 on page 2 (< PAGE_SIZE → stop)
    expect(mockApiRequest).toHaveBeenCalledTimes(2);
    const firstCall = mockApiRequest.mock.calls[0];
    expect(firstCall[0]).toBe('GET');
    expect(firstCall[1]).toContain('record_type=fact');
    expect(firstCall[1]).toContain('limit=200');
    expect(firstCall[1]).toContain('offset=0');
    const secondCall = mockApiRequest.mock.calls[1];
    expect(secondCall[1]).toContain('offset=200');
  });

  it('propagates listVerdicts errors', async () => {
    mockApiRequest.mockResolvedValue({
      ok: false,
      error: 'unavailable',
      message: 'wiki-server down',
    });

    const { fetchVerdictRecordIds } = await import('./sourcing-client.ts');
    const res = await fetchVerdictRecordIds('fact');

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('unavailable');
    expect(res.message).toBe('wiki-server down');
  });
});
