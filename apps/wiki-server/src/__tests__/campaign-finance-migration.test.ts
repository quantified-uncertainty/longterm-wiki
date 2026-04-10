/**
 * Phase 2 migration test for campaign-finance.ts.
 *
 * Verifies that:
 *   1. Factory and legacy handlers produce equivalent behavior on the happy path
 *   2. The feature flag correctly routes between factory and legacy
 *   3. Entity FK validation (politicianEntityId) works in both paths
 *   4. Invalid input is rejected with 400 in both paths
 *
 * Tier 3 route: factory converts the per-item loop into a batched upsert.
 * This is the LARGEST table in the system (25 columns); factory auto-chunk
 * size computes floor(60000 / 25) = 2400 rows per chunk, well within the
 * Postgres parameter limit for the 200-row max batch.
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

  if (q.includes('"campaign_finance"')) return [];
  if (q.includes('"things"')) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

const VALID_ITEM = {
  id: "cf00000001",
  politicianEntityId: "senator-alice",
  politicianDisplayName: "Senator Alice",
  cycle: 2024,
  totalRaised: 1_500_000,
  totalSpent: 1_200_000,
  cashOnHand: 300_000,
  individualContributions: 900_000,
  pacContributions: 500_000,
  smallDonorContributions: 100_000,
  selfFunding: 0,
  party: "D",
  officeType: "senate",
  state: "CA",
  district: null,
  fecCandidateId: "S2CA00123",
  sourceUrl: "https://example.org/fec/alice",
  dataAsOf: "2024-09-30",
  notes: null,
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("campaign-finance — feature flag migration", () => {
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
      const res = await postJson(app, "/api/campaign-finance/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        upserted: 1,
        verdictsWritten: 0,
        claimsLinked: 0,
      });
    });

    it("legacy mode returns 200 with legacy response shape", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!campaign-finance");
      _resetFlagCache();
      const res = await postJson(app, "/api/campaign-finance/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      // Legacy handler returns only { upserted }, no factory fields
      expect(Object.keys(body)).toEqual(["upserted"]);
    });

    it("factory mode: accepts null politicianEntityId (nullable FK)", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/campaign-finance/sync", {
        items: [{ ...VALID_ITEM, politicianEntityId: null }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("factory mode: accepts multiple items (stress test the 25-column table)", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/campaign-finance/sync", {
        items: [
          VALID_ITEM,
          { ...VALID_ITEM, id: "cf00000002", cycle: 2022 },
          { ...VALID_ITEM, id: "cf00000003", cycle: 2020 },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(3);
    });
  });

  describe("FK validation — politicianEntityId", () => {
    it("factory mode: rejects unknown politicianEntityId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/campaign-finance/sync", {
        items: [{ ...VALID_ITEM, politicianEntityId: "nonexistent-pol" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-pol");
    });

    it("legacy mode: rejects unknown politicianEntityId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!campaign-finance");
      _resetFlagCache();
      const res = await postJson(app, "/api/campaign-finance/sync", {
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
      const res = await app.request("/api/campaign-finance/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("legacy mode: rejects invalid JSON", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!campaign-finance");
      _resetFlagCache();
      const res = await app.request("/api/campaign-finance/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/campaign-finance/sync", {
        items: [{ id: "cf00000001" }], // missing cycle (required)
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects cycle out of range", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/campaign-finance/sync", {
        items: [{ ...VALID_ITEM, cycle: 1900 }], // below min 1990
      });
      expect(res.status).toBe(400);
    });
  });
});
