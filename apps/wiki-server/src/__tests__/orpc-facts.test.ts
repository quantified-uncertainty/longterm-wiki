import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule } from "./test-utils.js";
import {
  factsDispatch,
  resetFactsStore,
  seedFact,
} from "./facts-test-fixtures.js";

vi.mock("../db.js", () => mockDbModule(factsDispatch));

const { createApp } = await import("../app.js");

// ---- oRPC helpers ----

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
    resetFactsStore();
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

    it("filters by measure", async () => {
      await seedFact(app, "anthropic", "val-1", { measure: "valuation" });
      await seedFact(app, "anthropic", "rev-1", { measure: "revenue" });

      const res = await rpcRequest(app, "byEntity", {
        entityId: "anthropic",
        measure: "revenue",
      });

      expect(res.status).toBe(200);
      const body = await rpcJson(res);
      expect(body.facts).toHaveLength(1);
      expect(body.total).toBe(1);
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
    it("syncs a single fact via oRPC", async () => {
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

    it("syncs multiple facts via oRPC", async () => {
      const res = await rpcRequest(app, "sync", {
        facts: [
          {
            entityId: "anthropic",
            factId: "val-2024",
            label: "Valuation",
            value: "61000000000",
            numeric: 61000000000,
          },
          {
            entityId: "openai",
            factId: "rev-2025",
            label: "Revenue",
            value: "5000000000",
            numeric: 5000000000,
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await rpcJson(res);
      expect(body.upserted).toBe(2);
    });
  });

  // ---- Parity: REST vs oRPC return same data ----

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

    it("timeseries returns same data via REST and oRPC", async () => {
      await seedFact(app, "anthropic", "rev-q1", {
        asOf: "2025-01",
        measure: "revenue",
        numeric: 1000000000,
      });

      const restRes = await app.request(
        "/api/facts/timeseries/anthropic?measure=revenue"
      );
      const orpcRes = await rpcRequest(app, "timeseries", {
        entityId: "anthropic",
        measure: "revenue",
      });

      const restBody = await restRes.json();
      const orpcBody = await rpcJson(orpcRes);

      expect(restBody.entityId).toBe(orpcBody.entityId);
      expect(restBody.measure).toBe(orpcBody.measure);
      expect(restBody.points.length).toBe(orpcBody.points.length);
      expect(restBody.total).toBe(orpcBody.total);
    });

    it("stale returns same data via REST and oRPC", async () => {
      await seedFact(app, "anthropic", "old-fact", {
        asOf: "2023-01",
        measure: "revenue",
      });

      const restRes = await app.request(
        "/api/facts/stale?olderThan=2024-01"
      );
      const orpcRes = await rpcRequest(app, "stale", {
        olderThan: "2024-01",
      });

      const restBody = await restRes.json();
      const orpcBody = await rpcJson(orpcRes);

      expect(restBody.total).toBe(orpcBody.total);
      expect(restBody.facts.length).toBe(orpcBody.facts.length);
    });

    it("list returns same data via REST and oRPC", async () => {
      await seedFact(app, "anthropic", "abc", { measure: "valuation" });
      await seedFact(app, "openai", "def", { measure: "revenue" });

      const restRes = await app.request("/api/facts/list");
      const orpcRes = await rpcRequest(app, "list", {});

      const restBody = await restRes.json();
      const orpcBody = await rpcJson(orpcRes);

      expect(restBody.total).toBe(orpcBody.total);
      expect(restBody.facts.length).toBe(orpcBody.facts.length);
    });
  });

  // ---- Auth ----

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
    resetFactsStore();
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
