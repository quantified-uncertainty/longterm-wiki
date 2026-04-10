/**
 * Phase 2 migration test for political-races.ts (main /sync endpoint).
 *
 * Verifies that:
 *   1. Factory and legacy handlers produce equivalent behavior on the happy path
 *   2. The feature flag correctly routes between factory and legacy
 *   3. Entity FK validation (policyEntityId) works in both paths
 *   4. Invalid input is rejected with 400 in both paths
 *   5. The secondary /candidates/sync endpoint is unaffected by this migration
 *      (it remains hand-rolled and is not covered by the feature flag).
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

  // resolveEntityTitles query (used by legacy handler)
  if (q.includes("from entities") && q.includes("title")) {
    return params
      .filter((p) => {
        const id = p as string;
        if (entitiesStore.has(id)) return true;
        for (const row of entitiesStore.values()) {
          if (row.stable_id === id) return true;
        }
        return false;
      })
      .map((p) => {
        const id = p as string;
        const row = entitiesStore.get(id);
        return {
          id: row?.id ?? id,
          stable_id: row?.stable_id ?? id,
          title: row?.title ?? id,
        };
      });
  }

  if (q.includes('"political_races"')) return [];
  if (q.includes('"race_candidates"')) return [];
  if (q.includes('"things"')) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

const VALID_ITEM = {
  id: "pr00000001",
  name: "California Senate 2024",
  raceType: "general" as const,
  party: null,
  level: "federal_senate" as const,
  state: "CA",
  district: null,
  electionDate: "2024-11-05",
  status: "upcoming" as const,
  outcome: null,
  outcomeDetails: null,
  aiAngle: "Key race for AI policy",
  aiAngleSummary: null,
  policyEntityId: "ai-safety-policy",
  measureTitle: null,
  measureDescription: null,
  source: "https://example.org/races/ca-senate-2024",
  notes: null,
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("political-races — feature flag migration", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    resetStores();
    entitiesStore.set("ai-safety-policy", {
      id: "ai-safety-policy",
      stable_id: "sidAiSafetyPolicy",
      title: "AI Safety Policy",
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
      const res = await postJson(app, "/api/political-races/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        upserted: 1,
        verdictsWritten: 0,
        claimsLinked: 0,
      });
    });

    it("legacy mode returns 200 with legacy response shape", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!political-races");
      _resetFlagCache();
      const res = await postJson(app, "/api/political-races/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      // Legacy handler returns only { upserted }, no factory fields
      expect(Object.keys(body)).toEqual(["upserted"]);
    });

    it("factory mode: accepts null policyEntityId (nullable FK)", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/political-races/sync", {
        items: [{ ...VALID_ITEM, policyEntityId: null }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });
  });

  describe("FK validation — policyEntityId", () => {
    it("factory mode: rejects unknown policyEntityId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/political-races/sync", {
        items: [{ ...VALID_ITEM, policyEntityId: "nonexistent-policy" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-policy");
    });

    it("legacy mode: rejects unknown policyEntityId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!political-races");
      _resetFlagCache();
      const res = await postJson(app, "/api/political-races/sync", {
        items: [{ ...VALID_ITEM, policyEntityId: "nonexistent-policy" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-policy");
    });
  });

  describe("malformed input", () => {
    it("factory mode: rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/political-races/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("legacy mode: rejects invalid JSON", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!political-races");
      _resetFlagCache();
      const res = await app.request("/api/political-races/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/political-races/sync", {
        items: [{ id: "pr00000001" }], // missing name, raceType, level (required)
      });
      expect(res.status).toBe(400);
    });
  });

  describe("/candidates/sync — unaffected by main /sync migration", () => {
    // The secondary candidates endpoint is NOT migrated to the factory.
    // It should continue working regardless of the feature flag state.
    const VALID_CANDIDATE = {
      id: "rc00000001",
      raceId: "pr00000001",
      candidateEntityId: "senator-alice",
      candidateDisplayName: "Senator Alice",
      isIncumbent: true,
      isWinner: false,
      voteShare: null,
      status: "running" as const,
      pacEntityId: null,
      pacDisplayName: null,
      pacAmount: null,
      pacPosition: null,
      party: "D",
      endorsements: null,
      aiStance: "pro_regulation" as const,
      source: "https://example.org/candidates/alice",
      notes: null,
    };

    it("still works when political-races is excluded from factory", async () => {
      entitiesStore.set("senator-alice", {
        id: "senator-alice",
        stable_id: "sidSenatorAlice",
        title: "Senator Alice",
      });
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!political-races");
      _resetFlagCache();
      const res = await postJson(app, "/api/political-races/candidates/sync", {
        items: [VALID_CANDIDATE],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      // Hand-rolled handler returns only { upserted }
      expect(Object.keys(body)).toEqual(["upserted"]);
    });

    it("still works with factory mode on (the candidates endpoint is not flagged)", async () => {
      entitiesStore.set("senator-alice", {
        id: "senator-alice",
        stable_id: "sidSenatorAlice",
        title: "Senator Alice",
      });
      _resetFlagCache();
      const res = await postJson(app, "/api/political-races/candidates/sync", {
        items: [VALID_CANDIDATE],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      expect(Object.keys(body)).toEqual(["upserted"]);
    });
  });
});
