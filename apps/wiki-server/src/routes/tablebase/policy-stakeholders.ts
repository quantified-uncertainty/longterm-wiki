import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { policyStakeholders } from "../../schema.js";
import {
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { resolveEntityId, type ResolvedEntityVars } from "../shared/resolve-entity-middleware.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";
import {
  SyncStakeholderItemSchema,
  VALID_POSITIONS,
} from "./policy-stakeholders-schema.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

const ByPolicyQuery = z.object({
  position: z.enum(VALID_POSITIONS).optional(),
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

const ByStakeholderQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Route ----

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 50),
  offset: z.coerce.number().int().min(0).default(0),
});

const policyStakeholdersApp = new Hono<{ Variables: ResolvedEntityVars }>()

  // GET /all — paginated listing of all policy stakeholders
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db.select().from(policyStakeholders)
      .limit(limit)
      .offset(offset);

    const [{ count: total }] = await db.select({ count: count() }).from(policyStakeholders);

    return c.json({ policyStakeholders: rows, total, limit, offset });
  })

  // GET /by-policy/:entityId — stakeholders for a specific policy
  .get("/by-policy/:entityId", resolveEntityId(), zv("query", ByPolicyQuery), async (c) => {
    const resolvedId = c.get("resolvedEntityId");
    const { position, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const whereClause = position
      ? and(eq(policyStakeholders.policyEntityId, resolvedId), eq(policyStakeholders.position, position))
      : eq(policyStakeholders.policyEntityId, resolvedId);

    const rows = await db.select().from(policyStakeholders)
      .where(whereClause)
      .limit(limit)
      .offset(offset);

    const [{ count: total }] = await db.select({ count: count() }).from(policyStakeholders)
      .where(whereClause);

    return c.json({ stakeholders: rows, total });
  })

  // GET /by-stakeholder/:entityId — policies where this entity is a stakeholder
  .get("/by-stakeholder/:entityId", resolveEntityId(), zv("query", ByStakeholderQuery), async (c) => {
    const resolvedId = c.get("resolvedEntityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db.select().from(policyStakeholders)
      .where(eq(policyStakeholders.stakeholderEntityId, resolvedId))
      .limit(limit)
      .offset(offset);

    const [{ count: total }] = await db.select({ count: count() }).from(policyStakeholders)
      .where(eq(policyStakeholders.stakeholderEntityId, resolvedId));

    return c.json({ positions: rows, total });
  })

  // POST /sync — upsert stakeholders batch
  // Note: only policyEntityId is validated. stakeholderEntityId is optional and may
  // reference entities not yet synced to PG (build-data explicitly expects
  // some to be missing — wiki-server-data.mjs has fallback logic for this).
  //
  // Natural key: (policyEntityId, stakeholderDisplayName). Migration 0221
  // (QUA-956) added a UNIQUE index over those columns. `conflictTarget` is
  // the natural key — not the default `id` — so QUA-943 Phase 3
  // retry-with-feedback (which mints a fresh `id` when re-sending a
  // corrected payload for the same `(policy, stakeholder)` pair) resolves
  // as an UPDATE on the existing row instead of accumulating duplicates.
  .post("/sync", createSyncHandler({
    name: "policy-stakeholders",
    table: policyStakeholders,
    syncSchema: SyncStakeholderItemSchema,
    enforceSourcing: true,
    entityRefs: ["policyEntityId"],
    // QUA-958 (Phase 2 canary): opt into best-effort partial-success mode.
    // Callers POSTing `?mode=best_effort` get per-item partitioning into
    // `committed: [...ids]` / `rejected: [{idx, code, message, ...}]`. The
    // canary dispatcher (research-improve-entity) decides per-rejection what
    // to do: `code: "zod"` aborts the whole improve-entity run; `code: "fk_missing"`
    // is recorded to followup_actions and the surviving items still commit.
    bestEffortAllowed: true,
    naturalKey: (item) =>
      `${item.policyEntityId}::${item.stakeholderDisplayName}`,
    naturalKeyError:
      "Duplicate (policyEntityId, stakeholderDisplayName) in batch — each stakeholder must be unique per policy",
    conflictTarget: [
      policyStakeholders.policyEntityId,
      policyStakeholders.stakeholderDisplayName,
    ],
    // QUA-958 red-team finding #3 (advisory lock pulled forward from Phase 6):
    // serialize concurrent writes for the same `(policyEntityId, shape)` so
    // two `improve-entity FISA-702` runs can't race the natural-key UNIQUE
    // and silently discard one side's gate-approved correction. The lock is
    // released when the upsert transaction commits or rolls back. We hash the
    // composite key so a 64-bit advisory lock id fits regardless of stableId
    // length. Lives in `txStart` (not `preValidate`) because xact-scoped
    // advisory locks must be acquired inside the transaction that holds them.
    txStart: async (tx, _c, items) => {
      const entityIds = [...new Set(items.map((i) => i.policyEntityId))];
      for (const entityId of entityIds) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${entityId} || ':policy_stakeholders'))`,
        );
      }
    },
    toThing: (item) => ({
      id: item.id,
      thingType: "policy-stakeholder" as const,
      sourceTable: "policy_stakeholders",
      sourceId: item.id,
      parentThingId: item.policyEntityId,
      sourceUrl: item.source ?? null,
    }),
    toVerdict: (item) => ({
      recordType: "policy-stakeholder",
      recordId: item.id,
      entityId: item.stakeholderEntityId ?? item.policyEntityId,
      sourceUrl: item.source ?? null,
      sourcing: item.sourcing ?? null,
    }),
  }))

  .post("/delete-batch", deleteBatchHandler(policyStakeholders, "policy_stakeholders"));

export const policyStakeholdersRoute = policyStakeholdersApp;
export type PolicyStakeholdersRoute = typeof policyStakeholdersApp;
