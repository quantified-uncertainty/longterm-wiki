/**
 * Tests for sourcing client functions.
 *
 * Mocks apiRequest to verify URL construction, parameter encoding,
 * and response handling for the new query endpoints.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the client module's apiRequest before importing sourcing
vi.mock('../client.ts', async () => {
  const actual = await vi.importActual<typeof import('../client.ts')>('../client.ts');
  return {
    ...actual,
    apiRequest: vi.fn(),
  };
});

import { apiRequest } from '../client.ts';
import {
  getVerdictsByEntity,
  getVerdictsByPage,
  getFailures,
  getStaleVerdicts,
  getVerdictsByType,
  getContradictedEntityIds,
} from '../sourcing.ts';

const mockApiRequest = vi.mocked(apiRequest);

beforeEach(() => {
  mockApiRequest.mockReset();
});

// ---------------------------------------------------------------------------
// getVerdictsByEntity
// ---------------------------------------------------------------------------

describe('getVerdictsByEntity', () => {
  it('constructs correct URL with entityId path param', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [], total: 0, counts: {} },
    });

    await getVerdictsByEntity('sid_abc123');

    expect(mockApiRequest).toHaveBeenCalledWith(
      'GET',
      '/api/sourcing/by-entity/sid_abc123',
    );
  });

  it('includes optional query params when provided', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [], total: 0, counts: {} },
    });

    await getVerdictsByEntity('sid_abc123', {
      limit: 10,
      offset: 20,
      verdict: 'contradicted',
    });

    const url = mockApiRequest.mock.calls[0][1];
    expect(url).toContain('/api/sourcing/by-entity/sid_abc123?');
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=20');
    expect(url).toContain('verdict=contradicted');
  });

  it('encodes entityId with special characters', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [], total: 0, counts: {} },
    });

    await getVerdictsByEntity('sid_with spaces/slash');

    const url = mockApiRequest.mock.calls[0][1];
    expect(url).toContain('sid_with%20spaces%2Fslash');
  });

  it('omits query string when no options are provided', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [], total: 0, counts: {} },
    });

    await getVerdictsByEntity('sid_abc123');

    const url = mockApiRequest.mock.calls[0][1];
    expect(url).toBe('/api/sourcing/by-entity/sid_abc123');
    expect(url).not.toContain('?');
  });
});

// ---------------------------------------------------------------------------
// getVerdictsByPage
// ---------------------------------------------------------------------------

describe('getVerdictsByPage', () => {
  it('constructs correct URL with page slug', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        verdicts: [],
        total: 0,
        counts: {},
        pageTitle: 'Anthropic',
        entityId: 'sid_abc',
      },
    });

    await getVerdictsByPage('anthropic');

    expect(mockApiRequest).toHaveBeenCalledWith(
      'GET',
      '/api/sourcing/by-page/anthropic',
    );
  });

  it('includes pagination params', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        verdicts: [],
        total: 0,
        counts: {},
        pageTitle: null,
        entityId: null,
      },
    });

    await getVerdictsByPage('openai', { limit: 25, offset: 50 });

    const url = mockApiRequest.mock.calls[0][1];
    expect(url).toContain('limit=25');
    expect(url).toContain('offset=50');
  });
});

// ---------------------------------------------------------------------------
// getFailures
// ---------------------------------------------------------------------------

describe('getFailures', () => {
  it('calls the failures endpoint with no params', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { items: [], total: 0, byErrorType: {} },
    });

    await getFailures();

    expect(mockApiRequest).toHaveBeenCalledWith(
      'GET',
      '/api/sourcing/failures',
    );
  });

  it('includes error_type filter', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { items: [], total: 0, byErrorType: {} },
    });

    await getFailures({ error_type: 'contradicted' });

    const url = mockApiRequest.mock.calls[0][1];
    expect(url).toContain('error_type=contradicted');
  });

  it('includes all filter params', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { items: [], total: 0, byErrorType: {} },
    });

    await getFailures({
      error_type: 'outdated',
      record_type: 'personnel',
      entity_id: 'sid_xyz',
      limit: 20,
      offset: 5,
    });

    const url = mockApiRequest.mock.calls[0][1];
    expect(url).toContain('error_type=outdated');
    expect(url).toContain('record_type=personnel');
    expect(url).toContain('entity_id=sid_xyz');
    expect(url).toContain('limit=20');
    expect(url).toContain('offset=5');
  });
});

// ---------------------------------------------------------------------------
// getStaleVerdicts
// ---------------------------------------------------------------------------

describe('getStaleVerdicts', () => {
  it('calls the stale endpoint with no params', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { items: [], total: 0, cutoffDate: '2025-01-01T00:00:00.000Z', days: 90 },
    });

    await getStaleVerdicts();

    expect(mockApiRequest).toHaveBeenCalledWith(
      'GET',
      '/api/sourcing/stale',
    );
  });

  it('includes days parameter', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { items: [], total: 0, cutoffDate: '2025-01-01T00:00:00.000Z', days: 30 },
    });

    await getStaleVerdicts({ days: 30 });

    const url = mockApiRequest.mock.calls[0][1];
    expect(url).toContain('days=30');
  });

  it('includes all optional params', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { items: [], total: 0, cutoffDate: '2025-01-01T00:00:00.000Z', days: 60 },
    });

    await getStaleVerdicts({
      days: 60,
      record_type: 'fact',
      entity_id: 'sid_test',
      limit: 100,
      offset: 10,
    });

    const url = mockApiRequest.mock.calls[0][1];
    expect(url).toContain('days=60');
    expect(url).toContain('record_type=fact');
    expect(url).toContain('entity_id=sid_test');
    expect(url).toContain('limit=100');
    expect(url).toContain('offset=10');
  });
});

// ---------------------------------------------------------------------------
// getVerdictsByType (existing function — verify it still works)
// ---------------------------------------------------------------------------

describe('getVerdictsByType', () => {
  it('constructs correct URL with verdict filter', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [], total: 0 },
    });

    await getVerdictsByType('contradicted');

    expect(mockApiRequest).toHaveBeenCalledWith(
      'GET',
      '/api/sourcing/verdicts?verdict=contradicted&limit=200',
    );
  });

  it('respects custom limit', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [], total: 0 },
    });

    await getVerdictsByType('confirmed', 50);

    expect(mockApiRequest).toHaveBeenCalledWith(
      'GET',
      '/api/sourcing/verdicts?verdict=confirmed&limit=50',
    );
  });
});

// ---------------------------------------------------------------------------
// getContradictedEntityIds (existing function — verify it still works)
// ---------------------------------------------------------------------------

describe('getContradictedEntityIds', () => {
  it('returns entity IDs from contradicted verdicts', async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        verdicts: [
          { entityId: 'sid_abc', verdict: 'contradicted' },
          { entityId: 'sid_def', verdict: 'contradicted' },
          { entityId: null, verdict: 'contradicted' },
        ],
        total: 3,
      },
    });

    const result = await getContradictedEntityIds();

    expect(result).toEqual(new Set(['sid_abc', 'sid_def']));
  });

  it('returns empty set when API is unavailable', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockApiRequest.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'not set',
    });

    const result = await getContradictedEntityIds();

    expect(result).toEqual(new Set());
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('warns when total exceeds fetched count', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        verdicts: [{ entityId: 'sid_abc', verdict: 'contradicted' }],
        total: 300,
      },
    });

    const result = await getContradictedEntityIds();

    expect(result).toEqual(new Set(['sid_abc']));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('1/300'),
    );

    consoleSpy.mockRestore();
  });
});
