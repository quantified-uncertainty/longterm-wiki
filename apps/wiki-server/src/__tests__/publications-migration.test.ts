/**
 * Phase 2 Batch C migration test for publications.ts.
 *
 * publications.ts has inline source-check verdict support (`toVerdict`), so
 * the factory response includes verdictsWritten while legacy returns
 * `{ upserted, verdictsWritten }` (no claimsLinked). Tests verify both paths
 * on the happy path, FK validation, and malformed input.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockDbModule, postJson } from "./test-utils.js";
import { _resetFlagCache } from "../routes/tablebase/sync-factory-flag.js";

// ---- In-memory stores ----

let entitiesStore: Map<string, Record<string, unknown>>;

function resetStores() {
  entitiesStore = new Map();
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- validate-entity-refs ---
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

  // --- resolveEntityTitles: select ... from "entities" ---
  if (q.includes('from "entities"')) return [];

  // --- publications: insert/update ---
  if (q.includes('"publications"') || q.includes("publications")) return [];

  // --- things: insert/delete ---
  if (q.includes('"things"')) return [];

  // --- source_check_verdicts / source_check_evidence (raw SQL, won't fire
  //     unless item.sourcing is present; test data passes no sourcing) ---
  if (q.includes("source_check_verdicts") || q.includes("source_check_evidence")) {
    return [];
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Test fixtures ----

const VALID_ITEM = {
  id: "pub0000001",
  entityId: "anthropic",
  entityDisplayName: "Anthropic",
  title: "Constitutional AI: Harmlessness from AI Feedback",
  authors: "Bai et al.",
  url: "https://arxiv.org/abs/2212.08073",
  venue: "arXiv",
  publishedDate: "2022-12",
  publicationType: "preprint" as const,
  citationCount: 500,
  isFlagship: true,
  abstract: "Constitutional AI approach to training helpful assistants.",
  source: "https://arxiv.org/abs/2212.08073",
};

const VALID_BATCH = { items: [VALID_ITEM] };

const INVALID_FK_BATCH = {
  items: [
    {
      ...VALID_ITEM,
      entityId: "nonexistent-entity",
    },
  ],
};

// ---------------------------------------------------------------------------

describe("publications — feature flag migration", () => {
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

  describe("happy path — factory ON (default)", () => {
    it("returns 200 with upserted count and factory fields", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/publications/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      // Factory always emits these three fields
      expect(body).toHaveProperty("verdictsWritten");
      expect(body.verdictsWritten).toBe(0);
      expect(body).toHaveProperty("claimsLinked");
    });
  });

  describe("happy path — legacy fallback (USE_SYNC_FACTORY_ROUTES=!publications)", () => {
    it("returns 200 with upserted + verdictsWritten (no claimsLinked)", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!publications");
      _resetFlagCache();
      const res = await postJson(app, "/api/publications/sync", VALID_BATCH);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
      expect(body.verdictsWritten).toBe(0);
      // Legacy does NOT include claimsLinked
      expect(body).not.toHaveProperty("claimsLinked");
    });
  });

  describe("FK validation — factory ON", () => {
    it("returns 400 for invalid entityId", async () => {
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/publications/sync",
        INVALID_FK_BATCH,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-entity");
    });
  });

  describe("FK validation — legacy fallback", () => {
    it("returns 400 for invalid entityId", async () => {
      vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "!publications");
      _resetFlagCache();
      const res = await postJson(
        app,
        "/api/publications/sync",
        INVALID_FK_BATCH,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-entity");
    });
  });

  describe("malformed input", () => {
    it("rejects invalid JSON in factory mode", async () => {
      _resetFlagCache();
      const res = await app.request("/api/publications/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("rejects items missing required fields in factory mode", async () => {
      _resetFlagCache();
      const res = await postJson(app, "/api/publications/sync", {
        items: [{ id: "pub0000001" }], // missing entityId, title
      });
      expect(res.status).toBe(400);
    });
  });
});
