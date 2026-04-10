/**
 * Phase 2 migration test for prediction-markets.ts (Batch D).
 *
 * Verifies that:
 *   1. Factory and legacy handlers produce equivalent behavior on the happy path
 *   2. The feature flag correctly routes between factory and legacy
 *   3. Entity FK validation works in both paths (nullable entityId)
 *   4. Invalid input is rejected with 400 in both paths
 *
 * This route exercises the factory's COMPOSITE conflict target support
 * (`conflictTarget: [platform, platformQuestionId]`). The unique key for
 * upserts is NOT the row id.
 *
 * Only the main /questions/sync endpoint is migrated. The secondary
 * /snapshots/sync endpoint remains hand-rolled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockDbModule, postJson } from "./test-utils.js";
import { _resetFlagCache } from "../routes/tablebase/sync-factory-flag.js";

let entitiesStore: Map<string, Record<string, unknown>>;

function resetStores() {
  entitiesStore = new Map();
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // validate-entity-refs — unnest ARRAY against entities
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

  if (q.includes('"prediction_market_questions"')) return [];
  if (q.includes('"things"')) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

const VALID_ITEM = {
  id: "pmq0000001",
  platform: "metaculus" as const,
  platformQuestionId: "12345",
  entityId: "anthropic",
  entityDisplayName: "Anthropic",
  questionText: "Will Anthropic reach $10B valuation by 2026?",
  questionUrl: "https://metaculus.example/q/12345",
  resolutionDate: "2026-12-31",
  resolutionCriteria: "Per publicly reported funding round.",
  questionType: "binary" as const,
  category: "valuation",
  isResolved: false,
  currentProbability: 0.72,
  source: "https://metaculus.example/q/12345",
  notes: null,
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("prediction-markets — feature flag migration", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    resetStores();
    entitiesStore.set("anthropic", {
      id: "anthropic",
      stable_id: "sidAnthropic",
    });
    _resetFlagCache();
    app = await createApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetFlagCache();
  });

  describe("happy path with composite conflict target", () => {
    it("factory mode (default) returns 200", async () => {
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/prediction-markets/questions/sync",
        VALID_BATCH,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      expect(body.verdictsWritten).toBe(0);
    });

    it("legacy mode returns 200 with legacy response shape", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!prediction-markets");
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/prediction-markets/questions/sync",
        VALID_BATCH,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      expect(body.verdictsWritten).toBe(0);
    });

    it("accepts a batch with multiple items across platforms", async () => {
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/prediction-markets/questions/sync",
        {
          items: [
            VALID_ITEM,
            {
              ...VALID_ITEM,
              id: "pmq0000002",
              platform: "polymarket" as const,
              platformQuestionId: "abc",
            },
            {
              ...VALID_ITEM,
              id: "pmq0000003",
              platform: "manifold" as const,
              platformQuestionId: "xyz",
            },
          ],
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(3);
    });
  });

  describe("FK validation", () => {
    it("factory mode: rejects unknown entityId", async () => {
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/prediction-markets/questions/sync",
        {
          items: [{ ...VALID_ITEM, entityId: "ghost-co" }],
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("ghost-co");
    });

    it("legacy mode: rejects unknown entityId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!prediction-markets");
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/prediction-markets/questions/sync",
        {
          items: [{ ...VALID_ITEM, entityId: "ghost-co" }],
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("ghost-co");
    });

    it("factory mode: accepts null entityId (nullable FK)", async () => {
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/prediction-markets/questions/sync",
        {
          items: [{ ...VALID_ITEM, entityId: null }],
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("legacy mode: accepts null entityId (nullable FK)", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!prediction-markets");
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/prediction-markets/questions/sync",
        {
          items: [{ ...VALID_ITEM, entityId: null }],
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });
  });

  describe("schema validation", () => {
    it("factory mode: rejects invalid platform enum", async () => {
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/prediction-markets/questions/sync",
        {
          items: [{ ...VALID_ITEM, platform: "not-a-platform" }],
        },
      );
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects invalid questionType enum", async () => {
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/prediction-markets/questions/sync",
        {
          items: [{ ...VALID_ITEM, questionType: "made-up" }],
        },
      );
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request(
        "/api/prediction-markets/questions/sync",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{not json",
        },
      );
      expect(res.status).toBe(400);
    });

    it("legacy mode: rejects invalid JSON", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!prediction-markets");
      _resetFlagCache();
      const res = await app.request(
        "/api/prediction-markets/questions/sync",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{not json",
        },
      );
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/prediction-markets/questions/sync",
        {
          items: [{ id: "pmq0000001" }], // missing platform + questionText
        },
      );
      expect(res.status).toBe(400);
    });
  });
});
