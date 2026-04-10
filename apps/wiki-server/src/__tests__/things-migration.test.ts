/**
 * Phase 2 migration test for things.ts.
 *
 * things is the destination table for all other routes' dual-writes, so its
 * factory config deliberately omits `toThing` (the handler doesn't dual-write
 * to itself). The factory uses:
 *   - naturalKey on (sourceTable, sourceId) for intra-batch dedup
 *   - conflictTarget override [sourceTable, sourceId] (composite)
 *   - conflictSet override (to skip id, sourceTable, sourceId on update)
 *   - a `z.preprocess` schema that maps the request body's `things` key to
 *     the factory's required `items` key
 *
 * No entity FK validation, no claim support, no verdicts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockDbModule, postJson } from "./test-utils.js";
import { _resetFlagCache } from "../routes/tablebase/sync-factory-flag.js";

function dispatch(_query: string, _params: unknown[]): unknown[] {
  // things /sync only inserts into the things table; nothing to stub.
  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Test fixtures ----

const VALID_ITEM = {
  id: "anthropic",
  thingType: "entity" as const,
  title: "Anthropic",
  sourceTable: "entities",
  sourceId: "anthropic",
  entityType: "organization",
  description: "AI safety company",
  sourceUrl: "https://anthropic.com",
};

// NOTE: things /sync uses `things` as the array key, not `items`.
const VALID_BATCH = { things: [VALID_ITEM] };

describe("things — feature flag migration", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
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
      const res = await postJson(app, "/api/things/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Factory always returns upserted, verdictsWritten, claimsLinked.
      expect(body).toMatchObject({
        upserted: 1,
        verdictsWritten: 0,
        claimsLinked: 0,
      });
    });

    it("legacy mode returns 200 with the legacy shape", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!things");
      _resetFlagCache();
      const res = await postJson(app, "/api/things/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Legacy handler returns only `{ upserted }`
      expect(body.upserted).toBe(1);
      expect(Object.keys(body)).toEqual(["upserted"]);
    });

    it("factory mode handles multiple distinct items in a batch", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/things/sync", {
        things: [
          VALID_ITEM,
          {
            ...VALID_ITEM,
            id: "google",
            title: "Google",
            sourceId: "google",
          },
          {
            ...VALID_ITEM,
            id: "openai",
            title: "OpenAI",
            sourceId: "openai",
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(3);
    });
  });

  describe("natural key collision", () => {
    it("factory mode: rejects duplicate (sourceTable, sourceId)", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/things/sync", {
        things: [
          VALID_ITEM,
          { ...VALID_ITEM, id: "anthropic-dup" }, // same (sourceTable, sourceId)
        ],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("Duplicate source key in batch");
    });

    it("legacy mode: rejects duplicate with descriptive message", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!things");
      _resetFlagCache();
      const res = await postJson(app, "/api/things/sync", {
        things: [
          VALID_ITEM,
          { ...VALID_ITEM, id: "anthropic-dup" },
        ],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("Duplicate source key in batch");
    });
  });

  describe("malformed input", () => {
    it("factory mode: rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/things/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/things/sync", {
        things: [{ id: "missing-fields" }], // missing thingType, title, etc.
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects payload with unrecognized top-level key", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/things/sync", {
        data: [VALID_ITEM], // wrong key name (factory accepts both `things` and `items` via preprocess, but not `data`)
      });
      expect(res.status).toBe(400);
    });

    it("factory mode: rejects empty batch", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/things/sync", { things: [] });
      expect(res.status).toBe(400);
    });
  });

  describe("inclusion mode", () => {
    it("falls back to legacy when things not in inclusion list", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "personnel,divisions");
      _resetFlagCache();
      const res = await postJson(app, "/api/things/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Legacy shape (only `upserted`)
      expect(Object.keys(body)).toEqual(["upserted"]);
    });
  });
});
