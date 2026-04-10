/**
 * Phase 2 migration test for research-areas.ts.
 *
 * Only the main /sync endpoint is migrated. This test verifies that both
 * factory and legacy paths produce equivalent behavior on the happy path,
 * reject malformed JSON, and reject items missing required fields.
 *
 * research-areas has no entity FK validation, no claim validation, no
 * verdicts — it's a straightforward Tier 2 route with a things dual-write.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockDbModule, postJson } from "./test-utils.js";
import { _resetFlagCache } from "../routes/tablebase/sync-factory-flag.js";

function dispatch(_query: string, _params: unknown[]): unknown[] {
  // research-areas /sync only writes to research_areas and things — both
  // are side-effect inserts that return nothing the test needs to inspect.
  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Test fixtures ----

const VALID_ITEM = {
  id: "interpretability",
  title: "Interpretability",
  description: "Understanding how neural networks work internally",
  status: "active" as const,
  cluster: "alignment",
  tags: ["alignment", "interpretability"],
  metadata: {},
  source: "https://example.org/interp",
};

const VALID_BATCH = { items: [VALID_ITEM] };

describe("research-areas — feature flag migration", () => {
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
      const res = await postJson(app, "/api/research-areas/sync", VALID_BATCH);
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
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!research-areas");
      _resetFlagCache();
      const res = await postJson(app, "/api/research-areas/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Legacy handler returns only `{ upserted }`
      expect(body.upserted).toBe(1);
      expect(Object.keys(body)).toEqual(["upserted"]);
    });

    it("factory mode handles multiple items in a single batch", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/research-areas/sync", {
        items: [
          VALID_ITEM,
          { ...VALID_ITEM, id: "scalable-oversight", title: "Scalable Oversight" },
          { ...VALID_ITEM, id: "evaluations", title: "Evaluations" },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(3);
    });
  });

  describe("malformed input", () => {
    it("factory mode rejects invalid JSON", async () => {
      _resetFlagCache();
      const res = await app.request("/api/research-areas/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("factory mode rejects items missing required fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/research-areas/sync", {
        items: [{ id: "missing-title" }], // missing required `title`
      });
      expect(res.status).toBe(400);
    });

    it("legacy mode rejects items missing required fields", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!research-areas");
      _resetFlagCache();
      const res = await postJson(app, "/api/research-areas/sync", {
        items: [{ id: "missing-title" }],
      });
      expect(res.status).toBe(400);
    });

    it("factory mode rejects items with empty batch", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/research-areas/sync", { items: [] });
      expect(res.status).toBe(400);
    });
  });

  describe("inclusion mode", () => {
    it("falls back to legacy when research-areas not in inclusion list", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "personnel,divisions");
      _resetFlagCache();
      const res = await postJson(app, "/api/research-areas/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Legacy shape (only `upserted`)
      expect(Object.keys(body)).toEqual(["upserted"]);
    });
  });
});
