import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";
import {
  factsDispatch,
  resetFactsStore,
  seedFact,
} from "./facts-test-fixtures.js";

vi.mock("../db.js", () => mockDbModule(factsDispatch));

const { createApp } = await import("../app.js");

// ---- Tests ----

describe("Facts API", () => {
  let app: Hono;

  beforeEach(() => {
    resetFactsStore();
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
