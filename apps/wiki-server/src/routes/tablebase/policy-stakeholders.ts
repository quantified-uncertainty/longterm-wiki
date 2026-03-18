import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { policyStakeholders, entities } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "../shared/utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const VALID_POSITIONS = ["support", "oppose", "neutral", "mixed"] as const;

// ---- Schemas ----

const SyncStakeholderItemSchema = z.object({
  id: z.string().length(10),
  policyEntityId: z.string().min(1).max(200),
  stakeholderEntityId: z.string().max(200).nullable().optional(),
  stakeholderDisplayName: z.string().min(1).max(500),
  position: z.enum(VALID_POSITIONS),
  reason: z.string().max(5000).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  context: z.array(z.string()).nullable().optional(),
});

const SyncStakeholderBatchSchema = z.object({
  items: z.array(SyncStakeholderItemSchema).min(1).max(500),
});

const ByPolicyQuery = z.object({
  position: z.enum(VALID_POSITIONS).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Route ----

const policyStakeholdersApp = new Hono()

  // GET /by-policy/:entityId — stakeholders for a specific policy
  .get("/by-policy/:entityId", zv("query", ByPolicyQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { position, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    let query = db.select().from(policyStakeholders)
      .where(eq(policyStakeholders.policyEntityId, entityId))
      .limit(limit)
      .offset(offset);

    if (position) {
      query = db.select().from(policyStakeholders)
        .where(sql`${policyStakeholders.policyEntityId} = ${entityId} AND ${policyStakeholders.position} = ${position}`)
        .limit(limit)
        .offset(offset);
    }

    const rows = await query;
    const [{ count: total }] = await db.select({ count: count() }).from(policyStakeholders)
      .where(eq(policyStakeholders.policyEntityId, entityId));

    return c.json({ stakeholders: rows, total });
  })

  // GET /by-stakeholder/:entityId — policies where this entity is a stakeholder
  .get("/by-stakeholder/:entityId", zv("query", ByPolicyQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db.select().from(policyStakeholders)
      .where(eq(policyStakeholders.stakeholderEntityId, entityId))
      .limit(limit)
      .offset(offset);

    const [{ count: total }] = await db.select({ count: count() }).from(policyStakeholders)
      .where(eq(policyStakeholders.stakeholderEntityId, entityId));

    return c.json({ positions: rows, total });
  })

  // POST /sync — upsert stakeholders batch
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncStakeholderBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();
    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .insert(policyStakeholders)
          .values({
            id: item.id,
            policyEntityId: item.policyEntityId,
            stakeholderEntityId: item.stakeholderEntityId ?? null,
            stakeholderDisplayName: item.stakeholderDisplayName,
            position: item.position,
            reason: item.reason ?? null,
            source: item.source ?? null,
            context: item.context ?? null,
            syncedAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: policyStakeholders.id,
            set: {
              policyEntityId: item.policyEntityId,
              stakeholderEntityId: item.stakeholderEntityId ?? null,
              stakeholderDisplayName: item.stakeholderDisplayName,
              position: item.position,
              reason: item.reason ?? null,
              source: item.source ?? null,
              context: item.context ?? null,
              syncedAt: new Date(),
              updatedAt: new Date(),
            },
          });
        upserted++;
      }
    });

    return c.json({ upserted });
  });

export const policyStakeholdersRoute = policyStakeholdersApp;
export type PolicyStakeholdersRoute = typeof policyStakeholdersApp;
