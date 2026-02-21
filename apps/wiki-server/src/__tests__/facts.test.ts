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

/** Composite key for the unique index */
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

  // Discriminator: stale queries don't filter by entity_id, while
  // timeseries and by-entity queries always have entity_id = $N.
  const hasEntityIdFilter = q.includes('entity_id" =');

  // --- facts: STALE SELECT (is not null + order by, NO entity_id filter) ---
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
    // olderThan filter — first string param is the date threshold
    const dateParam = params.find((p) => typeof p === "string") as string | undefined;
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
    return results.slice(offset, offset + limit).map((r) => ({
      entityId: r.entity_id,
      factId: r.fact_id,
      label: r.label,
      asOf: r.as_of,
      measure: r.measure,
      value: r.value,
      numeric: r.numeric,
    }));
  }

  // --- facts: STALE COUNT (count + is not null, NO entity_id filter) ---
  if (
    q.includes("count(*)") &&
    q.includes('"facts"') &&
    q.includes("is not null") &&
    !hasEntityIdFilter
  ) {
    let results = Array.from(factsStore.values()).filter(
      (r) => r.as_of !== null
    );
    const dateParam = params.find((p) => typeof p === "string") as string | undefined;
    if (dateParam) {
      results = results.filter((r) => String(r.as_of) <= dateParam);
    }
    return [{ count: results.length }];
  }

  // --- facts: SELECT by entity_id + measure + as_of IS NOT NULL (timeseries) ---
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

    // If measure is specified
    if (params.length > 1 && typeof params[1] === "string") {
      results = results.filter((r) => r.measure === params[1]);
    }

    results.sort((a, b) =>
      String(a.as_of || "").localeCompare(String(b.as_of || ""))
    );

    const limitIdx = params.findIndex(
      (p, idx) => idx > 0 && typeof p === "number"
    );
    const limit =
      limitIdx >= 0 ? (params[limitIdx] as number) : 100;
    return results.slice(0, limit);
  }

  // --- facts: SELECT by entity_id (by-entity) ---
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

    // If measure is specified (second param before limit)
    if (params.length > 1 && typeof params[1] === "string") {
      results = results.filter((r) => r.measure === params[1]);
    }

    results.sort((a, b) =>
      String(a.fact_id || "").localeCompare(String(b.fact_id || ""))
    );

    const limitIdx = params.findIndex(
      (p, idx) => idx > 0 && typeof p === "number"
    );
    const limit =
      limitIdx >= 0 ? (params[limitIdx] as number) : 100;
    const offsetIdx = limitIdx >= 0 ? limitIdx + 1 : -1;
    const offset =
      offsetIdx >= 0 && offsetIdx < params.length
        ? (params[offsetIdx] as number)
        : 0;
    return results.slice(offset, offset + limit);
  }

  // --- facts: COUNT(*) with entity_id filter (by-entity count) ---
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

  // --- facts: count(distinct entity_id) ---
  if (q.includes("count(distinct") && q.includes("entity_id")) {
    const unique = new Set<string>();
    for (const row of factsStore.values()) {
      unique.add(row.entity_id as string);
    }
    return [{ count: unique.size }];
  }

  // --- facts: count(distinct measure) ---
  if (q.includes("count(distinct") && q.includes("measure")) {
    const unique = new Set<string>();
    for (const row of factsStore.values()) {
      if (row.measure) unique.add(row.measure as string);
    }
    return [{ count: unique.size }];
  }

  // --- entity_ids: COUNT (for health check) ---
  if (q.includes("count(*)") && !q.includes('"facts"')) {
    return [{ count: 0 }];
  }

  // --- sequence health check ---
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: true }];
  }

  return [];
}

// Mock the db module
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

// ---- Tests ----

describe("Facts API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ---- Sync ----

  describe("POST /api/facts/sync", () => {
    it("creates new facts", async () => {
      const res = await postJson(app, "/api/facts/sync", {
        facts: [
          {
            entityId: "anthropic",
            factId: "abc123",
            label: "Valuation",
            value: "61000000000",
            numeric: 61000000000,
            asOf: "2024-03",
            measure: "valuation",
          },
          {
            entityId: "anthropic",
            factId: "def456",
            label: "Revenue",
            value: "1000000000",
            numeric: 1000000000,
            asOf: "2025-01",
            measure: "revenue",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(2);
    });

    it("updates existing facts", async () => {
      await seedFact(app, "anthropic", "abc123", {
        label: "Old label",
        value: "100",
      });

      const res = await postJson(app, "/api/facts/sync", {
        facts: [
          {
            entityId: "anthropic",
            factId: "abc123",
            label: "Updated label",
            value: "200",
            numeric: 200,
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/facts/sync", { facts: [] });
      expect(res.status).toBe(400);
    });

    it("rejects facts without entityId", async () => {
      const res = await postJson(app, "/api/facts/sync", {
        facts: [{ factId: "abc" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON", async () => {
      const res = await app.request("/api/facts/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_json");
    });
  });

  // ---- By Entity ----

  describe("GET /api/facts/by-entity/:entityId", () => {
    it("returns facts for an entity", async () => {
      await seedFact(app, "anthropic", "abc123", {
        label: "Valuation",
        measure: "valuation",
      });
      await seedFact(app, "anthropic", "def456", {
        label: "Revenue",
        measure: "revenue",
      });

      const res = await app.request("/api/facts/by-entity/anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entityId).toBe("anthropic");
      expect(body.facts).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("returns empty for unknown entity", async () => {
      const res = await app.request("/api/facts/by-entity/nonexistent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.facts).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  // ---- Timeseries ----

  describe("GET /api/facts/timeseries/:entityId", () => {
    it("returns timeseries for a measure", async () => {
      await seedFact(app, "anthropic", "rev-q1", {
        label: "Revenue Q1",
        asOf: "2025-01",
        measure: "revenue",
        numeric: 1000000000,
      });
      await seedFact(app, "anthropic", "rev-q2", {
        label: "Revenue Q2",
        asOf: "2025-06",
        measure: "revenue",
        numeric: 4000000000,
      });

      const res = await app.request(
        "/api/facts/timeseries/anthropic?measure=revenue"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entityId).toBe("anthropic");
      expect(body.measure).toBe("revenue");
      expect(body.points.length).toBeGreaterThan(0);
    });

    it("requires measure parameter", async () => {
      const res = await app.request("/api/facts/timeseries/anthropic");
      expect(res.status).toBe(400);
    });
  });

  // ---- Stats ----

  describe("GET /api/facts/stats", () => {
    it("returns fact statistics", async () => {
      await seedFact(app, "anthropic", "abc", { measure: "valuation" });
      await seedFact(app, "openai", "def", { measure: "revenue" });

      const res = await app.request("/api/facts/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.uniqueEntities).toBe(2);
      expect(body.uniqueMeasures).toBe(2);
    });
  });

  // ---- Stale ----

  describe("GET /api/facts/stale", () => {
    it("returns stale facts ordered by asOf", async () => {
      await seedFact(app, "anthropic", "old-fact", {
        asOf: "2023-01",
        measure: "revenue",
      });
      await seedFact(app, "anthropic", "recent-fact", {
        asOf: "2025-12",
        measure: "revenue",
      });

      const res = await app.request("/api/facts/stale?olderThan=2024-01");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.facts.length).toBeGreaterThan(0);
      expect(body.total).toBeGreaterThan(0);
    });

    it("returns all facts with asOf when no olderThan given", async () => {
      await seedFact(app, "anthropic", "f1", { asOf: "2025-06" });

      const res = await app.request("/api/facts/stale");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.facts.length).toBeGreaterThan(0);
    });

    it("returns empty when no stale facts", async () => {
      const res = await app.request("/api/facts/stale");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.facts).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  // ---- Range values ----

  describe("Range value facts", () => {
    it("syncs facts with low/high range", async () => {
      const res = await postJson(app, "/api/facts/sync", {
        facts: [
          {
            entityId: "anthropic",
            factId: "rev-guidance",
            label: "Revenue guidance",
            value: "20000000000-26000000000",
            low: 20000000000,
            high: 26000000000,
            asOf: "2026-01",
            measure: "revenue-guidance",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });
  });

  // ---- Auth ----

  describe("Bearer auth", () => {
    it("rejects unauthenticated sync when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      const authedApp = createApp();

      const res = await postJson(authedApp, "/api/facts/sync", {
        facts: [
          {
            entityId: "anthropic",
            factId: "abc",
            label: "Test",
          },
        ],
      });

      expect(res.status).toBe(401);
    });

    it("accepts sync with correct Bearer token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      const authedApp = createApp();

      const res = await authedApp.request("/api/facts/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-secret",
        },
        body: JSON.stringify({
          facts: [
            {
              entityId: "anthropic",
              factId: "abc",
              label: "Test",
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
    });
  });
});
