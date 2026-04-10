/**
 * Phase 2 migration test for policy-stakeholders.ts.
 *
 * Verifies that:
 *   1. Factory and legacy handlers produce equivalent behavior on the happy path
 *   2. The feature flag correctly routes between factory and legacy
 *   3. Entity FK validation works in both paths (policyEntityId only;
 *      stakeholderEntityId is optional and intentionally unvalidated)
 *   4. Invalid input is rejected with 400 in both paths
 *
 * Tier 3 route with things dual-write: factory handles the per-item loop and
 * the things sync (resolveEntityTitles + upsertThingsInTx) via toThing.
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

  // resolveEntityTitles — select stable_id/id/title from entities where ...
  if (q.includes("from entities") && q.includes("title")) {
    return [];
  }

  if (q.includes('"policy_stakeholders"')) return [];
  if (q.includes('"things"')) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

const VALID_ITEM = {
  id: "ps00000001",
  policyEntityId: "california-sb1047",
  stakeholderEntityId: null,
  stakeholderDisplayName: "Example Org",
  position: "support" as const,
  importance: "high" as const,
  reason: "Supports AI safety regulation",
  source: "https://example.org/statement",
  context: ["ai-safety", "regulation"],
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("policy-stakeholders — feature flag migration", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    resetStores();
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
      const res = await postJson(
        app,
        "/api/policy-stakeholders/sync",
        VALID_BATCH,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        upserted: 1,
        verdictsWritten: 0,
        claimsLinked: 0,
      });
    });

    it("legacy mode returns 200 with legacy response shape", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!policy-stakeholders");
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/policy-stakeholders/sync",
        VALID_BATCH,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      expect(Object.keys(body)).toEqual(["upserted"]);
    });
  });

  describe("FK validation — policyEntityId", () => {
    it("factory mode: rejects unknown policyEntityId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/policy-stakeholders/sync", {
        items: [{ ...VALID_ITEM, policyEntityId: "nonexistent-policy" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-policy");
    });

    it("legacy mode: rejects unknown policyEntityId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!policy-stakeholders");
      _resetFlagCache();
      const res = await postJson(app, "/api/policy-stakeholders/sync", {
        items: [{ ...VALID_ITEM, policyEntityId: "nonexistent-policy" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-policy");
    });

    it("factory mode: accepts unresolved stakeholderEntityId (intentionally unvalidated)", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/policy-stakeholders/sync", {
        items: [
          {
            ...VALID_ITEM,
            stakeholderEntityId: "not-yet-synced-entity",
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });
  });

  describe("malformed input", () => {
    it("factory mode: rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/policy-stakeholders/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("legacy mode: rejects invalid JSON", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!policy-stakeholders");
      _resetFlagCache();
      const res = await app.request("/api/policy-stakeholders/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/policy-stakeholders/sync", {
        items: [{ id: "ps00000001" }], // missing policyEntityId, stakeholderDisplayName, position
      });
      expect(res.status).toBe(400);
    });
  });
});
