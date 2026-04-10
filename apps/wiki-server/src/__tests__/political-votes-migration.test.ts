/**
 * Phase 2 migration test for political-votes.ts.
 *
 * Verifies that:
 *   1. Factory and legacy handlers produce equivalent behavior on the happy path
 *   2. The feature flag correctly routes between factory and legacy
 *   3. Entity FK validation works in both paths (politicianEntityId + legislationEntityId)
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

  if (q.includes('"political_votes"')) return [];
  if (q.includes('"things"')) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

const VALID_ITEM = {
  id: "pv00000001",
  politicianEntityId: "senator-alice",
  politicianDisplayName: "Senator Alice",
  legislationEntityId: "california-sb1047",
  legislationTitle: "SB 1047",
  vote: "yea" as const,
  voteDate: "2024-08-15",
  chamber: "senate",
  rollCallNumber: 123,
  congressNumber: 118,
  session: 2,
  sourceUrl: "https://example.org/votes/123",
  notes: null,
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("political-votes — feature flag migration", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    resetStores();
    entitiesStore.set("senator-alice", {
      id: "senator-alice",
      stable_id: "sidSenatorAlice",
    });
    entitiesStore.set("california-sb1047", {
      id: "california-sb1047",
      stable_id: "sidCASB1047",
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
      const res = await postJson(app, "/api/political-votes/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        upserted: 1,
        verdictsWritten: 0,
        claimsLinked: 0,
      });
    });

    it("legacy mode returns 200 with legacy response shape", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!political-votes");
      _resetFlagCache();
      const res = await postJson(app, "/api/political-votes/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      // Legacy handler returns only { upserted }, no factory fields
      expect(Object.keys(body)).toEqual(["upserted"]);
    });
  });

  describe("FK validation — politicianEntityId", () => {
    it("factory mode: rejects unknown politicianEntityId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/political-votes/sync", {
        items: [{ ...VALID_ITEM, politicianEntityId: "nonexistent-pol" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-pol");
    });

    it("legacy mode: rejects unknown politicianEntityId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!political-votes");
      _resetFlagCache();
      const res = await postJson(app, "/api/political-votes/sync", {
        items: [{ ...VALID_ITEM, politicianEntityId: "nonexistent-pol" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-pol");
    });
  });

  describe("FK validation — legislationEntityId", () => {
    it("factory mode: rejects unknown legislationEntityId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/political-votes/sync", {
        items: [{ ...VALID_ITEM, legislationEntityId: "nonexistent-bill" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-bill");
    });

    it("factory mode: accepts null politicianEntityId (nullable FK)", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/political-votes/sync", {
        items: [{ ...VALID_ITEM, politicianEntityId: null }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });
  });

  describe("malformed input", () => {
    it("factory mode: rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/political-votes/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("legacy mode: rejects invalid JSON", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!political-votes");
      _resetFlagCache();
      const res = await app.request("/api/political-votes/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/political-votes/sync", {
        items: [{ id: "pv00000001" }], // missing vote (required enum)
      });
      expect(res.status).toBe(400);
    });
  });
});
