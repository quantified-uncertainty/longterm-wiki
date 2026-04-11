/**
 * Tests for the coverage-scans sync handler configuration.
 *
 * Uses the same pattern as sync-factory.test.ts: tests the createSyncHandler
 * factory with the coverage-scans-specific config (entityRefFields, naturalKey,
 * conflictTarget) against a mocked DB using the `entities` table as a stand-in.
 *
 * Validates:
 *   1. Happy path: sync valid items -> upserted count
 *   2. FK-invalid: sync with nonexistent entityId -> 400
 *   3. Natural key collision: duplicate entityId in batch -> 400
 *   4. Schema validation: missing required fields -> 400
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores ----

let entitiesStore: Map<string, Record<string, unknown>>;

function resetStores() {
  entitiesStore = new Map();
}

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

  // --- INSERT (upsert) ---
  if (q.includes("insert into")) {
    return [];
  }

  return [];
}

// Mock the db module
vi.mock("../db.js", () => mockDbModule(dispatch));

const { createSyncHandler } = await import(
  "../routes/tablebase/sync-factory.js"
);
// Use `entities` table as stand-in — same pattern as sync-factory.test.ts.
// The actual Drizzle table columns are introspected at build time;
// what matters for the test is the factory pipeline behavior.
const { entities } = await import("../schema.js");

// ---- Schemas (mirror from coverage-scans route) ----

const SyncItemSchema = z.object({
  id: z.string().optional(), // Satisfies factory TItem constraint
  entityType: z.string().min(1).max(100),
  entityId: z.string().min(1).max(200),
  coverageScore: z.number().int().min(1).max(4),
  signalsFilled: z.number().int().min(0).default(0),
  signalsTotal: z.number().int().min(0).default(0),
  signals: z.record(z.boolean()).default({}),
  scannedAt: z.string().datetime().optional(),
});

type SyncItem = z.infer<typeof SyncItemSchema>;

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(2000),
});

// ---- Build test app with factory config matching the real route ----

function buildApp() {
  // Use type assertion on batchSchema to work around Zod .default() making
  // input types optional while output types are required. The factory's
  // ZodType constraint checks against the output shape.
  const handler = createSyncHandler<SyncItem, typeof entities>({
    name: "coverage-scans",
    table: entities,
    batchSchema: SyncBatchSchema as z.ZodType<{ items: SyncItem[] }>,
    toRow: (item, now) => ({
      id: item.entityId, // entities table expects id column
      entityType: item.entityType,
      coverageScore: item.coverageScore,
      signalsFilled: item.signalsFilled,
      signalsTotal: item.signalsTotal,
      signals: item.signals,
      scannedAt: item.scannedAt ? new Date(item.scannedAt) : now,
      updatedAt: now,
    }),
    naturalKey: (item) => item.entityId,
    naturalKeyError: "Duplicate entityId in batch",
    entityRefFields: (items) => [
      { fieldName: "entityId", ids: items.map((i) => i.entityId) },
    ],
  });
  return new Hono().post("/sync", handler);
}

// ---------------------------------------------------------------------------

describe("coverage-scans sync handler", () => {
  beforeEach(() => {
    resetStores();
    // Seed with known entities (matched by stable_id)
    entitiesStore.set("anthropic", {
      id: "anthropic",
      stable_id: "sid_abc1234567",
      title: "Anthropic",
    });
    entitiesStore.set("openai", {
      id: "openai",
      stable_id: "sid_def7654321",
      title: "OpenAI",
    });
  });

  it("returns upserted count on valid sync", async () => {
    const app = buildApp();

    const res = await postJson(app, "/sync", {
      items: [
        {
          entityType: "organization",
          entityId: "sid_abc1234567",
          coverageScore: 3,
          signalsFilled: 4,
          signalsTotal: 7,
          signals: { revenue: true, headcount: true, valuation: false },
        },
        {
          entityType: "organization",
          entityId: "sid_def7654321",
          coverageScore: 2,
          signalsFilled: 2,
          signalsTotal: 7,
          signals: { revenue: false, headcount: true },
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toBe(2);
  });

  it("returns 400 when entityId does not exist", async () => {
    const app = buildApp();

    const res = await postJson(app, "/sync", {
      items: [
        {
          entityType: "organization",
          entityId: "nonexistent_entity_id",
          coverageScore: 2,
          signalsFilled: 1,
          signalsTotal: 5,
          signals: {},
        },
      ],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
  });

  it("returns 400 on duplicate entityId in batch", async () => {
    const app = buildApp();

    const res = await postJson(app, "/sync", {
      items: [
        {
          entityType: "organization",
          entityId: "sid_abc1234567",
          coverageScore: 3,
          signalsFilled: 4,
          signalsTotal: 7,
          signals: {},
        },
        {
          entityType: "organization",
          entityId: "sid_abc1234567",
          coverageScore: 2,
          signalsFilled: 2,
          signalsTotal: 7,
          signals: {},
        },
      ],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("Duplicate entityId in batch");
  });

  it("returns 400 on invalid schema (missing required fields)", async () => {
    const app = buildApp();

    const res = await postJson(app, "/sync", {
      items: [
        {
          entityType: "organization",
          // missing entityId and coverageScore
        },
      ],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
  });
});
