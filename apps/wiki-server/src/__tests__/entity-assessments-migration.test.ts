/**
 * Phase 2 Batch C migration test for entity-assessments.ts.
 *
 * Verifies factory and legacy handlers produce equivalent behavior on the
 * happy path, entity FK validation, and malformed input. Follows the
 * canonical Phase 2 migration test pattern (see division-personnel-migration.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockDbModule, postJson } from "./test-utils.js";
import { _resetFlagCache } from "../routes/tablebase/sync-factory-flag.js";

// ---- In-memory stores ----

let entitiesStore: Map<string, Record<string, unknown>>;

function resetStores() {
  entitiesStore = new Map();
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- validate-entity-refs ---
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

  // --- resolveEntityTitles: select ... from "entities" ---
  if (q.includes('from "entities"')) return [];

  // --- entity_assessments: insert/update ---
  if (q.includes("entity_assessments")) return [];

  // --- things: insert/delete ---
  if (q.includes('"things"')) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Test fixtures ----

const VALID_ITEM = {
  id: "ea00000001",
  entityId: "anthropic",
  dimension: "speed",
  rating: "Fast (<1 week)",
  evidence: "Ships new features weekly.",
  assessor: "editorial" as const,
  assessedAt: "2024-01-15",
  source: "https://example.org/anthropic-speed",
  notes: "Based on public releases.",
};

const VALID_BATCH = { items: [VALID_ITEM] };

const INVALID_FK_BATCH = {
  items: [
    {
      ...VALID_ITEM,
      entityId: "nonexistent-entity",
    },
  ],
};

// ---------------------------------------------------------------------------

describe("entity-assessments — feature flag migration", () => {
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

  describe("happy path — factory ON (default)", () => {
    it("returns 200 with upserted count and factory fields", async () => {
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/entity-assessments/sync",
        VALID_BATCH,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      expect(body).toHaveProperty("verdictsWritten");
      expect(body).toHaveProperty("claimsLinked");
    });
  });

  describe("happy path — legacy fallback (USE_SYNC_FACTORY_ROUTES=!entity-assessments)", () => {
    it("returns 200 with just upserted count", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!entity-assessments");
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/entity-assessments/sync",
        VALID_BATCH,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      // Legacy returns only { upserted }
      expect(Object.keys(body)).toEqual(["upserted"]);
    });
  });

  describe("FK validation — factory ON", () => {
    it("returns 400 for invalid entityId", async () => {
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/entity-assessments/sync",
        INVALID_FK_BATCH,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-entity");
    });
  });

  describe("FK validation — legacy fallback", () => {
    it("returns 400 for invalid entityId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!entity-assessments");
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/entity-assessments/sync",
        INVALID_FK_BATCH,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-entity");
    });
  });

  describe("malformed input", () => {
    it("rejects invalid JSON in factory mode", async () => {
      _resetFlagCache();
      const res = await app.request("/api/entity-assessments/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("rejects items missing required fields in factory mode", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/entity-assessments/sync", {
        items: [{ id: "ea00000001" }], // missing entityId, dimension, rating
      });
      expect(res.status).toBe(400);
    });
  });
});
