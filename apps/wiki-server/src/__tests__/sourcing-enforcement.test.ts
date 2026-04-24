import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { enforceSourcing } from '../routes/shared/sourcing-enforcement.js';

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
