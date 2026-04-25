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
  applyAuditContextValues,
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

describe("applyAuditContext / applyAuditContextValues", () => {
  /**
   * Drizzle's `sql` template tag produces an `SQL` object whose `.queryChunks`
   * alternate between `StringChunk { value: string[] }` (literal SQL) and the
   * raw JS values inlined by `${}`. Parameters are the non-StringChunk items.
   */
  function extractParams(query: unknown): unknown[] {
    if (typeof query !== "object" || query === null) return [];
    const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return [];
    const params: unknown[] = [];
    for (const chunk of chunks) {
      // StringChunk is an object literal `{ value: string[] }`; anything
      // else (string / number / etc.) is a parameter value.
      if (chunk && typeof chunk === "object" && "value" in (chunk as Record<string, unknown>)) {
        continue;
      }
      params.push(chunk);
    }
    return params;
  }

  function makeFakeTx() {
    const queries: unknown[] = [];
    const fakeTx = {
      execute: vi.fn(async (query: unknown) => {
        queries.push(query);
        return [] as unknown[];
      }),
    };
    return { fakeTx, queries };
  }

  it("applyAuditContext issues one SELECT with both parameters bound", async () => {
    const { fakeTx, queries } = makeFakeTx();
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
    expect(fakeTx.execute).toHaveBeenCalledTimes(1);
    const params = extractParams(queries[0]);
    expect(params).toContain("abc");
    expect(params).toContain("crux.audit");
  });

  it("applyAuditContext binds empty strings when headers are absent", async () => {
    const { fakeTx, queries } = makeFakeTx();
    const app = new Hono().use(auditContextMiddleware()).get("/x", async (c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await applyAuditContext(fakeTx as any, c);
      return c.json({ ok: true });
    });
    await app.request("/x");
    expect(fakeTx.execute).toHaveBeenCalledTimes(1);
    const params = extractParams(queries[0]);
    // Both bindings must be the empty string, not null/undefined — the
    // trigger function treats '' as NULL but set_config() rejects NULL.
    expect(params.filter((v) => v === "")).toHaveLength(2);
  });

  it("applyAuditContextValues binds the raw values provided", async () => {
    const { fakeTx, queries } = makeFakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyAuditContextValues(fakeTx as any, { sessionId: "99", tool: "batch" });
    expect(fakeTx.execute).toHaveBeenCalledTimes(1);
    const params = extractParams(queries[0]);
    expect(params).toContain("99");
    expect(params).toContain("batch");
  });
});
