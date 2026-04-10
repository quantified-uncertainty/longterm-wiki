/**
 * Phase 2 migration test for website-sources.ts (Batch D).
 *
 * Verifies that:
 *   1. Factory and legacy handlers produce equivalent behavior on the happy path
 *   2. The feature flag correctly routes between factory and legacy
 *   3. Entity FK validation works in both paths (nullable entityId)
 *   4. Invalid input is rejected with 400 in both paths
 *
 * Tier 3 route: factory converts the per-item loop into a batched upsert.
 *
 * Only the main /sync endpoint is migrated. The secondary /sync-pages
 * endpoint (which syncs website_source_pages, a different table) remains
 * hand-rolled.
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

  if (q.includes('"website_sources"')) return [];
  if (q.includes('"things"')) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

const VALID_ITEM = {
  id: "ws00000001",
  domain: "anthropic.com",
  entityId: "anthropic",
  entityDisplayName: "Anthropic",
  reliability: "high" as const,
  refreshIntervalDays: 30,
  enabled: true,
  notes: null,
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("website-sources — feature flag migration", () => {
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

  describe("happy path", () => {
    it("factory mode (default) returns 200", async () => {
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/website-sources/sync",
        VALID_BATCH,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("legacy mode returns 200 with legacy response shape", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!website-sources");
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/website-sources/sync",
        VALID_BATCH,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      // Legacy handler returns only { upserted }, no factory fields
      expect(Object.keys(body)).toEqual(["upserted"]);
    });

    it("accepts a batch with multiple items", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/website-sources/sync", {
        items: [
          VALID_ITEM,
          { ...VALID_ITEM, id: "ws00000002", domain: "openai.com" },
          { ...VALID_ITEM, id: "ws00000003", domain: "deepmind.google" },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(3);
    });
  });

  describe("FK validation", () => {
    it("factory mode: rejects unknown entityId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/website-sources/sync", {
        items: [{ ...VALID_ITEM, entityId: "ghost-co" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("ghost-co");
    });

    it("legacy mode: rejects unknown entityId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!website-sources");
      _resetFlagCache();
      const res = await postJson(app, "/api/website-sources/sync", {
        items: [{ ...VALID_ITEM, entityId: "ghost-co" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("ghost-co");
    });

    it("factory mode: accepts null entityId (nullable FK)", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/website-sources/sync", {
        items: [{ ...VALID_ITEM, entityId: null }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("legacy mode: accepts null entityId (nullable FK)", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!website-sources");
      _resetFlagCache();
      const res = await postJson(app, "/api/website-sources/sync", {
        items: [{ ...VALID_ITEM, entityId: null }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });
  });

  describe("schema validation", () => {
    it("factory mode: rejects invalid reliability enum", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/website-sources/sync", {
        items: [{ ...VALID_ITEM, reliability: "ultra-high" }],
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/website-sources/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("legacy mode: rejects invalid JSON", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!website-sources");
      _resetFlagCache();
      const res = await app.request("/api/website-sources/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/website-sources/sync", {
        items: [{ id: "ws00000001" }], // missing domain
      });
      expect(res.status).toBe(400);
    });
  });
});
