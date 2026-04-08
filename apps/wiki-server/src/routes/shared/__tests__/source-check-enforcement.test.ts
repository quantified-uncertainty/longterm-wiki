import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { enforceSourceCheck } from '../source-check-enforcement.js';

// Helper to create a minimal Hono test context with query params
function createTestApp(queryParams: Record<string, string> = {}) {
  const app = new Hono();
  app.post('/test', async (c) => {
    const items = await c.req.json();
    const error = enforceSourceCheck(c, 'personnel', items);
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
  it('allows records when no source-check is required', async () => {
    const app = createTestApp();
    const res = await makeRequest(app, [{ id: '1' }, { id: '2' }]);
    expect(res.status).toBe(200);
  });

  it('rejects unchecked records when client sends requireSourceCheck=true', async () => {
    const app = createTestApp();
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
    const app = createTestApp();
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

  it('respects forceSkipSourceCheck escape hatch', async () => {
    const app = createTestApp();
    const res = await makeRequest(
      app,
      [{ id: '1' }], // no source-check
      { requireSourceCheck: 'true', forceSkipSourceCheck: 'true', reason: 'migration backfill' },
    );
    expect(res.status).toBe(200);
  });

  it('forceSkipSourceCheck works without a reason', async () => {
    const app = createTestApp();
    const res = await makeRequest(
      app,
      [{ id: '1' }],
      { requireSourceCheck: 'true', forceSkipSourceCheck: 'true' },
    );
    expect(res.status).toBe(200);
  });

  it('error message includes table name', async () => {
    const app = new Hono();
    app.post('/test', async (c) => {
      const items = await c.req.json();
      const error = enforceSourceCheck(c, 'grants', items);
      if (error) return error;
      return c.json({ ok: true });
    });
    const res = await makeRequest(app, [{ id: '1' }], { requireSourceCheck: 'true' });
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('pnpm crux tb verify grants');
  });
});
