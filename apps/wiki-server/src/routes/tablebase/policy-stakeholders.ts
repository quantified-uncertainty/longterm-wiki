import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { policyStakeholders } from "../../schema.js";
import {
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { resolveEntityId, type ResolvedEntityVars } from "../shared/resolve-entity-middleware.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";
import { InlineSourcingSchema } from "./sourcing-schema.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const VALID_POSITIONS = ["support", "oppose", "neutral", "mixed"] as const;

// ---- Schemas ----

const VALID_IMPORTANCE = ["high", "medium", "low"] as const;

const SyncStakeholderItemSchema = z.object({
  id: z.string().length(10),
  policyEntityId: z.string().min(1).max(200),
  stakeholderEntityId: z.string().max(200).nullable().optional(),
  stakeholderDisplayName: z.string().min(1).max(500),
  position: z.enum(VALID_POSITIONS),
  importance: z.enum(VALID_IMPORTANCE).nullable().optional(),
  reason: z.string().max(5000).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  context: z.array(z.string()).nullable().optional(),
  sourcing: InlineSourcingSchema.optional(),
});

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
  .post("/sync", createSyncHandler({
    name: "policy-stakeholders",
    table: policyStakeholders,
    syncSchema: SyncStakeholderItemSchema,
    enforceSourcing: true,
    entityRefs: ["policyEntityId"],
    // QUA-507: pointer-only things write.
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
