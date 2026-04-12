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
    ok: true,
    data: {
      personnel: records,
      total: records.length,
    },
  };
}

function mockInvestmentResponse(records: Record<string, unknown>[]) {
  return {
    ok: true,
    data: {
      investments: records,
      total: records.length,
    },
  };
}

function mockFundingRoundResponse(records: Record<string, unknown>[]) {
  return {
    ok: true,
    data: {
      rounds: records,
      total: records.length,
    },
  };
}

function mockBenchmarkResultResponse(records: Record<string, unknown>[]) {
  return {
    ok: true,
    data: {
      benchmarkResults: records,
      total: records.length,
    },
  };
}

function mockEmptyResponse() {
  return {
    ok: true,
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
