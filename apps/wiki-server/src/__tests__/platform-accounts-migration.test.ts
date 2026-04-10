/**
 * Phase 2 migration test for platform-accounts.ts.
 *
 * This route exercises the factory's composite `conflictTarget` +
 * `conflictSet` (COALESCE-preservation) escape hatch. The unique key is
 * (platform, platformUsername), not the row id. platform_accounts uses a
 * bigserial `id` PK — items omit `id` entirely and the DB assigns it on
 * insert.
 *
 * Note: the legacy handler returned HTTP 201 with `{ upserted }`, while the
 * factory returns 200 with `{ upserted, verdictsWritten, claimsLinked }`. This
 * test asserts on both shapes separately in their respective modes.
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

  // Legacy handler uses .returning({ id }) — return a fake row per inserted item
  if (q.includes('"platform_accounts"') && q.includes("returning")) {
    // Drizzle INSERT with returning — synthesize one row per VALUES tuple.
    // postgres.js interpolates params one per placeholder; for a 6-column
    // item schema (platform, platformUsername, platformUserId, entityStableId,
    // displayName, profileUrl) that's 6 params per row.
    const rowCount = Math.max(1, Math.floor(params.length / 6));
    return Array.from({ length: rowCount }, (_, i) => ({ id: i + 1 }));
  }

  if (q.includes('"platform_accounts"')) return [];

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

const VALID_ITEM = {
  platform: "github" as const,
  platformUsername: "octocat",
  platformUserId: "583231",
  entityStableId: "sidOctocat",
  displayName: "The Octocat",
  profileUrl: "https://github.com/octocat",
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("platform-accounts — feature flag migration", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    resetStores();
    entitiesStore.set("octocat", { id: "octocat", stable_id: "sidOctocat" });
    entitiesStore.set("dependabot", { id: "dependabot", stable_id: "sidDependabot" });
    _resetFlagCache();
    app = await createApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetFlagCache();
  });

  describe("happy path", () => {
    it("factory mode (default) returns 200 with standard sync response shape", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/platform-accounts/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        upserted: 1,
        verdictsWritten: 0,
        claimsLinked: 0,
      });
    });

    it("legacy mode returns 201 with { upserted }", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!platform-accounts");
      _resetFlagCache();
      const res = await postJson(app, "/api/platform-accounts/sync", VALID_BATCH);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("factory mode accepts multiple items with composite key", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/platform-accounts/sync", {
        items: [
          VALID_ITEM,
          { ...VALID_ITEM, platformUsername: "dependabot", entityStableId: "sidDependabot" },
          { ...VALID_ITEM, platform: "twitter" as const, platformUsername: "octocat_tw" },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(3);
    });

    it("factory mode accepts items without entityStableId (unlinked accounts)", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/platform-accounts/sync", {
        items: [
          {
            platform: "github" as const,
            platformUsername: "unknown-user",
            displayName: "Unknown",
            // entityStableId omitted — account is unlinked
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });
  });

  describe("entity FK validation", () => {
    it("factory mode: rejects unknown entityStableId", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/platform-accounts/sync", {
        items: [{ ...VALID_ITEM, entityStableId: "sidGhost" }],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("sidGhost");
    });

    it("legacy mode: rejects unknown entityStableId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!platform-accounts");
      _resetFlagCache();
      const res = await postJson(app, "/api/platform-accounts/sync", {
        items: [{ ...VALID_ITEM, entityStableId: "sidGhost" }],
      });
      expect(res.status).toBe(400);
    });
  });

  describe("schema validation", () => {
    it("factory mode rejects invalid platform enum", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/platform-accounts/sync", {
        items: [{ ...VALID_ITEM, platform: "not-a-real-platform" }],
      });
      expect(res.status).toBe(400);
    });

    it("factory mode rejects empty platformUsername", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/platform-accounts/sync", {
        items: [{ ...VALID_ITEM, platformUsername: "" }],
      });
      expect(res.status).toBe(400);
    });

    it("factory mode rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/platform-accounts/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });
  });
});
