/**
 * Phase 2 migration test for secondary-market-prices.ts.
 *
 * This route exercises the factory's COMPOSITE conflict target support
 * (`conflictTarget: [col1, col2, col3, col4]`). The unique key for upserts
 * is (companyId, platform, date, priceType), not the row id. This is the
 * first Phase 2 migration to use a composite conflict target.
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

  if (q.includes('"secondary_market_prices"')) return [];
  if (q.includes('"things"')) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

const VALID_ITEM = {
  id: "smp0000001",
  companyId: "anthropic",
  platform: "forge" as const,
  date: "2024-01-15",
  priceType: "last_trade" as const,
  pricePerShare: 42.5,
  impliedValuation: 18_000_000_000,
  volume: 1000,
  source: "https://forge.example/anthropic",
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("secondary-market-prices — feature flag migration", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    resetStores();
    entitiesStore.set("anthropic", { id: "anthropic", stable_id: "sidAnthropic" });
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
      const res = await postJson(app, "/api/secondary-market-prices/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      expect(body.verdictsWritten).toBe(0);
    });

    it("legacy mode returns 200 with same shape", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!secondary-market-prices");
      _resetFlagCache();
      const res = await postJson(app, "/api/secondary-market-prices/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("accepts a batch with multiple items", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/secondary-market-prices/sync", {
        items: [
          VALID_ITEM,
          { ...VALID_ITEM, id: "smp0000002", platform: "hiive" as const },
          { ...VALID_ITEM, id: "smp0000003", date: "2024-01-16" },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(3);
    });
  });

  describe("FK validation", () => {
    it("factory mode: rejects unknown companyId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/secondary-market-prices/sync", {
        items: [{ ...VALID_ITEM, companyId: "ghost-co" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("ghost-co");
    });

    it("legacy mode: rejects unknown companyId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!secondary-market-prices");
      _resetFlagCache();
      const res = await postJson(app, "/api/secondary-market-prices/sync", {
        items: [{ ...VALID_ITEM, companyId: "ghost-co" }],
      });
      expect(res.status).toBe(400);
    });
  });

  describe("schema validation", () => {
    it("rejects invalid platform enum", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/secondary-market-prices/sync", {
        items: [{ ...VALID_ITEM, platform: "not-a-platform" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid priceType enum", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/secondary-market-prices/sync", {
        items: [{ ...VALID_ITEM, priceType: "made-up" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/secondary-market-prices/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });
  });
});
