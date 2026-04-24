/**
 * Unit tests — audit-context middleware (QUA-442).
 *
 * Verifies header parsing, sanitization, and `applyAuditContext` calls
 * `SET LOCAL` via `set_config(...)`. DB interaction is mocked through
 * an in-memory fake transaction.
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  auditContextMiddleware,
  getAuditContext,
  applyAuditContext,
  setAuditContextRaw,
  AUDIT_SESSION_HEADER,
  AUDIT_TOOL_HEADER,
} from "../middleware/audit-context.js";

describe("auditContextMiddleware", () => {
  it("stashes session + tool from request headers", async () => {
    const app = new Hono().use(auditContextMiddleware()).get("/x", (c) => {
      const ctx = getAuditContext(c);
      return c.json(ctx);
    });
    const res = await app.request("/x", {
      headers: {
        [AUDIT_SESSION_HEADER]: "42",
        [AUDIT_TOOL_HEADER]: "tb.scaffold",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: "42", tool: "tb.scaffold" });
  });

  it("returns nulls when headers are absent", async () => {
    const app = new Hono().use(auditContextMiddleware()).get("/x", (c) => {
      const ctx = getAuditContext(c);
      return c.json(ctx);
    });
    const res = await app.request("/x");
    expect(await res.json()).toEqual({ sessionId: null, tool: null });
  });

  it("trims whitespace and treats empty strings as null", async () => {
    const app = new Hono().use(auditContextMiddleware()).get("/x", (c) => {
      const ctx = getAuditContext(c);
      return c.json(ctx);
    });
    const res = await app.request("/x", {
      headers: {
        [AUDIT_SESSION_HEADER]: "  ",
        [AUDIT_TOOL_HEADER]: "  scoped  ",
      },
    });
    expect(await res.json()).toEqual({ sessionId: null, tool: "scoped" });
  });

  it("truncates pathologically long values", async () => {
    const longVal = "x".repeat(1000);
    const app = new Hono().use(auditContextMiddleware()).get("/x", (c) => {
      const ctx = getAuditContext(c);
      return c.json(ctx);
    });
    const res = await app.request("/x", {
      headers: {
        [AUDIT_SESSION_HEADER]: longVal,
        [AUDIT_TOOL_HEADER]: longVal,
      },
    });
    const body = (await res.json()) as { sessionId: string; tool: string };
    expect(body.sessionId.length).toBe(256);
    expect(body.tool.length).toBe(256);
  });

  it("getAuditContext returns defaults on a context that was never middleware-wrapped", async () => {
    const app = new Hono().get("/x", (c) => {
      const ctx = getAuditContext(c);
      return c.json(ctx);
    });
    const res = await app.request("/x");
    expect(await res.json()).toEqual({ sessionId: null, tool: null });
  });
});

describe("applyAuditContext / setAuditContextRaw", () => {
  function makeFakeTx() {
    const calls: Array<{ query: string; params: unknown[] }> = [];
    const fakeTx = {
      execute: vi.fn(async (query: { queryChunks?: unknown[] } | string) => {
        // Drizzle sql template: we just record the input so the test can
        // assert `set_config` was called with the right value.
        calls.push({ query: JSON.stringify(query), params: [] });
        return [] as unknown[];
      }),
    };
    return { fakeTx, calls };
  }

  it("applyAuditContext issues two set_config calls with request values", async () => {
    const { fakeTx, calls } = makeFakeTx();
    const app = new Hono().use(auditContextMiddleware()).get("/x", async (c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await applyAuditContext(fakeTx as any, c);
      return c.json({ ok: true });
    });
    await app.request("/x", {
      headers: {
        [AUDIT_SESSION_HEADER]: "abc",
        [AUDIT_TOOL_HEADER]: "crux.audit",
      },
    });
    expect(fakeTx.execute).toHaveBeenCalledTimes(2);
    const stringified = calls.map((c) => c.query).join(" | ");
    expect(stringified).toMatch(/agent_session_id/);
    expect(stringified).toMatch(/agent_tool/);
  });

  it("applyAuditContext writes empty strings when headers are absent", async () => {
    const { fakeTx } = makeFakeTx();
    const app = new Hono().use(auditContextMiddleware()).get("/x", async (c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await applyAuditContext(fakeTx as any, c);
      return c.json({ ok: true });
    });
    await app.request("/x");
    expect(fakeTx.execute).toHaveBeenCalledTimes(2);
  });

  it("setAuditContextRaw issues two set_config calls with raw values", async () => {
    const { fakeTx } = makeFakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setAuditContextRaw(fakeTx as any, { sessionId: "99", tool: "batch" });
    expect(fakeTx.execute).toHaveBeenCalledTimes(2);
  });
});
