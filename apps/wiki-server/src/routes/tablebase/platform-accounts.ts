/**
 * Platform Accounts — external platform identities for wiki entities.
 *
 * Maps entities (people, orgs) to their accounts on LessWrong, EA Forum,
 * GitHub, Twitter, Crunchbase, Semantic Scholar, etc.
 *
 * Key operation: reverse lookup (platform + username → entity).
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and, sql, isNull } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { platformAccounts } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "../shared/utils.js";

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
  entityStableId: z.string().max(200).nullable().optional(),
  displayName: z.string().max(500).nullable().optional(),
  profileUrl: z.string().max(2000).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(200),
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
  .get("/all", async (c) => {
    const platform = c.req.query("platform");
    const unlinked = c.req.query("unlinked");
    const limit = Math.min(Number(c.req.query("limit")) || 200, 1000);
    const offset = Number(c.req.query("offset")) || 0;

    const db = getDrizzleDb();
    const conditions = [];
    if (platform) conditions.push(eq(platformAccounts.platform, platform));
    if (unlinked === "true")
      conditions.push(isNull(platformAccounts.entityStableId));

    const where =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(platformAccounts)
      .where(where)
      .orderBy(platformAccounts.platform, platformAccounts.platformUsername)
      .limit(limit)
      .offset(offset);

    return c.json({ accounts: rows, total: rows.length }, 200);
  })

  // POST /sync — batch upsert
  .post("/sync", async (c) => {
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
  })

  // DELETE /:id — remove a mapping
  .delete("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!id || isNaN(id)) {
      return c.json({ error: "Invalid ID" }, 400);
    }

    const db = getDrizzleDb();
    const deleted = await db
      .delete(platformAccounts)
      .where(eq(platformAccounts.id, id))
      .returning({ id: platformAccounts.id });

    if (deleted.length === 0) {
      return c.json({ error: "not_found" }, 404);
    }

    return c.json({ deleted: deleted[0].id }, 200);
  });

export const platformAccountsRoute = platformAccountsApp;
export type PlatformAccountsRoute = typeof platformAccountsApp;
