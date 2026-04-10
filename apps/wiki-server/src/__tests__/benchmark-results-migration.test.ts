/**
 * Phase 2 migration test for benchmark-results.ts.
 *
 * This route exercises the factory's `preValidate` escape hatch, used for
 * two responsibilities that share one DB query:
 *   1. Validating `benchmarkId` against the `benchmarks` table (a non-entities FK).
 *   2. Auto-resolving benchmark slugs → ids in place before the upsert.
 *
 * `modelId` is a standard entities FK validated via `entityRefFields`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockDbModule, postJson } from "./test-utils.js";
import { _resetFlagCache } from "../routes/tablebase/sync-factory-flag.js";

let entitiesStore: Map<string, Record<string, unknown>>;
let benchmarksStore: Map<string, { id: string; slug: string }>;

function resetStores() {
  entitiesStore = new Map();
  benchmarksStore = new Map();
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // Entity ref validation query — uses unnest against entities
  if (q.includes("unnest") && q.includes("from entities")) {
    return params
      .filter((p) => {
        const id = p as string;
        if (entitiesStore.has(id)) return true;
        for (const row of entitiesStore.values()) {
          if (row.stable_id === id) return true;
        }
        return false;
      })
      .map((p) => ({ ref: p }));
  }

  // benchmarks lookup: SELECT id, slug FROM benchmarks WHERE id IN (...) OR slug IN (...)
  if (q.includes("from benchmarks")) {
    return params
      .filter((p) => {
        const key = p as string;
        for (const b of benchmarksStore.values()) {
          if (b.id === key || b.slug === key) return true;
        }
        return false;
      })
      .map((p) => {
        const key = p as string;
        for (const b of benchmarksStore.values()) {
          if (b.id === key || b.slug === key) return { id: b.id, slug: b.slug };
        }
        return { id: key, slug: key };
      });
  }

  if (q.includes('"benchmark_results"')) return [];
  if (q.includes('"things"')) return [];
  if (q.includes("proposed_claims")) return [];
  if (q.includes("claim_record_links")) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

const VALID_ITEM = {
  id: "bmr0000001",
  benchmarkId: "bmk0000001",
  modelId: "gpt-4",
  score: 85.5,
  unit: "accuracy",
  date: "2024-01-15",
  sourceUrl: "https://example.org/benchmark",
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("benchmark-results — feature flag migration", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    resetStores();
    entitiesStore.set("gpt-4", { id: "gpt-4", stable_id: "sidGpt4" });
    benchmarksStore.set("bmk0000001", { id: "bmk0000001", slug: "mmlu" });
    _resetFlagCache();
    app = await createApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetFlagCache();
  });

  describe("happy path", () => {
    it("factory mode (default) returns 200 with full response shape", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmark-results/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        upserted: 1,
        verdictsWritten: 0,
        claimsLinked: 0,
      });
    });

    it("legacy mode returns 200 with the same upserted count", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!benchmark-results");
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmark-results/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      expect(body.verdictsWritten).toBe(0);
    });

    it("factory mode accepts multiple items", async () => {
      _resetFlagCache();
      entitiesStore.set("claude-3", { id: "claude-3", stable_id: "sidClaude3" });
      const res = await postJson(app, "/api/benchmark-results/sync", {
        items: [
          VALID_ITEM,
          { ...VALID_ITEM, id: "bmr0000002", modelId: "claude-3", score: 88.0 },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(2);
    });
  });

  describe("benchmark FK validation (preValidate hook)", () => {
    it("factory mode: rejects unknown benchmarkId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmark-results/sync", {
        items: [{ ...VALID_ITEM, benchmarkId: "bmkUnknown" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("bmkUnknown");
      expect(body.message).toContain("benchmarks");
    });

    it("legacy mode: rejects unknown benchmarkId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!benchmark-results");
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmark-results/sync", {
        items: [{ ...VALID_ITEM, benchmarkId: "bmkUnknown" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("bmkUnknown");
    });

    it("factory mode: accepts a benchmark slug and auto-resolves it to id", async () => {
      _resetFlagCache();
      // Submit with slug "mmlu" — should be accepted since slug matches
      // benchmarksStore entry and preValidate resolves it to the underlying id.
      const res = await postJson(app, "/api/benchmark-results/sync", {
        items: [{ ...VALID_ITEM, benchmarkId: "mmlu" }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });
  });

  describe("model (entity) FK validation", () => {
    it("factory mode: rejects unknown modelId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmark-results/sync", {
        items: [{ ...VALID_ITEM, modelId: "nonexistent-model" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-model");
    });

    it("legacy mode: rejects unknown modelId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!benchmark-results");
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmark-results/sync", {
        items: [{ ...VALID_ITEM, modelId: "nonexistent-model" }],
      });
      expect(res.status).toBe(400);
    });
  });

  describe("malformed input", () => {
    it("factory mode rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/benchmark-results/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("factory mode rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/benchmark-results/sync", {
        items: [{ id: "bmr0000001" }], // missing benchmarkId, modelId, score
      });
      expect(res.status).toBe(400);
    });
  });
});
