import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { enforceVerification } from '../verification-enforcement.js';

// Helper to create a minimal Hono test context with query params
function createTestApp(queryParams: Record<string, string> = {}) {
  const app = new Hono();
  app.post('/test', async (c) => {
    const items = await c.req.json();
    const error = enforceVerification(c, 'personnel', items);
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

describe('enforceVerification', () => {
  it('allows records when no verification is required', async () => {
    const app = createTestApp();
    const res = await makeRequest(app, [{ id: '1' }, { id: '2' }]);
    expect(res.status).toBe(200);
  });

  it('rejects unverified records when client sends requireVerification=true', async () => {
    const app = createTestApp();
    const res = await makeRequest(
      app,
      [{ id: '1' }, { id: '2', verification: { verdict: 'confirmed' } }],
      { requireVerification: 'true' },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('1/2 records lack verification');
  });

  it('allows fully verified records when requireVerification=true', async () => {
    const app = createTestApp();
    const res = await makeRequest(
      app,
      [
        { id: '1', verification: { verdict: 'confirmed' } },
        { id: '2', verification: { verdict: 'partial' } },
      ],
      { requireVerification: 'true' },
    );
    expect(res.status).toBe(200);
  });

  it('respects forceSkipVerification escape hatch', async () => {
    const app = createTestApp();
    const res = await makeRequest(
      app,
      [{ id: '1' }], // no verification
      { requireVerification: 'true', forceSkipVerification: 'true', reason: 'migration backfill' },
    );
    expect(res.status).toBe(200);
  });

  it('forceSkipVerification works without a reason', async () => {
    const app = createTestApp();
    const res = await makeRequest(
      app,
      [{ id: '1' }],
      { requireVerification: 'true', forceSkipVerification: 'true' },
    );
    expect(res.status).toBe(200);
  });

  it('error message includes table name', async () => {
    const app = new Hono();
    app.post('/test', async (c) => {
      const items = await c.req.json();
      const error = enforceVerification(c, 'grants', items);
      if (error) return error;
      return c.json({ ok: true });
    });
    const res = await makeRequest(app, [{ id: '1' }], { requireVerification: 'true' });
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('pnpm crux tb verify grants');
  });
});
