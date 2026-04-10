/**
 * Platform Accounts — external platform identities for wiki entities.
 *
 * Maps entities (people, orgs) to their accounts on LessWrong, EA Forum,
 * GitHub, Twitter, Crunchbase, Semantic Scholar, etc.
 *
 * Key operation: reverse lookup (platform + username → entity).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { eq, and, sql, isNull, count } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { platformAccounts } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  paginationQuery,
} from "../shared/utils.js";
import { logger } from "../../logger.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { createSyncHandler } from "./sync-factory.js";
import { useFactoryFor } from "./sync-factory-flag.js";

const VALID_PLATFORMS = [
  "lesswrong",
  "eaforum",
  "alignmentforum",
  "github",
  "twitter",
  "crunchbase",
  "linkedin",
  "semantic_scholar",
  "bluesky",
] as const;

const SyncItemSchema = z.object({
  platform: z.enum(VALID_PLATFORMS),
  platformUsername: z.string().min(1).max(500),
  platformUserId: z.string().max(500).nullable().optional(),
  entityStableId: z.string().min(1).max(200).nullable().optional(),
  displayName: z.string().max(500).nullable().optional(),
  profileUrl: z.string().max(2000).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(200),
});

const AllQuery = paginationQuery({ maxLimit: 1000, defaultLimit: 200 }).extend({
  platform: z.string().max(100).optional(),
  unlinked: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

type SyncItem = z.infer<typeof SyncItemSchema>;

function toRow(item: SyncItem) {
  return {
    platform: item.platform,
    platformUsername: item.platformUsername,
    platformUserId: item.platformUserId ?? null,
    entityStableId: item.entityStableId ?? null,
    displayName: item.displayName ?? null,
    profileUrl: item.profileUrl ?? null,
  };
}

const platformAccountsApp = new Hono()

  // GET /lookup?platform=X&username=Y — reverse lookup: username → entity
  .get("/lookup", async (c) => {
    const platform = c.req.query("platform");
    const username = c.req.query("username");

    if (!platform || !username) {
      return c.json(
        { error: "platform and username query parameters are required" },
        400
      );
    }

    const db = getDrizzleDb();
    const [row] = await db
      .select()
      .from(platformAccounts)
      .where(
        and(
          eq(platformAccounts.platform, platform),
          eq(platformAccounts.platformUsername, username)
        )
      )
      .limit(1);

    if (!row) {
      return c.json({ found: false, account: null }, 200);
    }

    return c.json({ found: true, account: row }, 200);
  })

  // GET /by-entity/:entityId — all accounts for an entity
  .get("/by-entity/:entityId", async (c) => {
    const entityId = c.req.param("entityId");
    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(platformAccounts)
      .where(eq(platformAccounts.entityStableId, entityId))
      .orderBy(platformAccounts.platform);

    return c.json({ accounts: rows, total: rows.length }, 200);
  })

  // GET /all — paginated list with optional filters
  .get("/all", zv("query", AllQuery), async (c) => {
    const { platform, unlinked, limit, offset } = c.req.valid("query");

    const db = getDrizzleDb();
    const conditions = [];
    if (platform) conditions.push(eq(platformAccounts.platform, platform));
    if (unlinked) conditions.push(isNull(platformAccounts.entityStableId));

    const where =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(platformAccounts)
      .where(where)
      .orderBy(platformAccounts.platform, platformAccounts.platformUsername)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(platformAccounts)
      .where(where);
    const total = countResult[0].count;

    return c.json({ accounts: rows, total, limit, offset }, 200);
  })

  // POST /sync — batch upsert
  //
  // Phase 2 migration (issue #4090, discussion #4088): both factory and
  // legacy handlers coexist behind USE_SYNC_FACTORY_ROUTES feature flag.
  // After 7 days of clean metrics with the factory enabled (default), a
  // follow-up PR will remove `legacySyncHandler` and the conditional.
  //
  // Rollback: `USE_SYNC_FACTORY_ROUTES=!platform-accounts` falls back to legacy.
  .post("/sync", async (c) => {
    if (useFactoryFor("platform-accounts")) {
      return factorySyncHandler(c);
    }
    return legacySyncHandler(c);
  })

  // DELETE /:id — remove a mapping
  .delete("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!id || isNaN(id)) {
      return c.json({ error: "Invalid ID" }, 400);
    }

    const db = getDrizzleDb();
    logger.info({ id }, "Deleting platform account");
    const deleted = await db
      .delete(platformAccounts)
      .where(eq(platformAccounts.id, id))
      .returning({ id: platformAccounts.id });

    if (deleted.length === 0) {
      return c.json({ error: "not_found" }, 404);
    }

    return c.json({ deleted: deleted[0].id }, 200);
  });

// ---- Factory implementation (Phase 2 migration) ----
//
// Escape hatch: composite `conflictTarget` + COALESCE-preservation
// `conflictSet`. Per the factory's 1-hook rule, composite-key handling
// (target + set) counts as a single escape hatch family.
//
// Notable: platform_accounts uses a bigserial `id` primary key and identifies
// rows by the composite (platform, platformUsername). toRow omits `id` so
// the DB assigns it on insert, and the COALESCE SET clause preserves any
// existing non-null fields on conflict (so partial syncs don't clobber data).

const factorySyncHandler = createSyncHandler<SyncItem & { id?: string }, typeof platformAccounts>({
  name: "platform-accounts",
  table: platformAccounts,
  batchSchema: SyncBatchSchema,
  entityRefFields: (items) => [
    {
      fieldName: "entityStableId",
      ids: items
        .map((i) => i.entityStableId)
        .filter((id): id is string => id != null),
    },
  ],
  toRow: (item) => toRow(item),
  conflictTarget: [platformAccounts.platform, platformAccounts.platformUsername],
  conflictSet: {
    platformUserId: sql`COALESCE(EXCLUDED.platform_user_id, platform_accounts.platform_user_id)`,
    entityStableId: sql`COALESCE(EXCLUDED.entity_stable_id, platform_accounts.entity_stable_id)`,
    displayName: sql`COALESCE(EXCLUDED.display_name, platform_accounts.display_name)`,
    profileUrl: sql`COALESCE(EXCLUDED.profile_url, platform_accounts.profile_url)`,
    updatedAt: sql`now()`,
  },
});

// ---- Legacy sync handler (kept for 7-day soak window after Phase 2 migration) ----

async function legacySyncHandler(c: Context) {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = SyncBatchSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      c,
      parsed.error.issues.map((i) => i.message).join(", ")
    );
  }

  const { items } = parsed.data;
  const db = getDrizzleDb();

  const entityIds = items.map((i) => i.entityStableId).filter((id): id is string => id != null);
  if (entityIds.length > 0) {
    const refError = await validateEntityRefs(c, db, [
      { fieldName: "entityStableId", ids: entityIds },
    ]);
    if (refError) return refError;
  }

  const result = await db
    .insert(platformAccounts)
    .values(items.map(toRow))
    .onConflictDoUpdate({
      target: [platformAccounts.platform, platformAccounts.platformUsername],
      set: {
        platformUserId: sql`COALESCE(EXCLUDED.platform_user_id, platform_accounts.platform_user_id)`,
        entityStableId: sql`COALESCE(EXCLUDED.entity_stable_id, platform_accounts.entity_stable_id)`,
        displayName: sql`COALESCE(EXCLUDED.display_name, platform_accounts.display_name)`,
        profileUrl: sql`COALESCE(EXCLUDED.profile_url, platform_accounts.profile_url)`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: platformAccounts.id });

  return c.json({ upserted: result.length }, 201);
}

export const platformAccountsRoute = platformAccountsApp;
export type PlatformAccountsRoute = typeof platformAccountsApp;
