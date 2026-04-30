/**
 * Tests for sourcing item collection — specifically the name-resolution
 * skip guards that prevent unverifiable records from being sent to the LLM.
 *
 * The LLM can't verify "sid_aAFe7DRvPv is a researcher at Anthropic" against
 * a source page, so records where ANY key name is an unresolvable stableId
 * should be skipped.
 *
 * Regression tests for the guard change from `&&` to `||`:
 * - Before: skipped only when BOTH names were unresolvable
 * - After: skips when EITHER name is unresolvable
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────

// Mock wiki-server API calls
vi.mock('../wiki-server/client.ts', () => ({
  apiRequest: vi.fn(),
}));

vi.mock('../wiki-server/sourcing-client.ts', () => ({
  listVerdicts: vi.fn().mockResolvedValue({
    ok: true,
    data: { verdicts: [], total: 0 },
  }),
}));

import { apiRequest } from '../wiki-server/client.ts';
const mockApiRequest = vi.mocked(apiRequest);

import { collectRecordItems } from './item-collectors.ts';

// Helper to build a mock API response for a specific record type
function mockPersonnelResponse(records: Record<string, unknown>[]) {
  return {
    ok: true as const,
    data: {
      personnel: records,
      total: records.length,
    },
  };
}

function mockInvestmentResponse(records: Record<string, unknown>[]) {
  return {
    ok: true as const,
    data: {
      investments: records,
      total: records.length,
    },
  };
}

function mockFundingRoundResponse(records: Record<string, unknown>[]) {
  return {
    ok: true as const,
    data: {
      rounds: records,
      total: records.length,
    },
  };
}

function mockBenchmarkResultResponse(records: Record<string, unknown>[]) {
  return {
    ok: true as const,
    data: {
      benchmarkResults: records,
      total: records.length,
    },
  };
}

function mockEmptyResponse() {
  return {
    ok: true as const,
    data: { items: [], total: 0 },
  };
}

beforeEach(() => {
  mockApiRequest.mockReset();
});

// ── Personnel name resolution guard ────────────────────────────────

describe('personnel name resolution guard', () => {
  function setupPersonnelMock(records: Record<string, unknown>[]) {
    mockApiRequest.mockImplementation(async (_method: unknown, path: unknown) => {
      const pathStr = String(path);
      if (pathStr.startsWith('/api/personnel/all')) return mockPersonnelResponse(records);
      return mockEmptyResponse();
    });
  }

  it('includes records where both person and org names are resolvable', async () => {
    setupPersonnelMock([{
      id: 'p-1',
      personResolvedName: 'Jane Smith',
      orgResolvedName: 'Anthropic',
      role: 'Researcher',
      source: 'https://example.com/team',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'personnel');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('record:personnel:p-1');
  });

  it('skips records where person name is an unresolvable stableId', async () => {
    setupPersonnelMock([{
      id: 'p-2',
      personResolvedName: 'sid_fVMqY7vpMA',
      orgResolvedName: 'Anthropic',
      role: 'Researcher',
      source: 'https://example.com/team',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'personnel');
    expect(items).toHaveLength(0);
  });

  it('skips records where org name is an unresolvable stableId', async () => {
    setupPersonnelMock([{
      id: 'p-3',
      personResolvedName: 'Jane Smith',
      orgResolvedName: 'sid_abc1234567',
      role: 'Researcher',
      source: 'https://example.com/team',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'personnel');
    expect(items).toHaveLength(0);
  });

  it('skips records where both names are unresolvable', async () => {
    setupPersonnelMock([{
      id: 'p-4',
      personResolvedName: 'fVMqY7vpMA',
      orgResolvedName: 'sid_abc1234567',
      role: 'Researcher',
      source: 'https://example.com/team',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'personnel');
    expect(items).toHaveLength(0);
  });

  it('skips records where person name resolves to (unknown)', async () => {
    setupPersonnelMock([{
      id: 'p-5',
      personId: 'fVMqY7vpMA',
      orgResolvedName: 'Anthropic',
      role: 'Researcher',
      source: 'https://example.com/team',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'personnel');
    expect(items).toHaveLength(0);
  });

  it('filters correctly with mixed resolvable and unresolvable records', async () => {
    setupPersonnelMock([
      {
        id: 'p-good',
        personResolvedName: 'Jane Smith',
        orgResolvedName: 'Anthropic',
        role: 'Researcher',
        source: 'https://example.com/team',
      },
      {
        id: 'p-bad-person',
        personResolvedName: 'sid_fVMqY7vpMA',
        orgResolvedName: 'Anthropic',
        role: 'Engineer',
        source: 'https://example.com/team',
      },
      {
        id: 'p-bad-org',
        personResolvedName: 'Bob Jones',
        orgResolvedName: 'NPPTvNqRXA',
        role: 'CEO',
        source: 'https://example.com/team',
      },
    ]);

    const items = await collectRecordItems(new Map(), undefined, 'personnel');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('record:personnel:p-good');
  });
});

// ── Investment name resolution guard ────────────────────────────────

describe('investment name resolution guard', () => {
  function setupInvestmentMock(records: Record<string, unknown>[]) {
    mockApiRequest.mockImplementation(async (_method: unknown, path: unknown) => {
      const pathStr = String(path);
      if (pathStr.startsWith('/api/investments/all')) return mockInvestmentResponse(records);
      return mockEmptyResponse();
    });
  }

  it('includes records where both investor and company names are resolvable', async () => {
    setupInvestmentMock([{
      id: 'inv-1',
      investorResolvedName: 'Sequoia Capital',
      companyResolvedName: 'Anthropic',
      source: 'https://example.com/deals',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'investment');
    expect(items).toHaveLength(1);
  });

  it('skips records where investor name is unresolvable', async () => {
    setupInvestmentMock([{
      id: 'inv-2',
      investorResolvedName: 'sid_fVMqY7vpMA',
      companyResolvedName: 'Anthropic',
      source: 'https://example.com/deals',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'investment');
    expect(items).toHaveLength(0);
  });

  it('skips records where company name is unresolvable', async () => {
    setupInvestmentMock([{
      id: 'inv-3',
      investorResolvedName: 'Sequoia Capital',
      companyResolvedName: 'NPPTvNqRXA',
      source: 'https://example.com/deals',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'investment');
    expect(items).toHaveLength(0);
  });
});

// ── Funding round name resolution guard ──────────────────────────────

describe('funding-round name resolution guard', () => {
  function setupFundingRoundMock(records: Record<string, unknown>[]) {
    mockApiRequest.mockImplementation(async (_method: unknown, path: unknown) => {
      const pathStr = String(path);
      if (pathStr.startsWith('/api/funding-rounds/all')) return mockFundingRoundResponse(records);
      return mockEmptyResponse();
    });
  }

  it('includes records where company name is resolvable', async () => {
    setupFundingRoundMock([{
      id: 'fr-1',
      companyResolvedName: 'Anthropic',
      source: 'https://example.com/rounds',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'funding-round');
    expect(items).toHaveLength(1);
  });

  it('skips records where company name is unresolvable', async () => {
    setupFundingRoundMock([{
      id: 'fr-2',
      companyId: 'sid_fVMqY7vpMA',
      source: 'https://example.com/rounds',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'funding-round');
    expect(items).toHaveLength(0);
  });
});

// ── Benchmark result name resolution guard ───────────────────────────
// Note: benchmark-result is now a SOURCE_CHECK_EXEMPT_TYPE (data ingested from
// benchmark provider APIs). The exempt filter runs before name resolution, so
// these tests verify that exempt types produce no items regardless of name quality.

describe('benchmark-result name resolution guard', () => {
  function setupBenchmarkMock(records: Record<string, unknown>[]) {
    mockApiRequest.mockImplementation(async (_method: unknown, path: unknown) => {
      const pathStr = String(path);
      if (pathStr.startsWith('/api/benchmark-results/all')) return mockBenchmarkResultResponse(records);
      return mockEmptyResponse();
    });
  }

  it('skips benchmark-result entirely because it is an exempt type', async () => {
    setupBenchmarkMock([{
      id: 'br-1',
      modelResolvedName: 'GPT-4',
      sourceUrl: 'https://example.com/benchmarks',
    }]);

    // benchmark-result is exempt from sourcing verification — no items should be collected
    const items = await collectRecordItems(new Map(), undefined, 'benchmark-result');
    expect(items).toHaveLength(0);
  });

  it('skips records where model name is unresolvable (also exempt)', async () => {
    setupBenchmarkMock([{
      id: 'br-2',
      modelId: 'NPPTvNqRXA',
      sourceUrl: 'https://example.com/benchmarks',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'benchmark-result');
    expect(items).toHaveLength(0);
  });
});

// ── scorecard_grade collection (QUA-864) ────────────────────────────

describe('scorecard_grade collection', () => {
  function mockScorecardGradesResponse(rows: Record<string, unknown>[]) {
    return {
      ok: true as const,
      data: {
        items: rows,
        total: rows.length,
        limit: 200,
        offset: 0,
      },
    };
  }

  function setupScorecardGradesMock(rows: Record<string, unknown>[]) {
    mockApiRequest.mockImplementation(async (_method: unknown, path: unknown) => {
      const pathStr = String(path);
      if (pathStr.startsWith('/api/scorecard-grades/all')) {
        return mockScorecardGradesResponse(rows);
      }
      return mockEmptyResponse();
    });
  }

  it('queries /api/scorecard-grades/all when filtered to scorecard_grade', async () => {
    setupScorecardGradesMock([]);
    await collectRecordItems(new Map(), undefined, 'scorecard_grade');
    const calls = mockApiRequest.mock.calls.filter(([, p]) =>
      String(p).startsWith('/api/scorecard-grades/all'),
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  it('uses the per-grade sourceUrl when present', async () => {
    setupScorecardGradesMock([{
      id: 'fli-summer-2025__sid_anthropic__overall',
      entityId: 'sid_anthropic',
      entityTitle: 'Anthropic',
      entityDisplayName: 'Anthropic',
      scorecardSource: 'fli_index',
      publishedAt: '2025-06-15T00:00:00.000Z',
      dimensionSlug: 'overall',
      dimensionLabel: 'Overall',
      scoreLetter: 'C',
      scoreRaw: 'C',
      scoreNumeric: 60,
      sourceUrl: 'https://example.com/fli/summer-2025#anthropic-overall',
      snapshotSourceUrl: 'https://example.com/fli/summer-2025',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'scorecard_grade');
    expect(items).toHaveLength(1);

    const item = items[0];
    expect(item.id).toBe('record:scorecard_grade:fli-summer-2025__sid_anthropic__overall');
    expect(item.sourceUrl).toBe('https://example.com/fli/summer-2025#anthropic-overall');
    expect(item.entityType).toBe('scorecard_grade');

    if (item.data.kind !== 'record') return;
    expect(item.data.recordType).toBe('scorecard_grade');
    expect(item.data.entityId).toBe('sid_anthropic');
    expect(item.data.entityDisplayName).toBe('Anthropic');
    expect(item.data.fields).toMatchObject({
      publisher: 'fli_index',
      entity: 'Anthropic',
      dimension: 'Overall',
      scoreLetter: 'C',
    });
  });

  it('falls back to snapshotSourceUrl when the grade has no per-row sourceUrl', async () => {
    setupScorecardGradesMock([{
      id: 'fli-summer-2025__sid_anthropic__overall',
      entityId: 'sid_anthropic',
      entityTitle: 'Anthropic',
      scorecardSource: 'fli_index',
      dimensionSlug: 'overall',
      scoreLetter: 'C',
      sourceUrl: null,
      snapshotSourceUrl: 'https://example.com/fli/summer-2025',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'scorecard_grade');
    expect(items).toHaveLength(1);
    expect(items[0].sourceUrl).toBe('https://example.com/fli/summer-2025');
  });

  it('skips rows with neither sourceUrl nor snapshotSourceUrl', async () => {
    setupScorecardGradesMock([{
      id: 'fli-summer-2025__sid_x__overall',
      entityId: 'sid_x',
      entityTitle: 'Some Org',
      scorecardSource: 'fli_index',
      dimensionSlug: 'overall',
      sourceUrl: null,
      snapshotSourceUrl: null,
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'scorecard_grade');
    expect(items).toHaveLength(0);
  });

  it('skips rows where the entity name is unresolvable (LLM cannot verify "X scored sid_abc on Y")', async () => {
    setupScorecardGradesMock([{
      id: 'fli-summer-2025__sid_unknown__overall',
      entityId: 'sid_unknown',
      entityTitle: null,
      entityDisplayName: 'sid_unknown',
      scorecardSource: 'fli_index',
      dimensionSlug: 'overall',
      scoreLetter: 'C',
      sourceUrl: 'https://example.com/fli/summer-2025#unknown',
      snapshotSourceUrl: 'https://example.com/fli/summer-2025',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'scorecard_grade');
    expect(items).toHaveLength(0);
  });

  it('rolls up verdicts under the scored entityId so org rollups include scorecards', async () => {
    setupScorecardGradesMock([{
      id: 'g1',
      entityId: 'sid_anthropic',
      entityTitle: 'Anthropic',
      scorecardSource: 'fli_index',
      dimensionSlug: 'overall',
      scoreLetter: 'C',
      sourceUrl: 'https://example.com/x',
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'scorecard_grade');
    expect(items).toHaveLength(1);
    if (items[0].data.kind !== 'record') return;
    expect(items[0].data.entityId).toBe('sid_anthropic');
  });
});

// ── Exempt type filtering ────────────────────────────────────────────

describe('exempt type filtering', () => {
  it('skips all exempt types when scanning without table filter', async () => {
    // Mock all API endpoints to return empty arrays
    mockApiRequest.mockResolvedValue(mockEmptyResponse());

    const items = await collectRecordItems(new Map());
    // The function should not call APIs for exempt types, so no items.
    // This test primarily verifies the function doesn't crash when
    // exempt types are filtered out.
    expect(items).toEqual([]);
  });
});

// ── AI model collection (QUA-685) ───────────────────────────────────

describe('ai-model collection', () => {
  function mockAiModelEntitiesResponse(rows: Record<string, unknown>[]) {
    return {
      ok: true as const,
      data: {
        entities: rows,
        total: rows.length,
        returned: rows.length,
      },
    };
  }

  function setupAiModelMock(rows: Record<string, unknown>[]) {
    mockApiRequest.mockImplementation(async (_method: unknown, path: unknown) => {
      const pathStr = String(path);
      // Match /api/entities/export?entityType=ai-model... — the endpoint we
      // wired into collectRecordItems for ai-model.
      if (pathStr.startsWith('/api/entities/export') && pathStr.includes('entityType=ai-model')) {
        return mockAiModelEntitiesResponse(rows);
      }
      return mockEmptyResponse();
    });
  }

  it('queries /api/entities/export?entityType=ai-model when filtered to ai-model', async () => {
    setupAiModelMock([]);
    await collectRecordItems(new Map(), undefined, 'ai-model');
    const calls = mockApiRequest.mock.calls.filter(([, p]) =>
      String(p).startsWith('/api/entities/export') && String(p).includes('entityType=ai-model'),
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  it('flattens metadata fields and uses metadata.source as the source URL', async () => {
    setupAiModelMock([{
      id: 'claude-2',
      stableId: 'sid_R3iYKUUe2g',
      title: 'Claude 2',
      entityType: 'ai-model',
      metadata: {
        developer: 'anthropic',
        releaseDate: '2023-07-11',
        inputPrice: 8,
        outputPrice: 24,
        contextWindow: 100000,
        safetyLevel: 'ASL-2',
        source: 'https://www.anthropic.com/news/claude-2',
      },
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'ai-model');
    expect(items).toHaveLength(1);

    const item = items[0];
    expect(item.id).toBe('record:ai-model:claude-2');
    expect(item.kind).toBe('record');
    expect(item.entityType).toBe('ai-model');
    expect(item.sourceUrl).toBe('https://www.anthropic.com/news/claude-2');

    expect(item.data.kind).toBe('record');
    if (item.data.kind !== 'record') return;
    expect(item.data.recordType).toBe('ai-model');
    expect(item.data.recordId).toBe('claude-2');
    // QUA-685: rollup keys off the model's own stableId so each ai-model row
    // gets its own dot on the Products & Models table.
    expect(item.data.entityId).toBe('sid_R3iYKUUe2g');
    expect(item.data.entityDisplayName).toBe('Claude 2');

    // The five sourceable scalar fields are extracted into data.fields.
    expect(item.data.fields).toMatchObject({
      title: 'Claude 2',
      developer: 'anthropic',
      releaseDate: '2023-07-11',
      inputPrice: 8,
      outputPrice: 24,
      contextWindow: 100000,
      safetyLevel: 'ASL-2',
    });
  });

  it('skips ai-model rows without a source URL', async () => {
    setupAiModelMock([
      {
        id: 'claude-2',
        stableId: 'sid_R3iYKUUe2g',
        title: 'Claude 2',
        metadata: {
          developer: 'anthropic',
          source: 'https://www.anthropic.com/news/claude-2',
        },
      },
      {
        // No `source` in metadata — must be skipped to avoid a "No source URL" error.
        id: 'claude-no-source',
        stableId: 'sid_xyz',
        title: 'Claude No-Source',
        metadata: { developer: 'anthropic' },
      },
    ]);

    const items = await collectRecordItems(new Map(), undefined, 'ai-model');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('record:ai-model:claude-2');
  });

  it('handles missing metadata gracefully (no crash, just skipped for lack of source)', async () => {
    setupAiModelMock([{
      id: 'no-metadata-model',
      stableId: 'sid_xyz',
      title: 'No-metadata Model',
      // metadata omitted entirely
    }]);

    const items = await collectRecordItems(new Map(), undefined, 'ai-model');
    expect(items).toHaveLength(0);
  });
});
