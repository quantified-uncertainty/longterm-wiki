import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory store simulating Postgres facts table ----

let factsStore: Map<string, Record<string, unknown>>;
let nextId: number;

function resetStores() {
  factsStore = new Map();
  nextId = 1;
}

function factKey(entityId: string, factId: string) {
  return `${entityId}::${factId}`;
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- facts: INSERT ... ON CONFLICT DO UPDATE (supports multi-row) ---
  if (q.includes("insert into") && q.includes('"facts"')) {
    const COLS = 15;
    const numRows = params.length / COLS;
    const rows: Record<string, unknown>[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const entityId = params[o] as string;
      const factIdVal = params[o + 1] as string;
      const key = factKey(entityId, factIdVal);
      const existing = factsStore.get(key);

      const row: Record<string, unknown> = {
        id: existing?.id ?? nextId++,
        entity_id: entityId,
        fact_id: factIdVal,
        label: params[o + 2],
        value: params[o + 3],
        numeric: params[o + 4],
        low: params[o + 5],
        high: params[o + 6],
        as_of: params[o + 7],
        measure: params[o + 8],
        subject: params[o + 9],
        note: params[o + 10],
        source: params[o + 11],
        source_resource: params[o + 12],
        format: params[o + 13],
        format_divisor: params[o + 14],
        synced_at: now,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      factsStore.set(key, row);
      rows.push(row);
    }
    return rows;
  }

  const hasEntityIdFilter = q.includes('entity_id" =');

  // --- STALE: SELECT (no entity_id filter, has is not null + order by) ---
  if (
    q.includes('"facts"') &&
    q.includes("is not null") &&
    q.includes("order by") &&
    !hasEntityIdFilter &&
    !q.includes("count(*)")
  ) {
    let results = Array.from(factsStore.values()).filter(
      (r) => r.as_of !== null
    );
    const dateParam = params.find((p) => typeof p === "string") as
      | string
      | undefined;
    if (dateParam) {
      results = results.filter((r) => String(r.as_of) <= dateParam);
    }
    results.sort((a, b) =>
      String(a.as_of || "").localeCompare(String(b.as_of || ""))
    );
    const limitIdx = params.findIndex((p) => typeof p === "number");
    const limit = limitIdx >= 0 ? (params[limitIdx] as number) : 50;
    const offsetIdx = limitIdx >= 0 ? limitIdx + 1 : -1;
    const offset =
      offsetIdx >= 0 && offsetIdx < params.length
        ? (params[offsetIdx] as number)
        : 0;
    // Return snake_case keys matching actual Postgres column names
    // (Drizzle's .values() extracts columns from SQL using snake_case)
    return results.slice(offset, offset + limit).map((r) => ({
      entity_id: r.entity_id,
      fact_id: r.fact_id,
      label: r.label,
      as_of: r.as_of,
      measure: r.measure,
      value: r.value,
      numeric: r.numeric,
    }));
  }

  // --- LIST: SELECT all facts (no WHERE clause) ---
  if (
    q.includes('"facts"') &&
    q.includes("order by") &&
    q.includes("limit") &&
    !q.includes("where") &&
    !q.includes("count(*)") &&
    !q.includes("count(distinct")
  ) {
    let results = Array.from(factsStore.values());
    results.sort((a, b) => {
      const cmp = String(a.entity_id || "").localeCompare(String(b.entity_id || ""));
      if (cmp !== 0) return cmp;
      return String(a.fact_id || "").localeCompare(String(b.fact_id || ""));
    });
    const limitIdx = params.findIndex((p) => typeof p === "number");
    const limit = limitIdx >= 0 ? (params[limitIdx] as number) : 100;
    const offsetIdx = limitIdx >= 0 ? limitIdx + 1 : -1;
    const offset =
      offsetIdx >= 0 && offsetIdx < params.length
        ? (params[offsetIdx] as number)
        : 0;
    return results.slice(offset, offset + limit);
  }

  // --- STALE COUNT ---
  if (
    q.includes("count(*)") &&
    q.includes('"facts"') &&
    q.includes("is not null") &&
    !hasEntityIdFilter
  ) {
    let results = Array.from(factsStore.values()).filter(
      (r) => r.as_of !== null
    );
    const dateParam = params.find((p) => typeof p === "string") as
      | string
      | undefined;
    if (dateParam) {
      results = results.filter((r) => String(r.as_of) <= dateParam);
    }
    return [{ count: results.length }];
  }

  // --- TIMESERIES: SELECT by entity_id + measure + as_of IS NOT NULL ---
  if (
    q.includes('"facts"') &&
    q.includes("where") &&
    q.includes("is not null") &&
    q.includes("order by")
  ) {
    const entityId = params[0] as string;
    let results = Array.from(factsStore.values()).filter(
      (r) => r.entity_id === entityId && r.as_of !== null
    );
    if (params.length > 1 && typeof params[1] === "string") {
      results = results.filter((r) => r.measure === params[1]);
    }
    results.sort((a, b) =>
      String(a.as_of || "").localeCompare(String(b.as_of || ""))
    );
    const limitIdx = params.findIndex(
      (p, idx) => idx > 0 && typeof p === "number"
    );
    const limit = limitIdx >= 0 ? (params[limitIdx] as number) : 100;
    return results.slice(0, limit);
  }

  // --- BY-ENTITY: SELECT by entity_id ---
  if (
    q.includes('"facts"') &&
    q.includes("where") &&
    q.includes("order by") &&
    q.includes("limit") &&
    !q.includes("count(*)")
  ) {
    const entityId = params[0] as string;
    let results = Array.from(factsStore.values()).filter(
      (r) => r.entity_id === entityId
    );
    if (params.length > 1 && typeof params[1] === "string") {
      results = results.filter((r) => r.measure === params[1]);
    }
    results.sort((a, b) =>
      String(a.fact_id || "").localeCompare(String(b.fact_id || ""))
    );
    const limitIdx = params.findIndex(
      (p, idx) => idx > 0 && typeof p === "number"
    );
    const limit = limitIdx >= 0 ? (params[limitIdx] as number) : 100;
    const offsetIdx = limitIdx >= 0 ? limitIdx + 1 : -1;
    const offset =
      offsetIdx >= 0 && offsetIdx < params.length
        ? (params[offsetIdx] as number)
        : 0;
    return results.slice(offset, offset + limit);
  }

  // --- COUNT with entity_id filter ---
  if (q.includes("count(*)") && q.includes('"facts"')) {
    if (q.includes("where")) {
      const entityId = params[0] as string;
      let count = 0;
      for (const row of factsStore.values()) {
        if (row.entity_id === entityId) {
          if (params.length > 1 && typeof params[1] === "string") {
            if (row.measure === params[1]) count++;
          } else {
            count++;
          }
        }
      }
      return [{ count }];
    }
    return [{ count: factsStore.size }];
  }

  // --- count(distinct entity_id) ---
  if (q.includes("count(distinct") && q.includes("entity_id")) {
    const unique = new Set<string>();
    for (const row of factsStore.values()) {
      unique.add(row.entity_id as string);
    }
    return [{ count: unique.size }];
  }

  // --- count(distinct measure) ---
  if (q.includes("count(distinct") && q.includes("measure")) {
    const unique = new Set<string>();
    for (const row of factsStore.values()) {
      if (row.measure) unique.add(row.measure as string);
    }
    return [{ count: unique.size }];
  }

  if (q.includes("count(*)") && !q.includes('"facts"')) {
    return [{ count: 0 }];
  }

  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: true }];
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Helpers ----

function seedFact(
  app: Hono,
  entityId: string,
  factId: string,
  opts: Record<string, unknown> = {}
) {
  return postJson(app, "/api/facts/sync", {
    facts: [
      {
        entityId,
        factId,
        label: opts.label ?? `Fact ${factId}`,
        value: opts.value ?? "100",
        numeric: opts.numeric ?? 100,
        asOf: opts.asOf ?? "2025-06",
        measure: opts.measure ?? "revenue",
        ...opts,
      },
    ],
  });
}

/**
 * Send an oRPC RPC-protocol request.
 * The oRPC RPC protocol wraps input in { json: <input>, meta: [] }
 * and returns output in { json: <output>, meta: [...] }.
 */
function rpcRequest(app: Hono, procedure: string, input: unknown) {
  return app.request(`/rpc/facts/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json: input, meta: [] }),
  });
}

/** Parse the oRPC RPC-protocol response to extract the output data. */
async function rpcJson(res: Response) {
  const envelope = await res.json();
  // oRPC wraps the output: { json: <data>, meta: [...] }
  return envelope.json !== undefined ? envelope.json : envelope;
}

// ---- oRPC Tests ----

describe("oRPC Facts endpoints (/rpc/facts/*)", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  describe("stats procedure", () => {
    it("returns fact statistics via oRPC", async () => {
      await seedFact(app, "anthropic", "abc", { measure: "valuation" });
      await seedFact(app, "openai", "def", { measure: "revenue" });

      const res = await rpcRequest(app, "stats", undefined);
      expect(res.status).toBe(200);

      const body = await rpcJson(res);
      expect(body.total).toBe(2);
      expect(body.uniqueEntities).toBe(2);
      expect(body.uniqueMeasures).toBe(2);
    });
  });

  describe("byEntity procedure", () => {
    it("returns facts for an entity via oRPC", async () => {
      await seedFact(app, "anthropic", "abc123", {
        label: "Valuation",
        measure: "valuation",
      });
      await seedFact(app, "anthropic", "def456", {
        label: "Revenue",
        measure: "revenue",
      });

      const res = await rpcRequest(app, "byEntity", {
        entityId: "anthropic",
      });

      expect(res.status).toBe(200);
      const body = await rpcJson(res);
      expect(body.entityId).toBe("anthropic");
      expect(body.facts).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("returns empty for unknown entity", async () => {
      const res = await rpcRequest(app, "byEntity", {
        entityId: "nonexistent",
      });

      expect(res.status).toBe(200);
      const body = await rpcJson(res);
      expect(body.facts).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  describe("timeseries procedure", () => {
    it("returns timeseries for a measure via oRPC", async () => {
      await seedFact(app, "anthropic", "rev-q1", {
        asOf: "2025-01",
        measure: "revenue",
        numeric: 1000000000,
      });
      await seedFact(app, "anthropic", "rev-q2", {
        asOf: "2025-06",
        measure: "revenue",
        numeric: 4000000000,
      });

      const res = await rpcRequest(app, "timeseries", {
        entityId: "anthropic",
        measure: "revenue",
      });

      expect(res.status).toBe(200);
      const body = await rpcJson(res);
      expect(body.entityId).toBe("anthropic");
      expect(body.measure).toBe("revenue");
      expect(body.points.length).toBeGreaterThan(0);
    });
  });

  describe("stale procedure", () => {
    it("returns stale facts via oRPC", async () => {
      await seedFact(app, "anthropic", "old-fact", {
        asOf: "2023-01",
        measure: "revenue",
      });
      await seedFact(app, "anthropic", "recent-fact", {
        asOf: "2025-12",
        measure: "revenue",
      });

      const res = await rpcRequest(app, "stale", { olderThan: "2024-01" });

      expect(res.status).toBe(200);
      const body = await rpcJson(res);
      expect(body.facts.length).toBeGreaterThan(0);
      expect(body.total).toBeGreaterThan(0);
    });
  });

  describe("list procedure", () => {
    it("returns all facts via oRPC", async () => {
      await seedFact(app, "anthropic", "abc", { measure: "valuation" });
      await seedFact(app, "openai", "def", { measure: "revenue" });

      const res = await rpcRequest(app, "list", {});
      expect(res.status).toBe(200);

      const body = await rpcJson(res);
      expect(body.facts).toHaveLength(2);
      expect(body.total).toBe(2);
    });
  });

  describe("sync procedure", () => {
    it("syncs facts via oRPC", async () => {
      const res = await rpcRequest(app, "sync", {
        facts: [
          {
            entityId: "anthropic",
            factId: "val-2024",
            label: "Valuation",
            value: "61000000000",
            numeric: 61000000000,
            asOf: "2024-03",
            measure: "valuation",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await rpcJson(res);
      expect(body.upserted).toBe(1);
    });
  });

  describe("parity: REST vs oRPC return same data", () => {
    it("stats returns same values via REST and oRPC", async () => {
      await seedFact(app, "anthropic", "abc", { measure: "valuation" });

      const restRes = await app.request("/api/facts/stats");
      const orpcRes = await rpcRequest(app, "stats", undefined);

      const restBody = await restRes.json();
      const orpcBody = await rpcJson(orpcRes);

      expect(restBody.total).toBe(orpcBody.total);
      expect(restBody.uniqueEntities).toBe(orpcBody.uniqueEntities);
      expect(restBody.uniqueMeasures).toBe(orpcBody.uniqueMeasures);
    });

    it("byEntity returns same data via REST and oRPC", async () => {
      await seedFact(app, "anthropic", "abc", { measure: "valuation" });

      const restRes = await app.request("/api/facts/by-entity/anthropic");
      const orpcRes = await rpcRequest(app, "byEntity", {
        entityId: "anthropic",
      });

      const restBody = await restRes.json();
      const orpcBody = await rpcJson(orpcRes);

      expect(restBody.total).toBe(orpcBody.total);
      expect(restBody.entityId).toBe(orpcBody.entityId);
      expect(restBody.facts.length).toBe(orpcBody.facts.length);
    });
  });

  describe("auth", () => {
    it("rejects unauthenticated oRPC requests when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      const authedApp = createApp();

      const res = await rpcRequest(authedApp, "stats", undefined);
      expect(res.status).toBe(401);
    });

    it("accepts oRPC requests with correct Bearer token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      const authedApp = createApp();

      const res = await authedApp.request("/rpc/facts/stats", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-secret",
        },
        body: JSON.stringify({ json: undefined, meta: [] }),
      });

      expect(res.status).toBe(200);
    });
  });
});

// ---- REST /api/facts/list tests (new endpoint) ----

describe("REST /api/facts/list (new endpoint)", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("returns all facts with pagination", async () => {
    await seedFact(app, "anthropic", "abc", { measure: "valuation" });
    await seedFact(app, "openai", "def", { measure: "revenue" });

    const res = await app.request("/api/facts/list");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
  });

  it("respects limit and offset", async () => {
    await seedFact(app, "anthropic", "a", { measure: "valuation" });
    await seedFact(app, "openai", "b", { measure: "revenue" });
    await seedFact(app, "deepmind", "c", { measure: "staff" });

    const res = await app.request("/api/facts/list?limit=2&offset=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts).toHaveLength(2);
    expect(body.total).toBe(3);
  });

  it("returns empty for no facts", async () => {
    const res = await app.request("/api/facts/list");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});
