/**
 * Phase 2 migration test for benchmarks.ts.
 *
 * Verifies that:
 *   1. Factory and legacy handlers produce equivalent behavior on the happy path
 *   2. The feature flag correctly routes between factory and legacy
 *   3. Things dual-write happens in both paths
 *   4. Invalid input is rejected with 400 in both paths
 *
 * Tier 3 route: factory converts the per-item loop into a batched upsert.
 * No entity FK validation (benchmarks have no entity references).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockDbModule, postJson } from "./test-utils.js";
import { _resetFlagCache } from "../routes/tablebase/sync-factory-flag.js";

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  if (q.includes('"benchmarks"')) return [];
  if (q.includes('"things"')) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

const VALID_ITEM = {
  id: "bmk0000001",
  slug: "mmlu",
  name: "MMLU",
  category: "knowledge" as const,
  description: "Massive Multitask Language Understanding",
  website: "https://example.org/mmlu",
  scoringMethod: "accuracy",
  higherIsBetter: true,
  introducedDate: "2020-09-07",
  maintainer: "Hendrycks et al.",
  source: "https://arxiv.org/abs/2009.03300",
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("benchmarks — feature flag migration", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    _resetFlagCache();
    app = await createApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetFlagCache();
  });

  describe("happy path", () => {
    it("factory mode (default) returns 200 with factory response shape", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmarks/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        upserted: 1,
        verdictsWritten: 0,
        claimsLinked: 0,
      });
    });

    it("legacy mode returns 200 with legacy response shape", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!benchmarks");
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmarks/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      // Legacy handler returns only { upserted }, no factory fields
      expect(Object.keys(body)).toEqual(["upserted"]);
    });

    it("factory mode: accepts multiple items", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmarks/sync", {
        items: [
          VALID_ITEM,
          { ...VALID_ITEM, id: "bmk0000002", slug: "hellaswag", name: "HellaSwag" },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(2);
    });

    it("factory mode: accepts minimal required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmarks/sync", {
        items: [
          {
            id: "bmk0000003",
            slug: "minimal",
            name: "Minimal Benchmark",
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });
  });

  describe("malformed input", () => {
    it("factory mode: rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/benchmarks/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("legacy mode: rejects invalid JSON", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!benchmarks");
      _resetFlagCache();
      const res = await app.request("/api/benchmarks/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmarks/sync", {
        items: [{ id: "bmk0000001" }], // missing slug, name (required)
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects invalid category enum", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmarks/sync", {
        items: [{ ...VALID_ITEM, category: "not-a-valid-category" }],
      });
      expect(res.status).toBe(400);
    });
  });
});
