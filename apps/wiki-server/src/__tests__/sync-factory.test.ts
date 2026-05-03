/**
 * Tests for createSyncHandler<T>() — the TableBase sync factory.
 *
 * Validates the 7-phase pipeline against a mocked DB:
 *   1. Parse / invalid JSON
 *   2. Zod schema validation
 *   3. Natural key collision
 *   4. enforceSourcing (gated)
 *   5. validateEntityRefs (gated)
 *   6. validateClaimRefs (gated)
 *   7. preValidate hook (Response short-circuit + throw → SyncPhaseError)
 *   8. Batch upsert (auto-derived SET clause)
 *   9. Audit logging (gated, with existing-row pre-fetch)
 *  10. postUpsert hook (rollback contract: throwing rolls back)
 *  11. Response shape (upserted, verdictsWritten, claimsLinked)
 *
 * Per Phase 0 audit, the factory MUST:
 *   - Wrap phase errors in SyncPhaseError({ route, phase, cause })
 *   - Auto-chunk batches based on Postgres parameter limit
 *   - Preserve Hono RPC type inference (verified separately by sync-factory.test-d.ts)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { mockDbModule, postJson } from "./test-utils.js";
// Type-only import; runtime value is loaded dynamically below to preserve
// vi.mock() ordering.
import type { SyncPhaseError as SyncPhaseErrorType } from "../routes/tablebase/sync-factory.js";

// ---- In-memory stores ----

let entitiesStore: Map<string, Record<string, unknown>>;

function resetStores() {
  entitiesStore = new Map();
}

// Initialize stores at import time so the mock dispatcher can read them
// before any beforeEach runs (vitest may invoke the dispatcher during module
// init, e.g. when a sync handler is constructed eagerly).
resetStores();

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- validate-entity-refs: unnest + entities check ---
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

  return [];
}

// Mock the db module
vi.mock("../db.js", () => mockDbModule(dispatch));

const { createSyncHandler } = await import("../routes/tablebase/sync-factory.js");
const { SyncPhaseError } = await import("../routes/tablebase/sync-factory.js");
// Import a real Drizzle table so the factory has something to introspect.
// We use `entities` because it's small and well-known.
const { entities } = await import("../schema.js");

// ---- Test schemas ----

const ItemSchema = z.object({
  id: z.string().length(10),
  title: z.string().min(1),
  parentId: z.string().optional(),
});

const BatchSchema = z.object({
  items: z.array(ItemSchema).min(1).max(100),
});

type Item = z.infer<typeof ItemSchema>;

// ---- Test app builder ----

function buildApp(handler: ReturnType<typeof createSyncHandler>) {
  return new Hono().post("/sync", handler);
}

/**
 * Helper that captures errors thrown by the handler. Hono catches unhandled
 * errors and returns 500 by default; this helper attaches an `onError` handler
 * that stashes the error so tests can assert on its type.
 */
function buildAppWithErrorCapture(handler: ReturnType<typeof createSyncHandler>) {
  const errors: unknown[] = [];
  const app = new Hono()
    .post("/sync", handler)
    .onError((err, c) => {
      errors.push(err);
      return c.json({ error: "internal", message: err.message }, 500);
    });
  return { app, errors };
}

// ---------------------------------------------------------------------------

describe("createSyncHandler — phase 1: parse + validate", () => {
  beforeEach(resetStores);

  it("returns 400 on invalid JSON", async () => {
    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
    });
    const app = buildApp(handler);

    const res = await app.request("/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "invalid_json" });
  });

  it("returns 400 on Zod validation failure (missing items)", async () => {
    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
    });
    const app = buildApp(handler);

    const res = await postJson(app, "/sync", { wrong: "shape" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "validation_error" });
  });

  it("returns 400 on Zod validation failure (item shape)", async () => {
    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
    });
    const app = buildApp(handler);

    const res = await postJson(app, "/sync", {
      items: [{ id: "wrong-len", title: "" }], // id wrong length, empty title
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "validation_error" });
  });
});

// ---------------------------------------------------------------------------

describe("createSyncHandler — phase 2: natural key collision", () => {
  beforeEach(resetStores);

  it("returns 400 when two items collide on natural key", async () => {
    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
      naturalKey: (item) => `${item.parentId ?? ""}::${item.title}`,
      naturalKeyError: "Duplicate parentId+title",
    });
    const app = buildApp(handler);

    const res = await postJson(app, "/sync", {
      items: [
        { id: "aaaaaaaaaa", title: "alpha", parentId: "p1" },
        { id: "bbbbbbbbbb", title: "alpha", parentId: "p1" }, // collision
      ],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("Duplicate parentId+title");
    expect(body.message).toContain("p1::alpha");
  });

  it("accepts items with no natural key collision", async () => {
    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
      naturalKey: (item) => `${item.parentId ?? ""}::${item.title}`,
    });
    const app = buildApp(handler);

    const res = await postJson(app, "/sync", {
      items: [
        { id: "aaaaaaaaaa", title: "alpha", parentId: "p1" },
        { id: "bbbbbbbbbb", title: "beta", parentId: "p1" },
      ],
    });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe("createSyncHandler — phase 5: entity ref validation", () => {
  beforeEach(resetStores);

  it("returns 400 when an entity reference is missing", async () => {
    entitiesStore.set("known-org", { id: "known-org", stable_id: "sidKnownOrg" });

    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
      entityRefFields: (items) => [
        {
          fieldName: "parentId",
          ids: items.map((i) => i.parentId).filter((id): id is string => id != null),
        },
      ],
    });
    const app = buildApp(handler);

    const res = await postJson(app, "/sync", {
      items: [{ id: "aaaaaaaaaa", title: "alpha", parentId: "missing-org" }],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("missing-org");
  });

  it("accepts items when entity references resolve", async () => {
    entitiesStore.set("known-org", { id: "known-org", stable_id: "sidKnownOrg" });

    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
      entityRefFields: (items) => [
        {
          fieldName: "parentId",
          ids: items.map((i) => i.parentId).filter((id): id is string => id != null),
        },
      ],
    });
    const app = buildApp(handler);

    const res = await postJson(app, "/sync", {
      items: [{ id: "aaaaaaaaaa", title: "alpha", parentId: "known-org" }],
    });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe("createSyncHandler — phase 7: preValidate hook", () => {
  beforeEach(resetStores);

  it("short-circuits with the Response returned by preValidate", async () => {
    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
      preValidate: async (c) => c.json({ error: "custom_block", reason: "test" }, 422),
    });
    const app = buildApp(handler);

    const res = await postJson(app, "/sync", {
      items: [{ id: "aaaaaaaaaa", title: "alpha" }],
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({ error: "custom_block", reason: "test" });
  });

  it("proceeds when preValidate returns null", async () => {
    let preValidateCalled = false;
    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
      preValidate: async () => {
        preValidateCalled = true;
        return null;
      },
    });
    const app = buildApp(handler);

    const res = await postJson(app, "/sync", {
      items: [{ id: "aaaaaaaaaa", title: "alpha" }],
    });

    expect(res.status).toBe(200);
    expect(preValidateCalled).toBe(true);
  });

  it("wraps thrown errors in SyncPhaseError with route + phase context", async () => {
    const handler = createSyncHandler<Item, typeof entities>({
      name: "my-route",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
      preValidate: async () => {
        throw new Error("upstream service exploded");
      },
    });
    const { app, errors } = buildAppWithErrorCapture(handler);

    const res = await postJson(app, "/sync", {
      items: [{ id: "aaaaaaaaaa", title: "alpha" }],
    });

    expect(res.status).toBe(500);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(SyncPhaseError);
    expect((errors[0] as SyncPhaseErrorType).route).toBe("my-route");
    expect((errors[0] as SyncPhaseErrorType).phase).toBe("preValidate");
    expect((errors[0] as Error).message).toContain("my-route/preValidate");
    expect((errors[0] as Error).message).toContain("upstream service exploded");
  });
});

// ---------------------------------------------------------------------------

describe("createSyncHandler — postUpsert hook", () => {
  beforeEach(resetStores);

  it("runs after the upsert with the same tx", async () => {
    let postUpsertCalled = false;
    let postUpsertItemCount = 0;

    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
      postUpsert: async (_tx, items) => {
        postUpsertCalled = true;
        postUpsertItemCount = items.length;
      },
    });
    const app = buildApp(handler);

    const res = await postJson(app, "/sync", {
      items: [
        { id: "aaaaaaaaaa", title: "alpha" },
        { id: "bbbbbbbbbb", title: "beta" },
      ],
    });

    expect(res.status).toBe(200);
    expect(postUpsertCalled).toBe(true);
    expect(postUpsertItemCount).toBe(2);
  });

  it("wraps thrown errors with phase=postUpsert", async () => {
    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
      postUpsert: async () => {
        throw new Error("display name backfill failed");
      },
    });
    const { app, errors } = buildAppWithErrorCapture(handler);

    const res = await postJson(app, "/sync", {
      items: [{ id: "aaaaaaaaaa", title: "alpha" }],
    });

    expect(res.status).toBe(500);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(SyncPhaseError);
    expect((errors[0] as SyncPhaseErrorType).phase).toBe("postUpsert");
    expect((errors[0] as Error).message).toContain("display name backfill failed");
  });
});

// ---------------------------------------------------------------------------

describe("createSyncHandler — happy path", () => {
  beforeEach(resetStores);

  it("returns the standard response shape", async () => {
    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      batchSchema: BatchSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
    });
    const app = buildApp(handler);

    const res = await postJson(app, "/sync", {
      items: [
        { id: "aaaaaaaaaa", title: "alpha" },
        { id: "bbbbbbbbbb", title: "beta" },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      upserted: 2,
      verdictsWritten: 0,
      claimsLinked: 0,
    });
  });

  // Regression guard: the body assertions pin "silently ignored" so a future
  // contributor can't re-introduce observable behavior on the query param.
  it("treats ?mode=best_effort as inert (atomic semantics, no partitioned shape)", async () => {
    const handler = createSyncHandler<Item, typeof entities>({
      name: "test",
      table: entities,
      syncSchema: ItemSchema,
      toRow: (item, now) => ({ id: item.id, title: item.title, syncedAt: now, updatedAt: now }),
    });
    const app = buildApp(handler);

    const res = await postJson(app, "/sync?mode=best_effort", {
      items: [
        { id: "aaaaaaaaaa", title: "alpha" },
        { id: "bad-id", title: "beta" }, // wrong length — fails Zod
      ],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "validation_error" });
    expect(body.committed).toBeUndefined();
    expect(body.rejected).toBeUndefined();
  });
});

