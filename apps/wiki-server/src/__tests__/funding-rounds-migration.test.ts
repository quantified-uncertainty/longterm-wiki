/**
 * Phase 2 migration test for funding-rounds.ts.
 *
 * funding-rounds is a Tier 2 route that uses COALESCE preservation on its
 * entity FK columns (companyEntityId, leadInvestorEntityId) via the factory's
 * `conflictSet` escape hatch. It also exercises the factory's natural key,
 * entity FK validation, claim support, things dual-write, and verdicts.
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

  // validate-entity-refs uses unnest(...) from entities
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

  // Legacy pre-insert entity lookup: SELECT id, stable_id FROM entities WHERE id IN (...) OR stable_id IN (...)
  if (q.includes("from entities") && q.includes("stable_id")) {
    const ids = params as string[];
    const rows: Array<{ id: string; stable_id: string }> = [];
    for (const id of ids) {
      const hit = entitiesStore.get(id);
      if (hit) rows.push({ id: hit.id as string, stable_id: hit.stable_id as string });
    }
    return rows;
  }

  if (q.includes('"funding_rounds"')) return [];
  if (q.includes('"things"')) return [];
  if (q.includes("proposed_claims")) return [];
  if (q.includes("claim_record_links")) return [];
  if (q.includes("update funding_rounds") || q.includes("update entity")) return [];
  if (q.includes("source_check_verdicts")) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Test fixtures ----

const VALID_ITEM = {
  id: "fr00000001",
  companyId: "anthropic",
  name: "Series C",
  date: "2024-01-15",
  raised: 1000000000,
  valuation: 10000000000,
  leadInvestor: "google",
  source: "https://example.org/funding-round",
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("funding-rounds — feature flag migration", () => {
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
      const res = await postJson(app, "/api/funding-rounds/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        upserted: 1,
        verdictsWritten: 0,
        claimsLinked: 0,
      });
    });

    it("legacy mode returns 200 with the same core fields", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!funding-rounds");
      _resetFlagCache();
      const res = await postJson(app, "/api/funding-rounds/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      expect(body.verdictsWritten).toBe(0);
      expect(body.claimsLinked).toBe(0);
    });
  });

  describe("natural key collision", () => {
    it("factory mode: rejects duplicate (companyId, name)", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/funding-rounds/sync", {
        items: [
          VALID_ITEM,
          { ...VALID_ITEM, id: "fr00000002" }, // same (companyId, name)
        ],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("anthropic::Series C");
    });

    it("legacy mode: rejects duplicate with descriptive message", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!funding-rounds");
      _resetFlagCache();
      const res = await postJson(app, "/api/funding-rounds/sync", {
        items: [
          VALID_ITEM,
          { ...VALID_ITEM, id: "fr00000002" },
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
      const res = await postJson(app, "/api/funding-rounds/sync", {
        items: [{ ...VALID_ITEM, companyId: "nonexistent-co" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-co");
    });

    it("legacy mode: rejects unknown companyId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!funding-rounds");
      _resetFlagCache();
      const res = await postJson(app, "/api/funding-rounds/sync", {
        items: [{ ...VALID_ITEM, companyId: "nonexistent-co" }],
      });
      expect(res.status).toBe(400);
    });
  });

  describe("malformed input", () => {
    it("factory mode: rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/funding-rounds/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/funding-rounds/sync", {
        items: [{ id: "fr00000001" }], // missing companyId, name
      });
      expect(res.status).toBe(400);
    });
  });
});
