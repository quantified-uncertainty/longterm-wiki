/**
 * Tests for QUA-655: routing submit_records through `POST /api/enrichment/propose`.
 *
 * The handler under test is `submit_records` from `buildToolHandlers`. When
 * the caller passes `{ viaPropose: true }` and the record's table is in
 * `VIA_PROPOSE_TABLES` (grants only, Phase 1), each record is classified
 * T1 or skipped client-side, then POSTed to `/api/enrichment/propose`.
 *
 * We mock the underlying `apiRequest` transport and assert on path shapes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the wiki-server client before importing the module under test
vi.mock('../lib/wiki-server/client.ts', () => ({
  apiRequest: vi.fn(),
}));

import type { EnrichmentTask } from './types.ts';

const grantBackfillTask: EnrichmentTask = {
  id: 'grant-grantee-backfill:some-org',
  taskType: 'grant-grantee-backfill',
  entityId: 'ea-funds',
  entityName: 'EA Funds',
  entityType: 'organization',
  table: 'grants',
  impactScore: 10,
  reasons: [],
  existingRecordCount: 5,
};

/**
 * An EA Funds URL — on the T1 allowlist for grants.
 * (See apps/wiki-server/src/routes/enrichment/t1-allowlist.ts.)
 */
const T1_URL = 'https://funds.effectivealtruism.org/grants/some-grant';

/**
 * A random news URL — NOT on the T1 allowlist for grants.
 */
const NON_T1_URL = 'https://example.com/news/some-article';

describe('submit_records via /api/enrichment/propose', () => {
  let apiRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const client = await import('../lib/wiki-server/client.ts');
    apiRequest = vi.mocked(client.apiRequest);
    apiRequest.mockReset();
  });

  it('routes grants records with a T1 source URL through /propose', async () => {
    // Propose endpoint accepts the record
    apiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 'accepted',
        tier: 'T1',
        recordId: 'abc1234567',
        verdict: 'confirmed',
        confidence: 1.0,
        checkerModel: 't1-ea-funds',
        innerStatus: 200,
      },
    });

    const { buildToolHandlers } = await import('./tools.ts');
    const handlers = buildToolHandlers(grantBackfillTask, false, {
      skipSourcing: true,
      viaPropose: true,
    });

    const result = await handlers.submit_records({
      table: 'grants',
      records: [
        {
          id: 'abc1234567',
          organizationId: 'ea-funds',
          name: 'Test Grant',
          source: T1_URL,
          amount: 50000,
        },
      ],
    });

    expect(result).toContain('1/1 accepted');
    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [method, path, body] = apiRequest.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/api/enrichment/propose');
    // `organizationId` is normalized to a stableId by the existing
    // entity-matcher path before the record reaches /propose — just assert
    // that the row carries the id + name + source-url we set, with a
    // non-empty organizationId resolved in some form.
    expect(body).toMatchObject({
      tier: 'T1',
      recordType: 'grants',
      sourceUrl: T1_URL,
      row: expect.objectContaining({
        id: 'abc1234567',
        name: 'Test Grant',
      }),
    });
    const bodyTyped = body as { row: Record<string, unknown> };
    expect(typeof bodyTyped.row.organizationId).toBe('string');
    expect((bodyTyped.row.organizationId as string).length).toBeGreaterThan(0);
  });

  it('skips records whose source URL is not on the T1 allowlist', async () => {
    const { buildToolHandlers } = await import('./tools.ts');
    const handlers = buildToolHandlers(grantBackfillTask, false, {
      skipSourcing: true,
      viaPropose: true,
    });

    const result = await handlers.submit_records({
      table: 'grants',
      records: [
        {
          id: 'nont1aaaab',
          organizationId: 'ea-funds',
          name: 'Untrusted Grant',
          source: NON_T1_URL,
          amount: 25000,
        },
      ],
    });

    // The record should NOT trigger any /propose call — it's skipped client-side
    expect(apiRequest).not.toHaveBeenCalled();
    expect(result).toContain('0/1 accepted');
    expect(result).toContain('source not on T1 authority allowlist');
    expect(result).toContain('nont1aaaab');
  });

  it('reports a mix of accepted and skipped records', async () => {
    // First (T1) record accepted; second (non-T1) skipped before any network call
    apiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 'accepted',
        tier: 'T1',
        recordId: 't1aaaaaaaa',
        verdict: 'confirmed',
        confidence: 1.0,
        checkerModel: 't1-ea-funds',
        innerStatus: 200,
      },
    });

    const { buildToolHandlers } = await import('./tools.ts');
    const handlers = buildToolHandlers(grantBackfillTask, false, {
      skipSourcing: true,
      viaPropose: true,
    });

    const result = await handlers.submit_records({
      table: 'grants',
      records: [
        {
          id: 't1aaaaaaaa',
          organizationId: 'ea-funds',
          name: 'Authoritative Grant',
          source: T1_URL,
        },
        {
          id: 'nont1bbbbb',
          organizationId: 'ea-funds',
          name: 'Unverified Grant',
          source: NON_T1_URL,
        },
      ],
    });

    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(result).toContain('1/2 accepted');
    expect(result).toContain('1 record(s) skipped');
  });

  it('surfaces rejections from /propose verbatim', async () => {
    apiRequest.mockResolvedValueOnce({
      ok: false,
      error: 'bad_request',
      message: '400: sync/grants: id: Number must be exactly 10 characters',
    });

    const { buildToolHandlers } = await import('./tools.ts');
    const handlers = buildToolHandlers(grantBackfillTask, false, {
      skipSourcing: true,
      viaPropose: true,
    });

    const result = await handlers.submit_records({
      table: 'grants',
      records: [
        {
          id: 'bad-id', // Not 10 chars — downstream sync will reject
          organizationId: 'ea-funds',
          name: 'Malformed Grant',
          source: T1_URL,
        },
      ],
    });

    expect(result).toContain('0/1 accepted');
    expect(result).toContain('1 record(s) rejected');
    expect(result).toContain('bad_request');
    expect(result).toContain('Number must be exactly 10 characters');
  });

  it('does not route non-grants tables through /propose in Phase 1', async () => {
    // The personnel dedup read call — returns no existing rows so the record flows through
    apiRequest.mockImplementationOnce(async () => ({
      ok: true,
      data: { personnel: [] },
    }));
    // The direct personnel /sync call
    apiRequest.mockImplementationOnce(async () => ({
      ok: true,
      data: { upserted: 1 },
    }));

    const personnelTask: EnrichmentTask = {
      ...grantBackfillTask,
      taskType: 'personnel-enrichment',
      table: 'personnel',
    };

    const { buildToolHandlers } = await import('./tools.ts');
    const handlers = buildToolHandlers(personnelTask, false, {
      skipSourcing: true,
      viaPropose: true, // enabled, but personnel is not in VIA_PROPOSE_TABLES
    });

    const result = await handlers.submit_records({
      table: 'personnel',
      records: [
        {
          id: 'persabcdef',
          role: 'CEO',
          roleType: 'key-person',
          source: T1_URL,
        },
      ],
    });

    // Both calls go to the direct sync path — no /propose
    const paths = apiRequest.mock.calls.map((c) => c[1]);
    expect(paths.some((p: string) => p === '/api/enrichment/propose')).toBe(false);
    expect(paths.some((p: string) => p.startsWith('/api/personnel'))).toBe(true);
    expect(result).toContain('Successfully submitted');
  });

  it('strips the attached `sourcing` field before POSTing to /propose', async () => {
    // /propose owns verdict construction — a pre-attached sourcing blob would
    // collide with the server's own field and must be scrubbed client-side.
    apiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 'accepted',
        tier: 'T1',
        recordId: 'cleanaaaaa',
        verdict: 'confirmed',
        confidence: 1.0,
        checkerModel: 't1-ea-funds',
        innerStatus: 200,
      },
    });

    const { buildToolHandlers } = await import('./tools.ts');
    const handlers = buildToolHandlers(grantBackfillTask, false, {
      skipSourcing: true,
      viaPropose: true,
    });

    await handlers.submit_records({
      table: 'grants',
      records: [
        {
          id: 'cleanaaaaa',
          organizationId: 'ea-funds',
          name: 'Pre-Sourced Grant',
          source: T1_URL,
          // Simulate a sourcing blob that might have been attached earlier
          sourcing: { verdict: 'confirmed', confidence: 0.9, reasoning: 'stale' },
        },
      ],
    });

    const body = apiRequest.mock.calls[0][2] as Record<string, unknown>;
    expect(body.row).not.toHaveProperty('sourcing');
  });

  it('records without source URL are rejected before hitting /propose', async () => {
    const { buildToolHandlers } = await import('./tools.ts');
    const handlers = buildToolHandlers(grantBackfillTask, false, {
      skipSourcing: true,
      viaPropose: true,
    });

    const result = await handlers.submit_records({
      table: 'grants',
      records: [
        {
          id: 'nosrcaaaab',
          organizationId: 'ea-funds',
          name: 'Sourceless Grant',
        },
      ],
    });

    // Caller-side guard hits first — before the via-propose path
    expect(apiRequest).not.toHaveBeenCalled();
    expect(result).toContain('missing');
  });

  it('legacy path (viaPropose=false) still hits direct grants sync endpoint', async () => {
    // The direct grants sync (batch-update-grantee)
    apiRequest.mockResolvedValueOnce({
      ok: true,
      data: { updated: 1 },
    });

    const { buildToolHandlers } = await import('./tools.ts');
    const handlers = buildToolHandlers(grantBackfillTask, false, {
      skipSourcing: true,
      viaPropose: false,
    });

    const result = await handlers.submit_records({
      table: 'grants',
      records: [
        {
          id: 'legacyaaaa',
          organizationId: 'ea-funds',
          name: 'Legacy-Path Grant',
          source: T1_URL,
        },
      ],
    });

    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [, path] = apiRequest.mock.calls[0];
    expect(path).toMatch(/^\/api\/grants\/batch-update-grantee/);
    expect(path).not.toContain('/propose');
    expect(result).toContain('Successfully submitted');
  });
});
