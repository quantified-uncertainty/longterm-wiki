/**
 * Phase 2 migration test for investments.ts.
 *
 * investments.ts is the most feature-complete Tier 2 route — it exercises
 * the factory's natural key, entity FK, claim validation, FK resolve, things
 * sync, and verdicts pipeline. This test verifies that both factory and
 * legacy paths produce equivalent behavior across the full feature set.
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

  if (q.includes('"investments"')) return [];
  if (q.includes('"things"')) return [];
  if (q.includes("from proposed_claims") || q.includes("proposed_claims")) return [];
  if (q.includes("claim_record_links")) return [];
  if (q.includes("update investments") || q.includes("update entity")) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

const VALID_ITEM = {
  id: "inv0000001",
  companyId: "anthropic",
  investorId: "google",
  roundName: "Series C",
  date: "2024-01-15",
  amount: 1000000000,
  source: "https://example.org/investment",
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("investments — feature flag migration", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    resetStores();
    entitiesStore.set("anthropic", { id: "anthropic", stable_id: "sidAnthropic" });
    entitiesStore.set("google", { id: "google", stable_id: "sidGoogle" });
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
      const res = await postJson(app, "/api/investments/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        upserted: 1,
        verdictsWritten: 0,
        claimsLinked: 0,
      });
    });

    it("legacy mode returns 200 with the same fields", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!investments");
      _resetFlagCache();
      const res = await postJson(app, "/api/investments/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      expect(body.verdictsWritten).toBe(0);
      expect(body.claimsLinked).toBe(0);
    });
  });

  describe("natural key collision", () => {
    it("factory mode: rejects duplicate (companyId, investorId, roundName)", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/investments/sync", {
        items: [
          VALID_ITEM,
          { ...VALID_ITEM, id: "inv0000002" }, // same composite key
        ],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("anthropic::google::Series C");
    });

    it("legacy mode: rejects duplicate with descriptive message", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!investments");
      _resetFlagCache();
      const res = await postJson(app, "/api/investments/sync", {
        items: [
          VALID_ITEM,
          { ...VALID_ITEM, id: "inv0000002" },
        ],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("companyId=anthropic");
    });
  });

  describe("FK validation", () => {
    it("factory mode: rejects unknown companyId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/investments/sync", {
        items: [{ ...VALID_ITEM, companyId: "nonexistent-co" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-co");
    });

    it("factory mode: rejects unknown investorId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/investments/sync", {
        items: [{ ...VALID_ITEM, investorId: "nonexistent-investor" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-investor");
    });

    it("legacy mode: rejects unknown investorId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!investments");
      _resetFlagCache();
      const res = await postJson(app, "/api/investments/sync", {
        items: [{ ...VALID_ITEM, investorId: "nonexistent-investor" }],
      });
      expect(res.status).toBe(400);
    });
  });

  describe("malformed input", () => {
    it("rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/investments/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/investments/sync", {
        items: [{ id: "inv0000001" }], // missing companyId, investorId
      });
      expect(res.status).toBe(400);
    });
  });
});
