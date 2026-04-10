/**
 * Phase 2 migration test for political-offices.ts.
 *
 * Verifies that:
 *   1. Factory and legacy handlers produce equivalent behavior on the happy path
 *   2. The feature flag correctly routes between factory and legacy
 *   3. Entity FK validation works in both paths (politicianEntityId)
 *   4. Invalid input is rejected with 400 in both paths
 *
 * Tier 3 route: factory converts the per-item loop into a batched upsert.
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

  if (q.includes('"political_offices"')) return [];
  if (q.includes('"things"')) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

const VALID_ITEM = {
  id: "po00000001",
  politicianEntityId: "senator-alice",
  politicianDisplayName: "Senator Alice",
  officeType: "senator",
  jurisdiction: "CA",
  district: null,
  party: "democratic",
  status: "incumbent" as const,
  termStart: "2023",
  termEnd: "2029",
  sourceUrl: "https://example.org/alice",
  notes: null,
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("political-offices — feature flag migration", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    resetStores();
    entitiesStore.set("senator-alice", {
      id: "senator-alice",
      stable_id: "sidSenatorAlice",
    });
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
      const res = await postJson(app, "/api/political-offices/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        upserted: 1,
        verdictsWritten: 0,
        claimsLinked: 0,
      });
    });

    it("legacy mode returns 200 with legacy response shape", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!political-offices");
      _resetFlagCache();
      const res = await postJson(app, "/api/political-offices/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      expect(Object.keys(body)).toEqual(["upserted"]);
    });
  });

  describe("FK validation", () => {
    it("factory mode: rejects unknown politicianEntityId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/political-offices/sync", {
        items: [{ ...VALID_ITEM, politicianEntityId: "nonexistent-pol" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-pol");
    });

    it("legacy mode: rejects unknown politicianEntityId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!political-offices");
      _resetFlagCache();
      const res = await postJson(app, "/api/political-offices/sync", {
        items: [{ ...VALID_ITEM, politicianEntityId: "nonexistent-pol" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-pol");
    });
  });

  describe("malformed input", () => {
    it("factory mode: rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/political-offices/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("legacy mode: rejects invalid JSON", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!political-offices");
      _resetFlagCache();
      const res = await app.request("/api/political-offices/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/political-offices/sync", {
        items: [{ id: "po00000001" }], // missing politicianEntityId, officeType, jurisdiction
      });
      expect(res.status).toBe(400);
    });
  });
});
