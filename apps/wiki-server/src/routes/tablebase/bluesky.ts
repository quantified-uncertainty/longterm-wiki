import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, gte, lte, sql, inArray } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { blueskyAccounts, blueskyPosts, entities, resources } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { logger } from "../../logger.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 500;
const BLUESKY_PUBLIC_API = "https://public.api.bsky.app/xrpc";

// ---- Query schemas ----

const AccountsQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  tag: z.string().optional(),
});

const PostsQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  accountDid: z.string().optional(),
  dateFrom: z.string().datetime({ message: "dateFrom must be an ISO-8601 datetime string" }).optional(),
  dateTo: z.string().datetime({ message: "dateTo must be an ISO-8601 datetime string" }).optional(),
  minLikes: z.coerce.number().int().min(0).optional(),
});

// ---- Sync schemas ----

const UpsertAccountSchema = z.object({
  did: z.string().min(1).max(500),
  handle: z.string().min(1).max(500),
  displayName: z.string().max(500).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  followerCount: z.number().int().nullable().optional(),
  postCount: z.number().int().nullable().optional(),
  entityStableId: z.string().max(200).nullable().optional(),
  relevanceTags: z.array(z.string().max(100)).max(50).nullable().optional(),
});

// ---- Bluesky API response types ----

interface BlueskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  followersCount?: number;
  postsCount?: number;
}

interface BlueskyFeedItem {
  post: {
    uri: string;
    cid: string;
    author: { did: string; handle: string };
    record: {
      text?: string;
      createdAt: string;
      reply?: {
        parent?: { uri: string };
      };
      embed?: {
        $type?: string;
        external?: {
          uri?: string;
          title?: string;
        };
      };
    };
    likeCount?: number;
    repostCount?: number;
    replyCount?: number;
    quoteCount?: number;
    embed?: {
      $type?: string;
      external?: {
        uri?: string;
        title?: string;
      };
    };
  };
  /** Present when the feed item is a repost — indicates the item is not an original post */
  reason?: {
    $type: string;
    by?: { did: string; handle: string };
  };
}

interface BlueskyFeedResponse {
  feed: BlueskyFeedItem[];
  cursor?: string;
}

// ---- Helpers ----

function formatAccount(
  acct: typeof blueskyAccounts.$inferSelect,
  entityTitle?: string | null
) {
  return {
    did: acct.did,
    handle: acct.handle,
    displayName: acct.displayName,
    description: acct.description,
    followerCount: acct.followerCount,
    postCount: acct.postCount,
    entityStableId: acct.entityStableId,
    entityTitle: entityTitle ?? null,
    relevanceTags: acct.relevanceTags,
    lastFetchedAt: acct.lastFetchedAt?.toISOString() ?? null,
    createdAt: acct.createdAt.toISOString(),
    updatedAt: acct.updatedAt.toISOString(),
  };
}

function formatPost(post: typeof blueskyPosts.$inferSelect) {
  return {
    uri: post.uri,
    cid: post.cid,
    accountDid: post.accountDid,
    text: post.text,
    postedAt: post.postedAt.toISOString(),
    likeCount: post.likeCount,
    repostCount: post.repostCount,
    replyCount: post.replyCount,
    quoteCount: post.quoteCount,
    embeddedUrl: post.embeddedUrl,
    embeddedTitle: post.embeddedTitle,
    replyToUri: post.replyToUri,
    resourceId: post.resourceId,
    entityStableIds: post.entityStableIds,
    fetchedAt: post.fetchedAt.toISOString(),
  };
}

/**
 * Fetch a Bluesky profile using the public API.
 */
async function fetchBlueskyProfile(
  actor: string
): Promise<BlueskyProfile | null> {
  const url = `${BLUESKY_PUBLIC_API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`;
  const res = await fetch(url);
  if (!res.ok) {
    logger.warn(
      { status: res.status, actor },
      "Failed to fetch Bluesky profile"
    );
    return null;
  }
  return (await res.json()) as BlueskyProfile;
}

/**
 * Fetch posts from a Bluesky account via the public API.
 * Handles pagination up to `maxPages` pages of 100 posts each.
 */
async function fetchBlueskyPosts(
  actor: string,
  maxPages: number = 3
): Promise<BlueskyFeedItem[]> {
  const allItems: BlueskyFeedItem[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      actor,
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);

    const url = `${BLUESKY_PUBLIC_API}/app.bsky.feed.getAuthorFeed?${params}`;
    const res = await fetch(url);

    if (!res.ok) {
      logger.warn(
        { status: res.status, actor, page },
        "Failed to fetch Bluesky feed page"
      );
      break;
    }

    const data = (await res.json()) as BlueskyFeedResponse;
    allItems.push(...data.feed);

    if (!data.cursor || data.feed.length === 0) break;
    cursor = data.cursor;
  }

  return allItems;
}

/**
 * Extract the embedded external URL from a feed item, checking both
 * the record-level embed and the top-level embed (Bluesky API returns both).
 */
function extractEmbeddedUrl(item: BlueskyFeedItem): {
  url: string | null;
  title: string | null;
} {
  // Check top-level embed first (more reliable, includes resolved metadata)
  const topEmbed = item.post.embed;
  if (topEmbed?.external?.uri) {
    return {
      url: topEmbed.external.uri,
      title: topEmbed.external.title ?? null,
    };
  }

  // Fallback to record-level embed
  const recEmbed = item.post.record.embed;
  if (recEmbed?.external?.uri) {
    return {
      url: recEmbed.external.uri,
      title: recEmbed.external.title ?? null,
    };
  }

  return { url: null, title: null };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const blueskyApp = new Hono()

  // ---- GET / ---- list accounts
  .get("/", zv("query", AccountsQuery), async (c) => {
    const { limit, offset, tag } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (tag) {
      // Filter accounts that have the specified tag in relevance_tags JSONB array
      conditions.push(
        sql`${blueskyAccounts.relevanceTags} @> ${JSON.stringify([tag])}::jsonb`
      );
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        account: blueskyAccounts,
        entityTitle: entities.title,
      })
      .from(blueskyAccounts)
      .leftJoin(
        entities,
        eq(blueskyAccounts.entityStableId, entities.stableId)
      )
      .where(whereClause)
      .orderBy(desc(blueskyAccounts.updatedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(blueskyAccounts)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      accounts: rows.map((r) => formatAccount(r.account, r.entityTitle)),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /posts ---- list posts
  .get("/posts", zv("query", PostsQuery), async (c) => {
    const { limit, offset, accountDid, dateFrom, dateTo, minLikes } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (accountDid) {
      conditions.push(eq(blueskyPosts.accountDid, accountDid));
    }
    if (dateFrom) {
      conditions.push(gte(blueskyPosts.postedAt, new Date(dateFrom)));
    }
    if (dateTo) {
      conditions.push(lte(blueskyPosts.postedAt, new Date(dateTo)));
    }
    if (minLikes != null) {
      conditions.push(gte(blueskyPosts.likeCount, minLikes));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(blueskyPosts)
      .where(whereClause)
      .orderBy(desc(blueskyPosts.postedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(blueskyPosts)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      posts: rows.map(formatPost),
      total,
      limit,
      offset,
    });
  })

  // ---- POST /accounts ---- upsert an account
  .post("/accounts", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = UpsertAccountSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const data = parsed.data;
    const db = getDrizzleDb();

    await db
      .insert(blueskyAccounts)
      .values({
        did: data.did,
        handle: data.handle,
        displayName: data.displayName ?? null,
        description: data.description ?? null,
        followerCount: data.followerCount ?? null,
        postCount: data.postCount ?? null,
        entityStableId: data.entityStableId ?? null,
        relevanceTags: data.relevanceTags ?? null,
      })
      .onConflictDoUpdate({
        target: blueskyAccounts.did,
        set: {
          handle: sql`excluded.handle`,
          displayName: sql`excluded.display_name`,
          description: sql`excluded.description`,
          followerCount: sql`excluded.follower_count`,
          postCount: sql`excluded.post_count`,
          entityStableId: sql`excluded.entity_stable_id`,
          relevanceTags: sql`excluded.relevance_tags`,
          updatedAt: sql`now()`,
        },
      });

    return c.json({ ok: true, did: data.did });
  })

  // ---- POST /sync/:did ---- fetch posts from Bluesky for an account
  .post("/sync/:did", async (c) => {
    const did = c.req.param("did");
    const db = getDrizzleDb();

    // Look up the account
    const [account] = await db
      .select()
      .from(blueskyAccounts)
      .where(eq(blueskyAccounts.did, did))
      .limit(1);

    if (!account) {
      return c.json({ error: "not_found", message: `No account with DID ${did}` }, 404);
    }

    // Fetch updated profile using the stable DID (handles can change)
    const profile = await fetchBlueskyProfile(did);
    if (profile) {
      await db
        .update(blueskyAccounts)
        .set({
          handle: profile.handle,
          displayName: profile.displayName ?? account.displayName,
          description: profile.description ?? account.description,
          followerCount: profile.followersCount ?? account.followerCount,
          postCount: profile.postsCount ?? account.postCount,
          lastFetchedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(blueskyAccounts.did, did));
    }

    // Fetch posts — filter out reposts (items with a reason field) so we only
    // persist original posts authored by the account itself.
    const rawFeedItems = await fetchBlueskyPosts(did);
    const feedItems = rawFeedItems.filter((item) => !item.reason);
    const now = new Date();
    let upserted = 0;

    if (feedItems.length > 0) {
      // Build a URL→resourceId lookup for embedded URLs so we can populate
      // the resource bridge. Collect all non-null URLs from the feed items.
      const embeddedUrls = feedItems
        .map((item) => extractEmbeddedUrl(item).url)
        .filter((u): u is string => u != null);

      const urlToResourceId = new Map<string, string>();
      if (embeddedUrls.length > 0) {
        const matchedResources = await db
          .select({ id: resources.id, url: resources.url })
          .from(resources)
          .where(inArray(resources.url, embeddedUrls));
        for (const r of matchedResources) {
          urlToResourceId.set(r.url, r.id);
        }
      }

      // Derive entity bridge from the account's entityStableId (if linked)
      const entityStableIds = account.entityStableId
        ? [account.entityStableId]
        : null;

      const postValues = feedItems.map((item) => {
        const { url, title } = extractEmbeddedUrl(item);
        return {
          uri: item.post.uri,
          cid: item.post.cid,
          accountDid: item.post.author.did,
          text: item.post.record.text ?? null,
          postedAt: new Date(item.post.record.createdAt),
          likeCount: item.post.likeCount ?? 0,
          repostCount: item.post.repostCount ?? 0,
          replyCount: item.post.replyCount ?? 0,
          quoteCount: item.post.quoteCount ?? 0,
          embeddedUrl: url,
          embeddedTitle: title,
          replyToUri: item.post.record.reply?.parent?.uri ?? null,
          resourceId: (url && urlToResourceId.get(url)) ?? null,
          entityStableIds,
          fetchedAt: now,
        };
      });

      // Batch upsert in a transaction
      await db.transaction(async (tx) => {
        // Drizzle doesn't support bulk onConflictDoUpdate with array well
        // for large batches, so we chunk into groups of 100
        const CHUNK_SIZE = 100;
        for (let i = 0; i < postValues.length; i += CHUNK_SIZE) {
          const chunk = postValues.slice(i, i + CHUNK_SIZE);
          await tx
            .insert(blueskyPosts)
            .values(chunk)
            .onConflictDoUpdate({
              target: blueskyPosts.uri,
              set: {
                cid: sql`excluded.cid`,
                text: sql`excluded.text`,
                likeCount: sql`excluded.like_count`,
                repostCount: sql`excluded.repost_count`,
                replyCount: sql`excluded.reply_count`,
                quoteCount: sql`excluded.quote_count`,
                embeddedUrl: sql`excluded.embedded_url`,
                embeddedTitle: sql`excluded.embedded_title`,
                replyToUri: sql`excluded.reply_to_uri`,
                resourceId: sql`excluded.resource_id`,
                entityStableIds: sql`excluded.entity_stable_ids`,
                fetchedAt: sql`excluded.fetched_at`,
              },
            });
        }
      });

      upserted = postValues.length;
    }

    logger.info(
      { did, handle: account.handle, upserted },
      "Bluesky sync complete"
    );

    return c.json({
      did,
      handle: account.handle,
      postsUpserted: upserted,
      profileUpdated: profile != null,
    });
  });

// ---- Exports ----

export const blueskyRoute = blueskyApp;
export type BlueskyRoute = typeof blueskyApp;
