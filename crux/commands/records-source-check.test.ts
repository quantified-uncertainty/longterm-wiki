/**
 * Tests for the records source-check CLI command.
 *
 * Mocks `apiRequest()` since the command fetches data from wiki-server.
 * Tests dry-run mode, filtering by type, limit, CI JSON output, and error paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiResult } from '../lib/wiki-server/client.ts';

// ── Mock apiRequest before importing the command ─────────────────────

const mockApiRequest = vi.fn<
  (method: string, path: string, body?: unknown) => Promise<ApiResult<unknown>>
>();

vi.mock('../lib/wiki-server/client.ts', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...(args as [string, string, unknown?])),
  getBaseUrl: () => 'http://localhost:4100',
  buildHeaders: () => ({ 'Content-Type': 'application/json' }),
  apiOk: <T>(data: T) => ({ ok: true as const, data }),
  apiErr: <T>(error: string, message: string) => ({ ok: false as const, error, message }),
}));

import { recordsSourceCheckCommand, commands, getHelp } from './records-source-check.ts';

// ── Test data ────────────────────────────────────────────────────────

function makeGrant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant-001',
    name: 'Test Safety Grant',
    amount: 1000000,
    date: '2024-01-15',
    organizationId: 'open-philanthropy',
    granteeId: 'anthropic',
    source: 'https://example.com/grant-announcement',
    ...overrides,
  };
}

function makePersonnel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pers-001',
    personId: 'dario-amodei',
    organizationId: 'anthropic',
    role: 'CEO',
    roleType: 'executive',
    startDate: '2021-01-01',
    endDate: null,
    source: 'https://example.com/leadership',
    ...overrides,
  };
}

function makeDivision(overrides: Record<string, unknown> = {}) {
  return {
    id: 'div-001',
    name: 'Alignment Science',
    parentOrgId: 'anthropic',
    divisionType: 'research',
    status: 'active',
    lead: 'jan-leike',
    source: 'https://example.com/org-chart',
    ...overrides,
  };
}

function makeInvestment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-001',
    investorId: 'google',
    companyId: 'anthropic',
    amount: 2000000000,
    roundName: 'Series C',
    role: 'lead',
    source: 'https://example.com/funding-news',
    ...overrides,
  };
}

function makeFundingRound(overrides: Record<string, unknown> = {}) {
  return {
    id: 'round-001',
    name: 'Series C',
    companyId: 'anthropic',
    raised: 4000000000,
    valuation: 18000000000,
    date: '2023-12-01',
    source: 'https://example.com/round',
    ...overrides,
  };
}

function apiOk<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function apiError(message: string): ApiResult<never> {
  return { ok: false, error: 'server_error', message };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Set up mockApiRequest to respond with grants at the grants/all endpoint
 * and empty for everything else. Optionally provide records for other types.
 */
function setupMockApi(
  recordsByPath: Record<string, Record<string, unknown>[]> = {},
) {
  mockApiRequest.mockImplementation(async (_method, path) => {
    for (const [pathPattern, items] of Object.entries(recordsByPath)) {
      if (path.includes(pathPattern)) {
        // Determine response key from path
        if (path.includes('/grants')) return apiOk({ grants: items });
        if (path.includes('/personnel')) return apiOk({ personnel: items });
        if (path.includes('/divisions')) return apiOk({ divisions: items });
        if (path.includes('/funding-programs')) return apiOk({ programs: items });
        if (path.includes('/funding-rounds')) return apiOk({ rounds: items });
        if (path.includes('/investments')) return apiOk({ investments: items });
        if (path.includes('/equity-positions')) return apiOk({ positions: items });
        return apiOk({ items });
      }
    }
    // Default: return empty response for unmatched paths
    return apiOk({ items: [] });
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('records source-check --dry-run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists grant records to check with --type=grant --dry-run', async () => {
    setupMockApi({
      '/grants/': [makeGrant(), makeGrant({ id: 'grant-002', name: 'Second Grant' })],
    });

    const result = await recordsSourceCheckCommand([], {
      type: 'grant',
      'dry-run': true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Dry run');
    expect(result.output).toContain('2 record(s) would be verified');
    expect(result.output).toContain('grant');
    expect(result.output).toContain('Test Safety Grant');
  });

  it('lists personnel records with --type=personnel --dry-run', async () => {
    setupMockApi({
      '/personnel/': [makePersonnel()],
    });

    const result = await recordsSourceCheckCommand([], {
      type: 'personnel',
      'dry-run': true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Dry run');
    expect(result.output).toContain('1 record(s) would be verified');
    expect(result.output).toContain('personnel');
  });

  it('returns JSON in CI mode (--ci --dry-run)', async () => {
    const grant = makeGrant();
    setupMockApi({
      '/grants/': [grant],
    });

    const result = await recordsSourceCheckCommand([], {
      type: 'grant',
      'dry-run': true,
      ci: true,
    });

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0]).toHaveProperty('recordType', 'grant');
    expect(data[0]).toHaveProperty('recordId', 'grant-001');
    expect(data[0]).toHaveProperty('description');
    expect(data[0]).toHaveProperty('sourceUrl', 'https://example.com/grant-announcement');
    expect(data[0]).toHaveProperty('fields');
    expect(data[0].fields).toHaveProperty('name', 'Test Safety Grant');
    expect(data[0].fields).toHaveProperty('amount', 1000000);
  });

  it('respects --limit option', async () => {
    const grants = [
      makeGrant({ id: 'g1', name: 'Grant 1' }),
      makeGrant({ id: 'g2', name: 'Grant 2' }),
      makeGrant({ id: 'g3', name: 'Grant 3' }),
      makeGrant({ id: 'g4', name: 'Grant 4' }),
      makeGrant({ id: 'g5', name: 'Grant 5' }),
    ];
    setupMockApi({ '/grants/': grants });

    const result = await recordsSourceCheckCommand([], {
      type: 'grant',
      'dry-run': true,
      ci: true,
      limit: '2',
    });

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.length).toBe(2);
  });

  it('reports error for invalid record type via --type', async () => {
    const result = await recordsSourceCheckCommand([], {
      type: 'bogus-type',
      'dry-run': true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid record type: bogus-type');
    expect(result.output).toContain('Valid types:');
    expect(result.output).toContain('grant');
    expect(result.output).toContain('personnel');
  });

  it('reports error for unknown subcommand', async () => {
    const result = await recordsSourceCheckCommand(['nonexistent-cmd'], {});

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Unknown subcommand: nonexistent-cmd');
    expect(result.output).toContain('Usage:');
  });

  it('accepts plural subcommand form (grants → grant)', async () => {
    setupMockApi({
      '/grants/': [makeGrant()],
    });

    const result = await recordsSourceCheckCommand(['grants'], {
      'dry-run': true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Dry run');
    expect(result.output).toContain('grant');
  });

  it('skips records without source URLs', async () => {
    setupMockApi({
      '/grants/': [
        makeGrant({ id: 'g-with-source' }),
        makeGrant({ id: 'g-without-source', source: null }),
        makeGrant({ id: 'g-empty-source', source: '' }),
      ],
    });

    const result = await recordsSourceCheckCommand([], {
      type: 'grant',
      'dry-run': true,
      ci: true,
    });

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    // Only the grant with a source URL should be included
    expect(data.length).toBe(1);
    expect(data[0].recordId).toBe('g-with-source');
  });

  it('reports no records when API returns empty', async () => {
    setupMockApi({});

    const result = await recordsSourceCheckCommand([], {
      type: 'grant',
      'dry-run': true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No records with source URLs found');
  });

  it('handles API failure gracefully (returns no records)', async () => {
    mockApiRequest.mockResolvedValue(apiError('Server down'));

    const result = await recordsSourceCheckCommand([], {
      type: 'grant',
      'dry-run': true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No records with source URLs found');
  });

  it('passes entity filter to API path', async () => {
    setupMockApi({
      '/grants/': [makeGrant()],
    });

    await recordsSourceCheckCommand([], {
      type: 'grant',
      entity: 'anthropic',
      'dry-run': true,
    });

    // Check that apiRequest was called with the entity-specific path
    expect(mockApiRequest).toHaveBeenCalledWith(
      'GET',
      '/api/grants/by-entity/anthropic',
    );
  });

  it('dry-run shows type summary at bottom', async () => {
    setupMockApi({
      '/grants/': [makeGrant(), makeGrant({ id: 'g2' })],
    });

    const result = await recordsSourceCheckCommand([], {
      type: 'grant',
      'dry-run': true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('By type:');
    expect(result.output).toContain('grant: 2');
    expect(result.output).toContain('Use without --dry-run');
  });
});

describe('records source-check: record type routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds correct description for grant records', async () => {
    setupMockApi({
      '/grants/': [makeGrant()],
    });

    const result = await recordsSourceCheckCommand([], {
      type: 'grant',
      'dry-run': true,
      ci: true,
    });

    const data = JSON.parse(result.output);
    expect(data[0].description).toContain('Grant:');
    expect(data[0].description).toContain('Test Safety Grant');
    expect(data[0].description).toContain('open-philanthropy');
    expect(data[0].description).toContain('anthropic');
  });

  it('builds correct description for personnel records', async () => {
    setupMockApi({
      '/personnel/': [makePersonnel()],
    });

    const result = await recordsSourceCheckCommand([], {
      type: 'personnel',
      'dry-run': true,
      ci: true,
    });

    const data = JSON.parse(result.output);
    expect(data[0].description).toContain('Personnel:');
    expect(data[0].description).toContain('dario-amodei');
    expect(data[0].description).toContain('anthropic');
    expect(data[0].description).toContain('CEO');
  });

  it('builds correct description for division records', async () => {
    setupMockApi({
      '/divisions/': [makeDivision()],
    });

    const result = await recordsSourceCheckCommand([], {
      type: 'division',
      'dry-run': true,
      ci: true,
    });

    const data = JSON.parse(result.output);
    expect(data[0].description).toContain('Division:');
    expect(data[0].description).toContain('Alignment Science');
    expect(data[0].description).toContain('anthropic');
  });

  it('builds correct description for investment records', async () => {
    setupMockApi({
      '/investments/': [makeInvestment()],
    });

    const result = await recordsSourceCheckCommand([], {
      type: 'investment',
      'dry-run': true,
      ci: true,
    });

    const data = JSON.parse(result.output);
    expect(data[0].description).toContain('Investment:');
    expect(data[0].description).toContain('google');
    expect(data[0].description).toContain('anthropic');
  });

  it('builds correct description for funding-round records', async () => {
    setupMockApi({
      '/funding-rounds/': [makeFundingRound()],
    });

    const result = await recordsSourceCheckCommand([], {
      type: 'funding-round',
      'dry-run': true,
      ci: true,
    });

    const data = JSON.parse(result.output);
    expect(data[0].description).toContain('Funding Round:');
    expect(data[0].description).toContain('Series C');
    expect(data[0].description).toContain('anthropic');
  });

  it('uses entity-specific API path for personnel', async () => {
    setupMockApi({
      '/personnel/': [makePersonnel()],
    });

    await recordsSourceCheckCommand([], {
      type: 'personnel',
      entity: 'anthropic',
      'dry-run': true,
    });

    expect(mockApiRequest).toHaveBeenCalledWith(
      'GET',
      '/api/personnel/by-entity/anthropic',
    );
  });

  it('uses entity-specific API path for divisions', async () => {
    setupMockApi({
      '/divisions/': [makeDivision()],
    });

    await recordsSourceCheckCommand([], {
      type: 'division',
      entity: 'anthropic',
      'dry-run': true,
    });

    expect(mockApiRequest).toHaveBeenCalledWith(
      'GET',
      '/api/divisions/by-org/anthropic',
    );
  });

  it('uses /all path for types without entity-specific routes', async () => {
    setupMockApi({
      '/investments/': [makeInvestment()],
    });

    await recordsSourceCheckCommand([], {
      type: 'investment',
      entity: 'anthropic',
      'dry-run': true,
    });

    expect(mockApiRequest).toHaveBeenCalledWith(
      'GET',
      '/api/investments/all',
    );
  });
});

describe('records source-check: exports and help', () => {
  it('exports commands object with default handler', () => {
    expect(commands).toBeDefined();
    expect(commands.default).toBe(recordsSourceCheckCommand);
    expect(typeof commands.default).toBe('function');
  });

  it('exports stats command', () => {
    expect(commands.stats).toBeDefined();
    expect(typeof commands.stats).toBe('function');
  });

  it('getHelp() returns usage documentation', () => {
    const help = getHelp();
    expect(help).toContain('Record Source-Check');
    expect(help).toContain('crux tb source-check');
    expect(help).toContain('--dry-run');
    expect(help).toContain('--limit');
    expect(help).toContain('--entity');
    expect(help).toContain('--ci');
    expect(help).toContain('grants');
    expect(help).toContain('personnel');
    expect(help).toContain('divisions');
    expect(help).toContain('stats');
    expect(help).toContain('sync-things');
  });
});

describe('records source-check: all record types check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries all record types when no --type is specified', async () => {
    setupMockApi({});

    await recordsSourceCheckCommand([], {
      'dry-run': true,
    });

    // Should have made API calls for all 7 record types
    const paths = mockApiRequest.mock.calls.map((c) => c[1] as string);
    expect(paths).toContainEqual('/api/grants/all');
    expect(paths).toContainEqual('/api/personnel/all');
    expect(paths).toContainEqual('/api/divisions/all');
    expect(paths).toContainEqual('/api/funding-programs/all');
    expect(paths).toContainEqual('/api/funding-rounds/all');
    expect(paths).toContainEqual('/api/investments/all');
    expect(paths).toContainEqual('/api/equity-positions/all');
  });
});
