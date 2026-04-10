/**
 * Phase 2 migration test for division-personnel.ts.
 *
 * Verifies that:
 *   1. The factory and legacy handlers produce equivalent behavior on the
 *      happy path (both return 200 with the same shape)
 *   2. The feature flag correctly routes between factory and legacy
 *   3. Entity FK validation works in both paths
 *   4. Invalid input is rejected with 400 in both paths
 *
 * This is the canonical Phase 2 migration test pattern. Future Phase 2
 * migrations should follow the same shape:
 *   - Test happy path with factory ON (default)
 *   - Test happy path with factory OFF (legacy fallback)
 *   - Test error cases (FK invalid, malformed body) in both paths
 *
 * After 7 days of clean metrics, the legacy handler is deleted and these
 * tests collapse to just the factory path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockDbModule, postJson } from "./test-utils.js";
import { _resetFlagCache } from "../routes/tablebase/sync-factory-flag.js";

// ---- In-memory stores ----

let entitiesStore: Map<string, Record<string, unknown>>;
let divisionPersonnelStore: Map<string, Record<string, unknown>>;

function resetStores() {
  entitiesStore = new Map();
  divisionPersonnelStore = new Map();
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

  // --- division_personnel: any insert/update ---
  if (q.includes("division_personnel")) {
    return [];
  }

  // --- things: insert/delete ---
  if (q.includes('"things"')) {
    return [];
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Test fixtures ----

const VALID_ITEM = {
  id: "dp00000001",
  divisionId: "open-philanthropy/global-health",
  personId: "alice-smith",
  role: "Program Officer",
  startDate: "2023-01-01",
  endDate: null,
  source: "https://example.org/alice",
  notes: "Joined from prior role",
};

const VALID_BATCH = { items: [VALID_ITEM] };

const INVALID_FK_BATCH = {
  items: [
    {
      ...VALID_ITEM,
      personId: "nonexistent-person",
    },
  ],
};

// ---------------------------------------------------------------------------

describe("division-personnel — feature flag", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    resetStores();
    entitiesStore.set("alice-smith", { id: "alice-smith", stable_id: "sidAliceSmith" });
    entitiesStore.set("open-philanthropy/global-health", {
      id: "open-philanthropy/global-health",
      stable_id: "sidOPGH",
    });
    _resetFlagCache();
    app = await createApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetFlagCache();
  });

  describe("happy path — factory ON (default)", () => {
    it("returns 200 with upserted count", async () => {
      // No env var set → factory ON by default
      _resetFlagCache();
      const res = await postJson(app, "/api/division-personnel/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("returns the standard factory response shape", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/division-personnel/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Factory always returns these three fields
      expect(body).toHaveProperty("upserted");
      expect(body).toHaveProperty("verdictsWritten");
      expect(body).toHaveProperty("claimsLinked");
    });
  });

  describe("happy path — legacy fallback (USE_SYNC_FACTORY_ROUTES=!division-personnel)", () => {
    it("returns 200 with upserted count from legacy handler", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!division-personnel");
      _resetFlagCache();
      const res = await postJson(app, "/api/division-personnel/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("returns the legacy response shape (just upserted, no factory fields)", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!division-personnel");
      _resetFlagCache();
      const res = await postJson(app, "/api/division-personnel/sync", VALID_BATCH);
      const body = await res.json();
      // Legacy handler returns only `{ upserted }`
      expect(Object.keys(body)).toEqual(["upserted"]);
    });
  });

  describe("FK validation — factory ON", () => {
    it("returns 400 for invalid personId", async () => {
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/division-personnel/sync",
        INVALID_FK_BATCH,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-person");
    });
  });

  describe("FK validation — legacy fallback", () => {
    it("returns 400 for invalid personId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!division-personnel");
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/division-personnel/sync",
        INVALID_FK_BATCH,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-person");
    });
  });

  describe("malformed input", () => {
    it("rejects invalid JSON in factory mode", async () => {
      _resetFlagCache();
      const res = await app.request("/api/division-personnel/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON in legacy mode", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!division-personnel");
      _resetFlagCache();
      const res = await app.request("/api/division-personnel/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("rejects items missing required fields in factory mode", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/division-personnel/sync", {
        items: [{ id: "dp00000001" }], // missing divisionId, personId, role
      });
      expect(res.status).toBe(400);
    });
  });

  describe("inclusion mode (other route enabled, division-personnel not listed)", () => {
    it("falls back to legacy when division-personnel not in inclusion list", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "personnel,divisions");
      _resetFlagCache();
      const res = await postJson(app, "/api/division-personnel/sync", VALID_BATCH);
      const body = await res.json();
      // Legacy shape (just upserted, no factory fields)
      expect(Object.keys(body)).toEqual(["upserted"]);
    });
  });
});
