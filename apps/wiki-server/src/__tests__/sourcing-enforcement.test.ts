import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  enforceSourcing,
  resolveSourcingRequirement,
} from '../routes/shared/sourcing-enforcement.js';
import type { Context } from 'hono';

// Helper to create a minimal Hono test context with a given table name
function createTestApp(tableName = 'personnel') {
  const app = new Hono();
  app.post('/test', async (c) => {
    const items = await c.req.json();
    const error = enforceSourcing(c, tableName, items);
    if (error) return error;
    return c.json({ ok: true });
  });
  return app;
}

function buildUrl(params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  return qs ? `/test?${qs}` : '/test';
}

function makeRequest(app: Hono, items: unknown[], params: Record<string, string> = {}) {
  return app.request(buildUrl(params), {
    method: 'POST',
    body: JSON.stringify(items),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('enforceSourcing', () => {
  // --- Tables without server-side enforcement ---
  it('allows records when no sourcing is required (unenforced table)', async () => {
    const app = createTestApp('investments'); // not in SOURCE_CHECK_REQUIRED
    const res = await makeRequest(app, [{ id: '1' }, { id: '2' }]);
    expect(res.status).toBe(200);
  });

  it('rejects unchecked records when client sends requireSourcing=true', async () => {
    const app = createTestApp('investments');
    const res = await makeRequest(
      app,
      [{ id: '1' }, { id: '2', sourcing: { verdict: 'confirmed' } }],
      { requireSourcing: 'true' },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('1/2 records lack sourcing');
  });

  it('allows fully checked records when requireSourcing=true', async () => {
    const app = createTestApp('investments');
    const res = await makeRequest(
      app,
      [
        { id: '1', sourcing: { verdict: 'confirmed' } },
        { id: '2', sourcing: { verdict: 'partial' } },
      ],
      { requireSourcing: 'true' },
    );
    expect(res.status).toBe(200);
  });

  // --- Server-side enforcement for personnel ---
  it('rejects unchecked personnel records via server policy', async () => {
    const app = createTestApp('personnel');
    const res = await makeRequest(app, [{ id: '1' }, { id: '2' }]);
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('server policy');
    expect(body.message).toContain('2/2 records lack sourcing');
  });

  it('allows fully checked personnel records', async () => {
    const app = createTestApp('personnel');
    const res = await makeRequest(app, [
      { id: '1', sourcing: { verdict: 'confirmed' } },
      { id: '2', sourcing: { verdict: 'partial' } },
    ]);
    expect(res.status).toBe(200);
  });

  // --- Server-side enforcement for grants ---
  it('rejects unchecked grants records via server policy', async () => {
    const app = createTestApp('grants');
    const res = await makeRequest(app, [{ id: '1' }]);
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('server policy');
  });

  it('allows fully checked grants records', async () => {
    const app = createTestApp('grants');
    const res = await makeRequest(app, [
      { id: '1', sourcing: { verdict: 'confirmed' } },
    ]);
    expect(res.status).toBe(200);
  });

  // --- Server-side enforcement for Phase 7 tables (QUA-248) ---
  it.each([
    'funding-rounds',
    'funding-programs',
    'divisions',
    'policy-stakeholders',
  ])('rejects unchecked %s records via server policy', async (table) => {
    const app = createTestApp(table);
    const res = await makeRequest(app, [{ id: '1' }]);
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('server policy');
    expect(body.message).toContain('1/1 records lack sourcing');
  });

  it.each([
    'funding-rounds',
    'funding-programs',
    'divisions',
    'policy-stakeholders',
  ])('allows fully checked %s records', async (table) => {
    const app = createTestApp(table);
    const res = await makeRequest(app, [
      { id: '1', sourcing: { verdict: 'confirmed' } },
    ]);
    expect(res.status).toBe(200);
  });

  // --- forceSkipSourcing escape hatch ---
  it('respects forceSkipSourcing escape hatch for server-enforced tables', async () => {
    const app = createTestApp('personnel');
    const res = await makeRequest(
      app,
      [{ id: '1' }], // no sourcing
      { forceSkipSourcing: 'true', reason: 'migration backfill' },
    );
    expect(res.status).toBe(200);
  });

  it('forceSkipSourcing works without a reason', async () => {
    const app = createTestApp('grants');
    const res = await makeRequest(
      app,
      [{ id: '1' }],
      { forceSkipSourcing: 'true' },
    );
    expect(res.status).toBe(200);
  });

  it('forceSkipSourcing works with client requireSourcing=true', async () => {
    const app = createTestApp('investments');
    const res = await makeRequest(
      app,
      [{ id: '1' }],
      { requireSourcing: 'true', forceSkipSourcing: 'true', reason: 'test' },
    );
    expect(res.status).toBe(200);
  });

  it('error message points at verify-orchestrate, not the single-entity verify', async () => {
    const app = createTestApp('grants');
    const res = await makeRequest(app, [{ id: '1' }]);
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('pnpm crux tb verify-orchestrate grants');
    expect(body.message).not.toMatch(/pnpm crux tb verify grants(?!-)/);
  });
});

describe('resolveSourcingRequirement', () => {
  // Build a Hono context with the given query string and pass it to the
  // function under test. Avoids spinning up an entire app for a pure
  // policy-decision helper.
  async function callWith(tableName: string, params: Record<string, string>) {
    const app = new Hono();
    let captured: ReturnType<typeof resolveSourcingRequirement> | null = null;
    app.get('/test', (c: Context) => {
      captured = resolveSourcingRequirement(c, tableName);
      return c.text('ok');
    });
    const url = `/test?${new URLSearchParams(params).toString()}`;
    await app.request(url);
    if (captured === null) throw new Error('handler did not run');
    return captured;
  }

  it('returns "not_required" for unenforced tables with no client opt-in', async () => {
    const result = await callWith('investments', {});
    expect(result).toEqual({ kind: 'not_required' });
  });

  it('returns "required" with server-policy source for SOURCE_CHECK_REQUIRED tables', async () => {
    const result = await callWith('personnel', {});
    expect(result).toEqual({ kind: 'required', source: 'server policy' });
  });

  it('returns "required" with client-param source when only the client opted in', async () => {
    const result = await callWith('investments', { requireSourcing: 'true' });
    expect(result).toEqual({
      kind: 'required',
      source: 'client requireSourcing param',
    });
  });

  it('returns "skipped" with reason when forceSkipSourcing=true', async () => {
    const result = await callWith('personnel', {
      forceSkipSourcing: 'true',
      reason: 'migration backfill',
    });
    expect(result).toEqual({ kind: 'skipped', reason: 'migration backfill' });
  });

  it('returns "skipped" with default reason when forceSkipSourcing=true&reason omitted', async () => {
    const result = await callWith('grants', { forceSkipSourcing: 'true' });
    expect(result).toEqual({ kind: 'skipped', reason: 'no reason given' });
  });

  it('forceSkipSourcing has no effect on tables that do not require sourcing', async () => {
    const result = await callWith('investments', { forceSkipSourcing: 'true' });
    expect(result).toEqual({ kind: 'not_required' });
  });
});
