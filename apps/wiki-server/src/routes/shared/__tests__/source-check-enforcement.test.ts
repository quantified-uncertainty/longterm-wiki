import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { enforceSourceCheck } from '../source-check-enforcement.js';

// Helper to create a minimal Hono test context with a given table name
function createTestApp(tableName = 'personnel') {
  const app = new Hono();
  app.post('/test', async (c) => {
    const items = await c.req.json();
    const error = enforceSourceCheck(c, tableName, items);
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

describe('enforceSourceCheck', () => {
  // --- Tables without server-side enforcement ---
  it('allows records when no source-check is required (unenforced table)', async () => {
    const app = createTestApp('investments'); // not in SOURCE_CHECK_REQUIRED
    const res = await makeRequest(app, [{ id: '1' }, { id: '2' }]);
    expect(res.status).toBe(200);
  });

  it('rejects unchecked records when client sends requireSourceCheck=true', async () => {
    const app = createTestApp('investments');
    const res = await makeRequest(
      app,
      [{ id: '1' }, { id: '2', sourcing: { verdict: 'confirmed' } }],
      { requireSourceCheck: 'true' },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('1/2 records lack source-check');
  });

  it('allows fully checked records when requireSourceCheck=true', async () => {
    const app = createTestApp('investments');
    const res = await makeRequest(
      app,
      [
        { id: '1', sourcing: { verdict: 'confirmed' } },
        { id: '2', sourcing: { verdict: 'partial' } },
      ],
      { requireSourceCheck: 'true' },
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
    expect(body.message).toContain('2/2 records lack source-check');
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

  // --- forceSkipSourceCheck escape hatch ---
  it('respects forceSkipSourceCheck escape hatch for server-enforced tables', async () => {
    const app = createTestApp('personnel');
    const res = await makeRequest(
      app,
      [{ id: '1' }], // no source-check
      { forceSkipSourceCheck: 'true', reason: 'migration backfill' },
    );
    expect(res.status).toBe(200);
  });

  it('forceSkipSourceCheck works without a reason', async () => {
    const app = createTestApp('grants');
    const res = await makeRequest(
      app,
      [{ id: '1' }],
      { forceSkipSourceCheck: 'true' },
    );
    expect(res.status).toBe(200);
  });

  it('forceSkipSourceCheck works with client requireSourceCheck=true', async () => {
    const app = createTestApp('investments');
    const res = await makeRequest(
      app,
      [{ id: '1' }],
      { requireSourceCheck: 'true', forceSkipSourceCheck: 'true', reason: 'test' },
    );
    expect(res.status).toBe(200);
  });

  it('error message includes table name and verify command', async () => {
    const app = createTestApp('grants');
    const res = await makeRequest(app, [{ id: '1' }]);
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('pnpm crux tb verify grants');
  });
});
