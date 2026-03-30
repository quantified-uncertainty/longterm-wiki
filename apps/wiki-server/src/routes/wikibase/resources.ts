import { Hono } from "hono";
import { z } from "zod";
import { buildPrefixTsquery } from "../../search-utils.js";
import { logger } from "../../logger.js";
import {
  eq,
  count,
  sql,
  desc,
  inArray,
  type SQL,
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDrizzleDb, getDb } from "../../db.js";
import {
  resources,
  resourceCitations,
  resourcePapers,
  resourceForumPosts,
  resourcePolicyDocs,
  wikiPages,
  citationContent,
} from "../../schema.js";
import { checkRefsExist } from "../shared/ref-check.js";
import type * as schema from "../../schema.js";
import {
  validationError,
  notFoundError,
  firstOrThrow,
  dbError,
  paginationQuery,
  zv,
} from "../shared/utils.js";
import {
  UpsertResourceSchema as SharedUpsertResourceSchema,
  UpsertResourceBatchSchema,
  UpdateResourceFetchStatusSchema,
  UpsertResourcePaperSchema,
  UpsertResourceForumPostSchema,
  UpsertResourcePolicyDocSchema,
  SuggestResourcesSchema,
  SUGGEST_RESOURCES_DEFAULT_MAX_AGE_MS,
  type ResourceStatsResult,
  type ContentStatus,
} from "../../api-types.js";
import { resolvePageIntId, resolvePageIntIds } from "../shared/page-id-helpers.js";
import { upsertThingsInTx } from "../shared/thing-sync.js";
import { urlVariants } from "../shared/url-variants.js";
import { createHash, randomBytes } from "crypto";

// ---- Raw SQL row types ----

/** Row shape returned by the resource FTS search query. */
interface ResourceSearchRow {
  id: string;
  url: string;
  title: string | null;
  type: string | null;
  summary: string | null;
  review: string | null;
  abstract: string | null;
  key_points: string[] | null;
  publication_id: string | null;
  authors: string[] | null;
  published_date: string | null;
  tags: string[] | null;
  local_filename: string | null;
  credibility_override: number | null;
  fetched_at: string | null;
  content_hash: string | null;
  stable_id: string | null;
  fetch_status: string | null;
  last_fetched_at: string | null;
  archive_url: string | null;
  stance: string | null;
  context_note: string | null;
  resource_purpose: string | null;
  resource_subtype: string | null;
  type_metadata: Record<string, unknown> | null;
  publisher_entity_id: string | null;
  related_entity_ids: string[] | null;
  enrichment_status: string | null;
  enrichment_date: string | null;
  importance_score: number | null;
  content_lifecycle: string | null;
  created_at: string;
  updated_at: string;
  rank: number;
}

/** Row shape returned by COUNT(*) aggregate queries via db.execute(). */
interface CountRow {
  c: string | number;
}

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

/** Generate a 16-char hex hash ID from a URL. Matches crux/lib/hash-utils.ts hashId(). */
function hashId(str: string): string {
  return createHash("sha256").update(str).digest("hex").slice(0, 16);
}

/** Generate a 12-char URL-safe random string for batch IDs. */
function generateBatchId(): string {
  return randomBytes(9).toString("base64url"); // 9 bytes → 12 base64url chars
}

// urlVariants is imported from ../shared/url-variants.js

// ---- Schemas (from shared api-types) ----

const UpsertResourceSchema = SharedUpsertResourceSchema;
const UpsertBatchSchema = UpsertResourceBatchSchema;

const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const PaginationQuery = paginationQuery({ maxLimit: MAX_PAGE_SIZE }).extend({
  type: z.string().max(50).optional(),
});

const BatchDetailsSchema = z.object({
  papers: z.array(z.object({
    resourceId: z.string().min(1).max(200),
  }).merge(UpsertResourcePaperSchema)).max(200).optional(),
  forumPosts: z.array(z.object({
    resourceId: z.string().min(1).max(200),
  }).merge(UpsertResourceForumPostSchema)).max(200).optional(),
  policyDocs: z.array(z.object({
    resourceId: z.string().min(1).max(200),
  }).merge(UpsertResourcePolicyDocSchema)).max(200).optional(),
});

const AuthorEntityIdsSchema = z.object({
  items: z.array(z.object({
    resourceId: z.string().min(1),
    authorEntityIds: z.array(z.string().min(1)),
  })).min(1).max(500),
});

// ---- Helpers ----

type DbClient = PostgresJsDatabase<typeof schema>;
type ResourceInput = z.infer<typeof UpsertResourceSchema>;

function resourceValues(d: ResourceInput) {
  return {
    id: d.id,
    url: d.url,
    title: d.title ?? null,
    type: d.type ?? null,
    summary: d.summary ?? null,
    review: d.review ?? null,
    abstract: d.abstract ?? null,
    keyPoints: d.keyPoints ?? null,
    publicationId: d.publicationId ?? null,
    authors: d.authors ?? null,
    publishedDate: d.publishedDate ?? null,
    tags: d.tags ?? null,
    localFilename: d.localFilename ?? null,
    credibilityOverride: d.credibilityOverride ?? null,
    fetchedAt: d.fetchedAt ? new Date(d.fetchedAt) : null,
    contentHash: d.contentHash ?? null,
    stableId: d.stableId ?? null,
    archiveUrl: d.archiveUrl ?? null,
    stance: d.stance ?? null,
    contextNote: d.contextNote ?? null,
    resourcePurpose: d.resourcePurpose ?? null,
    resourceSubtype: d.resourceSubtype ?? null,
    typeMetadata: d.typeMetadata ?? null,
    publisherEntityId: d.publisherEntityId ?? null,
    relatedEntityIds: d.relatedEntityIds ?? null,
    enrichmentStatus: d.enrichmentStatus ?? null,
    importanceScore: d.importanceScore ?? null,
    contentLifecycle: d.contentLifecycle ?? null,
  };
}

/** Build a COALESCE expression for a jsonb column that correctly handles JS
 *  arrays. Drizzle's `sql` template sends JS arrays as PG array parameters,
 *  which can't be cast to jsonb. We pre-serialize to JSON text so the
 *  `::jsonb` cast receives valid JSON. Null passes through to preserve
 *  existing values via COALESCE. */
function jsonbCoalesce(
  incoming: unknown[] | null,
  existing: unknown,
) {
  if (incoming == null) {
    return sql`COALESCE(null::jsonb, ${existing})`;
  }
  const jsonText = JSON.stringify(incoming);
  return sql`COALESCE(${jsonText}::jsonb, ${existing})`;
}

async function upsertResource(
  db: DbClient,
  d: ResourceInput,
  options?: { skipSearchVector?: boolean; intIdMap?: Map<string, number> }
) {
  const vals = resourceValues(d);

  // COALESCE(incoming, existing) for enrichable fields: a non-null incoming
  // value overwrites, but null incoming preserves existing data. This prevents
  // partial saves (bare resources, snapshot-loaded resources missing text fields)
  // from wiping richer data already in PG. See #2069 review discussion.
  const rows = await db
    .insert(resources)
    .values(vals)
    .onConflictDoUpdate({
      target: resources.id,
      set: {
        url: vals.url,
        title: sql`COALESCE(${vals.title}, ${resources.title})`,
        type: sql`COALESCE(${vals.type}, ${resources.type})`,
        summary: sql`COALESCE(${vals.summary}, ${resources.summary})`,
        review: sql`COALESCE(${vals.review}, ${resources.review})`,
        abstract: sql`COALESCE(${vals.abstract}, ${resources.abstract})`,
        keyPoints: jsonbCoalesce(vals.keyPoints, resources.keyPoints),
        publicationId: sql`COALESCE(${vals.publicationId}, ${resources.publicationId})`,
        authors: jsonbCoalesce(vals.authors, resources.authors),
        publishedDate: sql`COALESCE(${vals.publishedDate}, ${resources.publishedDate})`,
        tags: jsonbCoalesce(vals.tags, resources.tags),
        localFilename: sql`COALESCE(${vals.localFilename}, ${resources.localFilename})`,
        credibilityOverride: sql`COALESCE(${vals.credibilityOverride}, ${resources.credibilityOverride})`,
        fetchedAt: sql`COALESCE(${vals.fetchedAt}, ${resources.fetchedAt})`,
        contentHash: sql`COALESCE(${vals.contentHash}, ${resources.contentHash})`,
        // stableId is generate-once: preserve existing, only set if row didn't have one
        stableId: sql`COALESCE(${resources.stableId}, ${vals.stableId})`,
        archiveUrl: sql`COALESCE(${vals.archiveUrl}, ${resources.archiveUrl})`,
        stance: sql`COALESCE(${vals.stance}, ${resources.stance})`,
        contextNote: sql`COALESCE(${vals.contextNote}, ${resources.contextNote})`,
        resourcePurpose: sql`COALESCE(${vals.resourcePurpose}, ${resources.resourcePurpose})`,
        resourceSubtype: sql`COALESCE(${vals.resourceSubtype}, ${resources.resourceSubtype})`,
        typeMetadata: vals.typeMetadata
          ? sql`COALESCE(${JSON.stringify(vals.typeMetadata)}::jsonb, ${resources.typeMetadata})`
          : sql`COALESCE(null::jsonb, ${resources.typeMetadata})`,
        publisherEntityId: sql`COALESCE(${vals.publisherEntityId}, ${resources.publisherEntityId})`,
        relatedEntityIds: jsonbCoalesce(vals.relatedEntityIds, resources.relatedEntityIds),
        enrichmentStatus: sql`COALESCE(${vals.enrichmentStatus}, ${resources.enrichmentStatus})`,
        // Auto-set enrichmentDate when enrichmentStatus changes
        enrichmentDate: vals.enrichmentStatus
          ? sql`now()`
          : sql`COALESCE(null::timestamptz, ${resources.enrichmentDate})`,
        importanceScore: sql`COALESCE(${vals.importanceScore}, ${resources.importanceScore})`,
        contentLifecycle: sql`COALESCE(${vals.contentLifecycle}, ${resources.contentLifecycle})`,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      id: resources.id,
      url: resources.url,
      title: resources.title,
    });

  const result = firstOrThrow(rows, `resource upsert ${d.id}`);

  if (!options?.skipSearchVector) {
    // Update search_vector for this resource (single-row update)
    await db.execute(sql`
      UPDATE resources SET search_vector =
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(abstract, '')), 'C') ||
        setweight(to_tsvector('english', coalesce(review, '')), 'D')
      WHERE id = ${d.id}
    `);
  }

  // Upsert citations (cited_by)
  if (d.citedBy && d.citedBy.length > 0) {
    // Resolve slugs to integer IDs before touching existing rows
    const citedByIntIdMap = options?.intIdMap ?? await resolvePageIntIds(db, d.citedBy);
    const unresolvedPageIds = d.citedBy.filter((pageId) => !citedByIntIdMap.has(pageId));
    if (unresolvedPageIds.length > 0) {
      throw new Error(
        `Failed to resolve page_id for citedBy pages: ${unresolvedPageIds.join(", ")}`
      );
    }
    // Delete existing citations for this resource, then re-insert
    await db
      .delete(resourceCitations)
      .where(eq(resourceCitations.resourceId, d.id));
    const citationValues = d.citedBy.map((slug) => ({
      resourceId: d.id,
      pageId: citedByIntIdMap.get(slug) as number,
    }));
    await db
      .insert(resourceCitations)
      .values(citationValues)
      .onConflictDoNothing();
  }

  return result;
}

function formatResource(r: typeof resources.$inferSelect) {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    type: r.type,
    summary: r.summary,
    review: r.review,
    abstract: r.abstract,
    keyPoints: r.keyPoints,
    publicationId: r.publicationId,
    authors: r.authors,
    authorEntityIds: r.authorEntityIds,
    publishedDate: r.publishedDate,
    tags: r.tags,
    localFilename: r.localFilename,
    credibilityOverride: r.credibilityOverride,
    fetchedAt: r.fetchedAt,
    contentHash: r.contentHash,
    stableId: r.stableId,
    fetchStatus: r.fetchStatus,
    lastFetchedAt: r.lastFetchedAt,
    archiveUrl: r.archiveUrl,
    stance: r.stance,
    contextNote: r.contextNote,
    resourcePurpose: r.resourcePurpose,
    resourceSubtype: r.resourceSubtype,
    typeMetadata: r.typeMetadata,
    publisherEntityId: r.publisherEntityId,
    relatedEntityIds: r.relatedEntityIds,
    enrichmentStatus: r.enrichmentStatus,
    enrichmentDate: r.enrichmentDate,
    importanceScore: r.importanceScore,
    contentLifecycle: r.contentLifecycle,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function formatPaper(r: typeof resourcePapers.$inferSelect) {
  return {
    arxivId: r.arxivId,
    doi: r.doi,
    semanticScholarId: r.semanticScholarId,
    abstract: r.abstract,
    citationCount: r.citationCount,
    influentialCitationCount: r.influentialCitationCount,
    categories: r.categories,
    methodology: r.methodology,
    year: r.year,
  };
}

function formatForumPost(r: typeof resourceForumPosts.$inferSelect) {
  return {
    forum: r.forum,
    forumPostId: r.forumPostId,
    forumSlug: r.forumSlug,
    karma: r.karma,
    commentCount: r.commentCount,
    authorUsername: r.authorUsername,
    forumTags: r.forumTags,
    sequenceTitle: r.sequenceTitle,
    curated: r.curated,
    crossPostedFrom: r.crossPostedFrom,
    canonicalForum: r.canonicalForum,
  };
}

function formatPolicyDoc(r: typeof resourcePolicyDocs.$inferSelect) {
  return {
    documentType: r.documentType,
    jurisdictionEntityId: r.jurisdictionEntityId,
    agencyEntityId: r.agencyEntityId,
    policyEntityId: r.policyEntityId,
    effectiveDate: r.effectiveDate,
    documentStatus: r.documentStatus,
    referenceNumber: r.referenceNumber,
  };
}

// ---- Route ----

const resourcesApp = new Hono()

  // ---- POST / (upsert single resource) ----

  .post("/", zv("json", UpsertResourceSchema), async (c) => {
    const data = c.req.valid("json");
    const db = getDrizzleDb();

    // Validate citedBy page references (optional field)
    if (data.citedBy && data.citedBy.length > 0) {
      const missingPages = await checkRefsExist(db, wikiPages, wikiPages.slug, data.citedBy);
      if (missingPages.length > 0) {
        return validationError(
          c,
          `Referenced pages not found in citedBy: ${missingPages.join(", ")}`
        );
      }
    }

    try {
      const result = await upsertResource(db, data);
      return c.json(result, 201);
    } catch (err) {
      logger.error(
        { err, resourceId: data.id },
        "single resource upsert failed",
      );
      return dbError(c, "resource upsert", err, { resourceId: data.id });
    }
  })

  // ---- POST /batch (upsert multiple resources) ----

  .post("/batch", zv("json", UpsertBatchSchema), async (c) => {
    const { items } = c.req.valid("json");

    const db = getDrizzleDb();

    // Validate citedBy page references
    const allCitedBy = [
      ...new Set(items.flatMap((item) => item.citedBy ?? [])),
    ];
    if (allCitedBy.length > 0) {
      const missingPages = await checkRefsExist(db, wikiPages, wikiPages.slug, allCitedBy);
      if (missingPages.length > 0) {
        return validationError(
          c,
          `Referenced pages not found in citedBy: ${missingPages.join(", ")}`
        );
      }
    }

    let results: Array<{ id: string; url: string }> = [];
    try {
      await db.transaction(async (tx) => {
        // Pre-resolve all citedBy page IDs in one batch query
        const allCitedByIds = [...new Set(items.flatMap((item) => item.citedBy ?? []))];
        const intIdMap = allCitedByIds.length > 0
          ? await resolvePageIntIds(tx, allCitedByIds)
          : new Map<string, number>();

        // Bulk upsert all resources in one query
        const allVals = items.map((d) => resourceValues(d));
        const upsertedRows = await tx
          .insert(resources)
          .values(allVals)
          .onConflictDoUpdate({
            target: resources.id,
            set: {
              url: sql`excluded.url`,
              title: sql`COALESCE(excluded.title, ${resources.title})`,
              type: sql`COALESCE(excluded.type, ${resources.type})`,
              summary: sql`COALESCE(excluded.summary, ${resources.summary})`,
              review: sql`COALESCE(excluded.review, ${resources.review})`,
              abstract: sql`COALESCE(excluded.abstract, ${resources.abstract})`,
              keyPoints: sql`COALESCE(excluded.key_points, ${resources.keyPoints})`,
              publicationId: sql`COALESCE(excluded.publication_id, ${resources.publicationId})`,
              authors: sql`COALESCE(excluded.authors, ${resources.authors})`,
              publishedDate: sql`COALESCE(excluded.published_date, ${resources.publishedDate})`,
              tags: sql`COALESCE(excluded.tags, ${resources.tags})`,
              localFilename: sql`COALESCE(excluded.local_filename, ${resources.localFilename})`,
              credibilityOverride: sql`COALESCE(excluded.credibility_override, ${resources.credibilityOverride})`,
              fetchedAt: sql`COALESCE(excluded.fetched_at, ${resources.fetchedAt})`,
              contentHash: sql`COALESCE(excluded.content_hash, ${resources.contentHash})`,
              stableId: sql`COALESCE(${resources.stableId}, excluded.stable_id)`,
              archiveUrl: sql`COALESCE(excluded.archive_url, ${resources.archiveUrl})`,
              stance: sql`COALESCE(excluded.stance, ${resources.stance})`,
              contextNote: sql`COALESCE(excluded.context_note, ${resources.contextNote})`,
              resourcePurpose: sql`COALESCE(excluded.resource_purpose, ${resources.resourcePurpose})`,
              resourceSubtype: sql`COALESCE(excluded.resource_subtype, ${resources.resourceSubtype})`,
              typeMetadata: sql`COALESCE(excluded.type_metadata, ${resources.typeMetadata})`,
              publisherEntityId: sql`COALESCE(excluded.publisher_entity_id, ${resources.publisherEntityId})`,
              relatedEntityIds: sql`COALESCE(excluded.related_entity_ids, ${resources.relatedEntityIds})`,
              enrichmentStatus: sql`COALESCE(excluded.enrichment_status, ${resources.enrichmentStatus})`,
              enrichmentDate: sql`CASE WHEN excluded.enrichment_status IS NOT NULL THEN now() ELSE COALESCE(null::timestamptz, ${resources.enrichmentDate}) END`,
              importanceScore: sql`COALESCE(excluded.importance_score, ${resources.importanceScore})`,
              contentLifecycle: sql`COALESCE(excluded.content_lifecycle, ${resources.contentLifecycle})`,
              updatedAt: sql`now()`,
            },
          })
          .returning({
            id: resources.id,
            url: resources.url,
            title: resources.title,
          });

        results = upsertedRows.map((r) => ({ id: r.id, url: r.url }));

        // Bulk replace citations: delete all old citations for batch resources, then insert new ones
        const resourceIdsWithCitations = items
          .filter((d) => d.citedBy && d.citedBy.length > 0)
          .map((d) => d.id);
        if (resourceIdsWithCitations.length > 0) {
          await tx
            .delete(resourceCitations)
            .where(inArray(resourceCitations.resourceId, resourceIdsWithCitations));

          const allCitations: Array<{
            resourceId: string;
            pageId: number;
          }> = [];
          for (const item of items) {
            if (item.citedBy && item.citedBy.length > 0) {
              for (const slug of item.citedBy) {
                const intId = intIdMap.get(slug);
                if (intId != null) {
                  allCitations.push({
                    resourceId: item.id,
                    pageId: intId,
                  });
                }
              }
            }
          }
          if (allCitations.length > 0) {
            await tx
              .insert(resourceCitations)
              .values(allCitations)
              .onConflictDoNothing();
          }
        }

        // Bulk search_vector update for all upserted resources (one query)
        const idList = sql.join(
          results.map((r) => sql`${r.id}`),
          sql`, `
        );
        await tx.execute(sql`
          UPDATE resources SET search_vector =
            setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(abstract, '')), 'C') ||
            setweight(to_tsvector('english', coalesce(review, '')), 'D')
          WHERE id IN (${idList})
        `);

        // Dual-write to things table
        await upsertThingsInTx(
          tx,
          items.map((r) => ({
            id: r.stableId || r.id,
            thingType: "resource" as const,
            title: r.title || r.url,
            sourceTable: "resources",
            sourceId: r.id,
            description: r.summary,
            sourceUrl: r.url,
          }))
        );
      });
    } catch (err) {
      logger.error(
        { err, resourceIds: items.map((r) => r.id), itemCount: items.length },
        "resources batch upsert failed",
      );
      return dbError(c, "resources batch upsert", err, { itemCount: items.length });
    }

    return c.json({ upserted: results.length, results }, 201);
  })

  // ---- POST /suggest (register URLs as resources + check content freshness) ----

  .post("/suggest", zv("json", SuggestResourcesSchema), async (c) => {
    // Note: entityId and agentSessionId are accepted by the schema but not yet used.
    // They are reserved for Phase 2 (linking suggestions to entities/sessions). See #3253.
    const { urls, maxContentAgeMs } = c.req.valid("json");
    const maxAge = maxContentAgeMs ?? SUGGEST_RESOURCES_DEFAULT_MAX_AGE_MS;
    const now = Date.now();
    const rawDb = getDb();

    // Deduplicate input URLs
    const uniqueUrls = [...new Set(urls)];

    // 1. Build URL variants for batch lookup
    const variantToOriginals = new Map<string, Set<string>>();
    for (const url of uniqueUrls) {
      for (const variant of urlVariants(url)) {
        let originals = variantToOriginals.get(variant);
        if (!originals) {
          originals = new Set<string>();
          variantToOriginals.set(variant, originals);
        }
        originals.add(url);
      }
    }
    const allVariants = [...variantToOriginals.keys()];

    // 2. Batch lookup existing resources + content freshness in one query
    interface ResourceWithContent {
      id: string;
      url: string;
      title: string | null;
      fetched_at: string | Date | null;
      has_content: boolean;
    }
    const existingRows: ResourceWithContent[] =
      allVariants.length > 0
        ? await rawDb<ResourceWithContent[]>`
            SELECT r.id, r.url, r.title, cc.fetched_at,
              (cc.full_text IS NOT NULL AND length(cc.full_text) > 0) AS has_content
            FROM resources r
            LEFT JOIN citation_content cc ON cc.resource_id = r.id
            WHERE r.url = ANY(${allVariants})
          `
        : [];

    // Map original input URL → existing resource + content info
    const urlToResource = new Map<string, ResourceWithContent>();
    for (const row of existingRows) {
      const originals = variantToOriginals.get(row.url);
      if (originals) {
        for (const original of originals) {
          // Prefer exact URL match; first variant match is fallback
          const current = urlToResource.get(original);
          if (!current || (current.url !== original && row.url === original)) {
            urlToResource.set(original, row);
          }
        }
      }
    }

    // 3. Bulk-create resources for unknown URLs (single query)
    const toCreate = uniqueUrls.filter((u) => !urlToResource.has(u));
    if (toCreate.length > 0) {
      const ids = toCreate.map((u) => hashId(u));
      // DO UPDATE SET updated_at = now() forces RETURNING to include conflicting rows
      const created = await rawDb<ResourceWithContent[]>`
        INSERT INTO resources (id, url, type, created_at, updated_at)
        SELECT * FROM unnest(${ids}::text[], ${toCreate}::text[])
          AS t(id, url),
          LATERAL (SELECT 'web'::text AS type, now() AS created_at, now() AS updated_at) defaults
        ON CONFLICT (url) DO UPDATE SET updated_at = now()
        RETURNING id, url, title, null::timestamptz AS fetched_at, false AS has_content
      `;
      for (const row of created) {
        // Find which input URL this row corresponds to
        const original = toCreate.find(
          (u) => hashId(u) === row.id || u === row.url,
        );
        if (original && !urlToResource.has(original)) {
          urlToResource.set(original, row);
        }
      }

      // Handle any URLs still unmapped (URL unique constraint prevented insert
      // but the row has a different ID than our hash — rare edge case)
      for (const url of toCreate) {
        if (!urlToResource.has(url)) {
          const variants = urlVariants(url);
          const fallback = await rawDb<ResourceWithContent[]>`
            SELECT r.id, r.url, r.title, cc.fetched_at,
              (cc.full_text IS NOT NULL AND length(cc.full_text) > 0) AS has_content
            FROM resources r
            LEFT JOIN citation_content cc ON cc.resource_id = r.id
            WHERE r.url = ANY(${variants})
            LIMIT 1
          `;
          if (fallback.length > 0) {
            urlToResource.set(url, fallback[0]);
          } else {
            logger.warn({ url, id: hashId(url) }, "suggest: could not resolve resource — using fallback");
            urlToResource.set(url, {
              id: hashId(url), url, title: null, fetched_at: null, has_content: false,
            });
          }
        }
      }
    }

    // 4. Build results with content status
    const results = uniqueUrls.map((url) => {
      const r = urlToResource.get(url)!;

      let contentStatus: ContentStatus;
      if (!r.has_content) {
        contentStatus = "missing";
      } else if (r.fetched_at && now - new Date(r.fetched_at).getTime() > maxAge) {
        contentStatus = "stale";
      } else {
        contentStatus = "fresh";
      }

      return {
        url,
        resourceId: r.id,
        contentStatus,
        title: r.title,
        jobId: null as number | null,
      };
    });

    // 5. Create ingestion jobs for non-fresh resources (Phase 2: batch workflow)
    const toIngest = results.filter((r) => r.contentStatus !== "fresh");
    let batchId: string | null = null;

    if (toIngest.length > 0) {
      batchId = generateBatchId();

      // Fetch citation counts for priority calculation
      const resourceIds = toIngest.map((r) => r.resourceId);
      interface CitationCountRow {
        resource_id: string;
        cnt: string;
      }
      const citationCounts = await rawDb<CitationCountRow[]>`
        SELECT resource_id, count(*)::text AS cnt
        FROM resource_citations
        WHERE resource_id = ANY(${resourceIds})
        GROUP BY resource_id
      `;
      const citationCountMap = new Map<string, number>();
      for (const row of citationCounts) {
        citationCountMap.set(row.resource_id, Number(row.cnt));
      }

      // Insert jobs with dedup keys using raw SQL for ON CONFLICT dedup
      // (same pattern as jobs.ts DEDUP_INSERT_SQL)
      for (const item of toIngest) {
        const citCount = citationCountMap.get(item.resourceId) ?? 0;
        const priority = Math.min(100, citCount * 5);
        const dedupKey = `batch:${batchId}:${item.resourceId}`;

        const insertResult = await rawDb<{ id: number }[]>`
          INSERT INTO jobs (type, params, priority, max_retries, dedup_key)
          VALUES (
            'resource-ingest',
            ${JSON.stringify({ resourceId: item.resourceId, url: item.url })}::jsonb,
            ${priority},
            3,
            ${dedupKey}
          )
          ON CONFLICT (dedup_key)
            WHERE dedup_key IS NOT NULL AND status IN ('pending', 'claimed', 'running')
          DO NOTHING
          RETURNING id
        `;

        if (insertResult.length > 0) {
          item.jobId = insertResult[0].id;
        } else {
          // Active duplicate exists — fetch its ID
          const existing = await rawDb<{ id: number }[]>`
            SELECT id FROM jobs
            WHERE dedup_key = ${dedupKey}
              AND status IN ('pending', 'claimed', 'running')
            LIMIT 1
          `;
          if (existing.length > 0) {
            item.jobId = existing[0].id;
          }
        }
      }
    }

    return c.json({ results, batchId });
  })

  // ---- GET /suggest/status/:batchId (poll batch ingestion progress) ----

  .get("/suggest/status/:batchId", async (c) => {
    const batchId = c.req.param("batchId");
    if (!batchId || batchId.length > 50) {
      return validationError(c, "Invalid batchId");
    }

    const rawDb = getDb();
    const dedupPrefix = `batch:${batchId}:%`;

    // Query all jobs for this batch with resource data
    interface BatchJobRow {
      job_id: number;
      job_status: string;
      dedup_key: string;
      params: { resourceId?: string; url?: string } | null;
      resource_id: string | null;
      resource_url: string | null;
      enrichment_status: string | null;
      summary: string | null;
    }
    const jobRows = await rawDb<BatchJobRow[]>`
      SELECT
        j.id AS job_id,
        j.status AS job_status,
        j.dedup_key,
        j.params,
        r.id AS resource_id,
        r.url AS resource_url,
        r.enrichment_status,
        r.summary
      FROM jobs j
      LEFT JOIN resources r ON r.id = (j.params->>'resourceId')
      WHERE j.dedup_key LIKE ${dedupPrefix}
      ORDER BY j.id
    `;

    if (jobRows.length === 0) {
      return c.json({
        batchId,
        total: 0,
        pending: 0,
        completed: 0,
        failed: 0,
        results: [],
      });
    }

    let pending = 0;
    let completed = 0;
    let failed = 0;

    const batchResults = jobRows.map((row) => {
      const status = row.job_status;
      if (status === "completed") completed++;
      else if (status === "failed") failed++;
      else pending++; // pending, claimed, running

      const resourceId = row.resource_id ?? row.params?.resourceId ?? null;
      const url = row.resource_url ?? row.params?.url ?? null;

      return {
        resourceId,
        url,
        jobId: row.job_id,
        jobStatus: status,
        enrichmentStatus: row.enrichment_status,
        summary: row.summary,
      };
    });

    return c.json({
      batchId,
      total: jobRows.length,
      pending,
      completed,
      failed,
      results: batchResults,
    });
  })

  // ---- GET /search?q=X (full-text search by title/summary/abstract/review) ----

  .get("/search", zv("query", SearchQuery), async (c) => {
    const { q, limit } = c.req.valid("query");
    const rawDb = getDb();

    // Full-text search with prefix matching (same pattern as wiki_pages search)
    const prefixQuery = buildPrefixTsquery(q);

    const rows: ResourceSearchRow[] = prefixQuery
      ? await rawDb<ResourceSearchRow[]>`
          SELECT
          id, url, title, type, summary, review, abstract,
          key_points, publication_id, authors, published_date,
          tags, local_filename, credibility_override,
          fetched_at, content_hash, stable_id,
          fetch_status, last_fetched_at, archive_url, stance,
          context_note, resource_purpose, resource_subtype,
          type_metadata, publisher_entity_id, related_entity_ids,
          enrichment_status, enrichment_date, importance_score, content_lifecycle,
          created_at, updated_at,
          ts_rank_cd(search_vector, to_tsquery('english', ${prefixQuery}), 1) AS rank
        FROM resources
        WHERE search_vector @@ to_tsquery('english', ${prefixQuery})
        ORDER BY rank DESC
        LIMIT ${limit}`
      : [];

    return c.json({
      results: rows.map((r) => ({
        id: r.id,
        url: r.url,
        title: r.title,
        type: r.type,
        summary: r.summary,
        review: r.review,
        abstract: r.abstract,
        keyPoints: r.key_points,
        publicationId: r.publication_id,
        authors: r.authors,
        publishedDate: r.published_date,
        tags: r.tags,
        localFilename: r.local_filename,
        credibilityOverride: r.credibility_override,
        fetchedAt: r.fetched_at,
        contentHash: r.content_hash,
        stableId: r.stable_id,
        fetchStatus: r.fetch_status,
        lastFetchedAt: r.last_fetched_at,
        archiveUrl: r.archive_url,
        stance: r.stance,
        contextNote: r.context_note,
        resourcePurpose: r.resource_purpose,
        resourceSubtype: r.resource_subtype,
        typeMetadata: r.type_metadata,
        publisherEntityId: r.publisher_entity_id,
        relatedEntityIds: r.related_entity_ids,
        enrichmentStatus: r.enrichment_status,
        enrichmentDate: r.enrichment_date,
        importanceScore: r.importance_score,
        contentLifecycle: r.content_lifecycle,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      count: rows.length,
      query: q,
    });
  })

  // ---- GET /stats ----

  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const rawDb = getDb();

    const [totalResult, citationCountResult, citedPagesResult, byType] =
      await Promise.all([
        db.select({ count: count() }).from(resources),
        db.select({ count: count() }).from(resourceCitations),
        db
          .select({
            count: sql<number>`count(distinct ${resourceCitations.pageId})`,
          })
          .from(resourceCitations),
        db
          .select({ type: resources.type, count: count() })
          .from(resources)
          .groupBy(resources.type)
          .orderBy(desc(count())),
      ]);

    const totalResources = totalResult[0].count;
    const totalCitations = citationCountResult[0].count;
    const citedPages = Number(citedPagesResult[0].count);

    // Extra stats: orphaned, metadata coverage, fetched count, enrichment status, content cache
    // Use raw postgres client for type-parameterized queries (avoids double-cast from db.execute())
    const [
      orphanedResult,
      withMetadataResult,
      fetchedResult,
      enrichmentStatusResult,
      contentCacheResult,
    ] = await Promise.all([
      rawDb<CountRow[]>`
        SELECT count(*) AS c FROM resources r
        LEFT JOIN resource_citations rc ON rc.resource_id = r.id
        WHERE rc.resource_id IS NULL
      `,
      rawDb<CountRow[]>`
        SELECT count(*) AS c FROM resources
        WHERE summary IS NOT NULL OR review IS NOT NULL OR key_points IS NOT NULL
      `,
      rawDb<CountRow[]>`
        SELECT count(*) AS c FROM resources WHERE fetched_at IS NOT NULL
      `,
      rawDb<{ status: string | null; c: string }[]>`
        SELECT enrichment_status AS status, count(*) AS c
        FROM resources
        GROUP BY enrichment_status
      `,
      rawDb<{ with_full_text: string; with_metadata_only: string }[]>`
        SELECT
          (SELECT count(*) FROM citation_content WHERE full_text IS NOT NULL) AS with_full_text,
          (SELECT count(*) FROM citation_content WHERE full_text IS NULL AND page_title IS NOT NULL) AS with_metadata_only
      `,
    ]);

    const byEnrichmentStatus: Record<string, number> = {};
    for (const row of enrichmentStatusResult) {
      byEnrichmentStatus[row.status ?? "none"] = Number(row.c);
    }

    const ccRow = contentCacheResult[0];
    const withFullText = Number(ccRow?.with_full_text ?? 0);
    const withMetadataOnly = Number(ccRow?.with_metadata_only ?? 0);
    const contentCacheStats = {
      withFullText,
      withMetadataOnly,
      uncached: Math.max(0, totalResources - withFullText - withMetadataOnly),
    };

    const result: ResourceStatsResult = {
      totalResources,
      totalCitations,
      citedPages,
      byType: Object.fromEntries(
        byType.map((r) => [r.type ?? "unknown", r.count])
      ),
      orphanedCount: Number(orphanedResult[0]?.c ?? 0),
      withMetadata: Number(withMetadataResult[0]?.c ?? 0),
      fetched: Number(fetchedResult[0]?.c ?? 0),
      byEnrichmentStatus,
      contentCacheStats,
    };

    return c.json(result);
  })

  // ---- GET /by-page/:pageId (resources cited by a page) ----

  .get("/by-page/:pageId", async (c) => {
    const pageId = c.req.param("pageId");
    const db = getDrizzleDb();

    // Resolve slug to integer ID
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return c.json({ resources: [] });

    const rows = await db
      .select({
        id: resources.id,
        url: resources.url,
        title: resources.title,
        type: resources.type,
        publicationId: resources.publicationId,
        authors: resources.authors,
        publishedDate: resources.publishedDate,
        summary: resources.summary,
        stance: resources.stance,
      })
      .from(resourceCitations)
      .innerJoin(resources, eq(resourceCitations.resourceId, resources.id))
      .where(eq(resourceCitations.pageId, intId));

    return c.json({ resources: rows });
  })

  // ---- GET /lookup?url=X (lookup by URL, with normalization) ----

  .get("/lookup", async (c) => {
    const url = c.req.query("url");
    if (!url) return validationError(c, "url query parameter is required");

    const db = getDrizzleDb();

    // Try exact match first
    let rows = await db
      .select()
      .from(resources)
      .where(eq(resources.url, url))
      .limit(1);

    // If not found, try normalized variants (www/no-www, trailing slash)
    if (rows.length === 0) {
      const variants = urlVariants(url);
      if (variants.length > 1) {
        const variantList = sql.join(
          variants.map((v) => sql`${v}`),
          sql`, `
        );
        rows = await db
          .select()
          .from(resources)
          .where(sql`${resources.url} IN (${variantList})`)
          .limit(1);
      }
    }

    if (rows.length === 0) {
      return notFoundError(c, `No resource found for URL: ${url}`);
    }

    return c.json(formatResource(rows[0]));
  })

  // ---- GET /all (paginated listing) ----

  .get("/all", zv("query", PaginationQuery), async (c) => {
    const { limit, offset, type } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL | undefined = type
      ? eq(resources.type, type)
      : undefined;

    const rows = await db
      .select()
      .from(resources)
      .where(conditions)
      .orderBy(resources.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(resources)
      .where(conditions);
    const total = countResult[0].count;

    return c.json({
      resources: rows.map(formatResource),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-content-hash?hash=X&excludeId=Y (duplicate detection) ----

  .get("/by-content-hash", async (c) => {
    const hash = c.req.query("hash");
    if (!hash) return validationError(c, "hash query parameter is required");

    const excludeId = c.req.query("excludeId");
    const db = getDrizzleDb();

    const conditions = excludeId
      ? sql`${resources.contentHash} = ${hash} AND ${resources.id} != ${excludeId}`
      : eq(resources.contentHash, hash);

    const rows = await db
      .select({ id: resources.id, url: resources.url, title: resources.title })
      .from(resources)
      .where(conditions)
      .limit(5);

    return c.json({ resources: rows });
  })

  // ---- GET /by-content-hash?hash=X&excludeId=Y (duplicate detection) ----

  .get("/by-content-hash", async (c) => {
    const hash = c.req.query("hash");
    if (!hash) return validationError(c, "hash query parameter is required");

    const excludeId = c.req.query("excludeId");
    const db = getDrizzleDb();

    const conditions = excludeId
      ? sql`${resources.contentHash} = ${hash} AND ${resources.id} != ${excludeId}`
      : eq(resources.contentHash, hash);

    const rows = await db
      .select({ id: resources.id, url: resources.url, title: resources.title })
      .from(resources)
      .where(conditions)
      .limit(5);

    return c.json({ resources: rows });
  })

  // ---- GET /:id/content (resource + linked fetched content) ----

  .get("/:id/content", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(resources)
      .where(eq(resources.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Resource not found: ${id}`);
    }

    const resource = rows[0];

    // Look up fetched content by exact URL match
    const contentRows = await db
      .select({
        url: citationContent.url,
        fetchedAt: citationContent.fetchedAt,
        httpStatus: citationContent.httpStatus,
        contentType: citationContent.contentType,
        pageTitle: citationContent.pageTitle,
        fullTextPreview: citationContent.fullTextPreview,
        contentLength: citationContent.contentLength,
        contentHash: citationContent.contentHash,
      })
      .from(citationContent)
      .where(eq(citationContent.url, resource.url))
      .limit(1);

    return c.json({
      ...formatResource(resource),
      content: contentRows.length > 0 ? contentRows[0] : null,
    });
  })

  // ---- GET /citations/all (bulk citation index: resourceId → pageIds) ----

  .get("/citations/all", async (c) => {
    const HARD_LIMIT = 50000;
    const db = getDrizzleDb();
    // JOIN wiki_pages to recover slug from integer page ID
    const rows = await db
      .select({
        resourceId: resourceCitations.resourceId,
        pageId: wikiPages.slug,
      })
      .from(resourceCitations)
      .leftJoin(wikiPages, eq(wikiPages.id, resourceCitations.pageId))
      .limit(HARD_LIMIT + 1);

    const truncated = rows.length > HARD_LIMIT;
    if (truncated) rows.length = HARD_LIMIT; // discard the probe row

    // Group by resourceId
    const index: Record<string, string[]> = {};
    for (const row of rows) {
      if (!index[row.resourceId]) index[row.resourceId] = [];
      if (row.pageId) index[row.resourceId].push(row.pageId);
    }

    return c.json({ citations: index, count: rows.length, truncated });
  })

  // ---- PATCH /:id/fetch-status (update fetch status from source-fetcher) ----

  .patch("/:id/fetch-status", zv("json", UpdateResourceFetchStatusSchema), async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const { fetchStatus, lastFetchedAt, fetchedTitle } = c.req.valid("json");

    const updateSet: Record<string, unknown> = {
      fetchStatus,
      lastFetchedAt: new Date(lastFetchedAt),
      updatedAt: sql`now()`,
    };

    // Optionally update title if provided and resource has no title yet
    if (fetchedTitle) {
      updateSet.title = sql`COALESCE(${resources.title}, ${fetchedTitle})`;
    }

    const updated = await db
      .update(resources)
      .set(updateSet)
      .where(eq(resources.id, id))
      .returning({ id: resources.id });

    if (updated.length === 0) {
      return notFoundError(c, `Resource not found: ${id}`);
    }

    logger.info({ resourceId: id, fetchStatus, lastFetchedAt }, "Updated resource fetch status");

    return c.json({ ok: true, id, fetchStatus, lastFetchedAt });
  })

  // ---- GET /by-author-entity/:entityId ----
  // Returns resources where authorEntityIds contains the given entity stableId.

  .get("/by-author-entity/:entityId", async (c) => {
    const entityId = c.req.param("entityId");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(resources)
      .where(sql`${resources.authorEntityIds} @> ${JSON.stringify([entityId])}::jsonb`)
      .orderBy(desc(resources.publishedDate))
      .limit(100);

    return c.json({
      entityId,
      resources: rows.map(formatResource),
      total: rows.length,
    });
  })

  // ---- PATCH /author-entity-ids ----
  // Batch update authorEntityIds for resources (used by crux people link-resources).

  .patch("/author-entity-ids", zv("json", AuthorEntityIdsSchema), async (c) => {
    const db = getDrizzleDb();
    let updated = 0;

    // Batch update in a single transaction
    await db.transaction(async (tx) => {
      for (const item of c.req.valid("json").items) {
        const jsonText = JSON.stringify(item.authorEntityIds);
        await tx
          .update(resources)
          .set({ authorEntityIds: sql`${jsonText}::jsonb` })
          .where(eq(resources.id, item.resourceId));
        updated++;
      }
    });

    return c.json({ updated });
  })

  // ---- GET /:id/details (resource + sub-table data) ----

  .get("/:id/details", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(resources)
      .where(eq(resources.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Resource not found: ${id}`);
    }

    // Fetch sub-table data in parallel
    const [paperRows, forumRows, policyRows, citations] = await Promise.all([
      db.select().from(resourcePapers).where(eq(resourcePapers.resourceId, id)).limit(1),
      db.select().from(resourceForumPosts).where(eq(resourceForumPosts.resourceId, id)).limit(1),
      db.select().from(resourcePolicyDocs).where(eq(resourcePolicyDocs.resourceId, id)).limit(1),
      // JOIN wiki_pages to recover slug from integer page ID
      db.select({ pageId: wikiPages.slug })
        .from(resourceCitations)
        .leftJoin(wikiPages, eq(wikiPages.id, resourceCitations.pageId))
        .where(eq(resourceCitations.resourceId, id)),
    ]);

    return c.json({
      ...formatResource(rows[0]),
      paper: paperRows.length > 0 ? formatPaper(paperRows[0]) : null,
      forumPost: forumRows.length > 0 ? formatForumPost(forumRows[0]) : null,
      policyDoc: policyRows.length > 0 ? formatPolicyDoc(policyRows[0]) : null,
      citedBy: citations.map((row) => row.pageId).filter((p): p is string => p != null),
    });
  })

  // ---- POST /:id/paper (upsert resource_papers row) ----

  .post("/:id/paper", zv("json", UpsertResourcePaperSchema), async (c) => {
    const id = c.req.param("id");
    const data = c.req.valid("json");

    const db = getDrizzleDb();

    // Verify resource exists
    const resRows = await db.select({ id: resources.id }).from(resources).where(eq(resources.id, id)).limit(1);
    if (resRows.length === 0) return notFoundError(c, `Resource not found: ${id}`);

    try {
      await db
        .insert(resourcePapers)
        .values({
          resourceId: id,
          ...data,
          categories: data.categories ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: resourcePapers.resourceId,
          set: {
            arxivId: sql`COALESCE(${data.arxivId ?? null}, ${resourcePapers.arxivId})`,
            doi: sql`COALESCE(${data.doi ?? null}, ${resourcePapers.doi})`,
            semanticScholarId: sql`COALESCE(${data.semanticScholarId ?? null}, ${resourcePapers.semanticScholarId})`,
            abstract: sql`COALESCE(${data.abstract ?? null}, ${resourcePapers.abstract})`,
            citationCount: sql`COALESCE(${data.citationCount ?? null}, ${resourcePapers.citationCount})`,
            influentialCitationCount: sql`COALESCE(${data.influentialCitationCount ?? null}, ${resourcePapers.influentialCitationCount})`,
            categories: data.categories
              ? sql`COALESCE(${JSON.stringify(data.categories)}::jsonb, ${resourcePapers.categories})`
              : sql`COALESCE(null::jsonb, ${resourcePapers.categories})`,
            methodology: sql`COALESCE(${data.methodology ?? null}, ${resourcePapers.methodology})`,
            year: sql`COALESCE(${data.year ?? null}, ${resourcePapers.year})`,
            updatedAt: sql`now()`,
          },
        });

      return c.json({ ok: true, resourceId: id }, 201);
    } catch (err) {
      logger.error({ err, resourceId: id }, "paper upsert failed");
      return dbError(c, "paper upsert", err, { resourceId: id });
    }
  })

  // ---- POST /:id/forum-post (upsert resource_forum_posts row) ----

  .post("/:id/forum-post", zv("json", UpsertResourceForumPostSchema), async (c) => {
    const id = c.req.param("id");
    const data = c.req.valid("json");

    const db = getDrizzleDb();

    const resRows = await db.select({ id: resources.id }).from(resources).where(eq(resources.id, id)).limit(1);
    if (resRows.length === 0) return notFoundError(c, `Resource not found: ${id}`);

    try {
      await db
        .insert(resourceForumPosts)
        .values({
          resourceId: id,
          ...data,
          forumTags: data.forumTags ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: resourceForumPosts.resourceId,
          set: {
            forum: data.forum,
            forumPostId: sql`COALESCE(${data.forumPostId ?? null}, ${resourceForumPosts.forumPostId})`,
            forumSlug: sql`COALESCE(${data.forumSlug ?? null}, ${resourceForumPosts.forumSlug})`,
            karma: sql`COALESCE(${data.karma ?? null}, ${resourceForumPosts.karma})`,
            commentCount: sql`COALESCE(${data.commentCount ?? null}, ${resourceForumPosts.commentCount})`,
            authorUsername: sql`COALESCE(${data.authorUsername ?? null}, ${resourceForumPosts.authorUsername})`,
            forumTags: data.forumTags
              ? sql`COALESCE(${JSON.stringify(data.forumTags)}::jsonb, ${resourceForumPosts.forumTags})`
              : sql`COALESCE(null::jsonb, ${resourceForumPosts.forumTags})`,
            sequenceTitle: sql`COALESCE(${data.sequenceTitle ?? null}, ${resourceForumPosts.sequenceTitle})`,
            curated: data.curated != null ? data.curated : sql`${resourceForumPosts.curated}`,
            crossPostedFrom: sql`COALESCE(${data.crossPostedFrom ?? null}, ${resourceForumPosts.crossPostedFrom})`,
            canonicalForum: sql`COALESCE(${data.canonicalForum ?? null}, ${resourceForumPosts.canonicalForum})`,
            updatedAt: sql`now()`,
          },
        });

      return c.json({ ok: true, resourceId: id }, 201);
    } catch (err) {
      logger.error({ err, resourceId: id }, "forum-post upsert failed");
      return dbError(c, "forum-post upsert", err, { resourceId: id });
    }
  })

  // ---- POST /:id/policy-doc (upsert resource_policy_docs row) ----

  .post("/:id/policy-doc", zv("json", UpsertResourcePolicyDocSchema), async (c) => {
    const id = c.req.param("id");
    const data = c.req.valid("json");

    const db = getDrizzleDb();

    const resRows = await db.select({ id: resources.id }).from(resources).where(eq(resources.id, id)).limit(1);
    if (resRows.length === 0) return notFoundError(c, `Resource not found: ${id}`);

    try {
      await db
        .insert(resourcePolicyDocs)
        .values({
          resourceId: id,
          ...data,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: resourcePolicyDocs.resourceId,
          set: {
            documentType: sql`COALESCE(${data.documentType ?? null}, ${resourcePolicyDocs.documentType})`,
            jurisdictionEntityId: sql`COALESCE(${data.jurisdictionEntityId ?? null}, ${resourcePolicyDocs.jurisdictionEntityId})`,
            agencyEntityId: sql`COALESCE(${data.agencyEntityId ?? null}, ${resourcePolicyDocs.agencyEntityId})`,
            policyEntityId: sql`COALESCE(${data.policyEntityId ?? null}, ${resourcePolicyDocs.policyEntityId})`,
            effectiveDate: sql`COALESCE(${data.effectiveDate ?? null}, ${resourcePolicyDocs.effectiveDate})`,
            documentStatus: sql`COALESCE(${data.documentStatus ?? null}, ${resourcePolicyDocs.documentStatus})`,
            referenceNumber: sql`COALESCE(${data.referenceNumber ?? null}, ${resourcePolicyDocs.referenceNumber})`,
            updatedAt: sql`now()`,
          },
        });

      return c.json({ ok: true, resourceId: id }, 201);
    } catch (err) {
      logger.error({ err, resourceId: id }, "policy-doc upsert failed");
      return dbError(c, "policy-doc upsert", err, { resourceId: id });
    }
  })

  // ---- POST /batch-details (batch upsert sub-table rows) ----

  .post("/batch-details", zv("json", BatchDetailsSchema), async (c) => {
    const batchData = c.req.valid("json");

    const db = getDrizzleDb();
    const results = { papers: 0, forumPosts: 0, policyDocs: 0 };

    try {
      await db.transaction(async (tx) => {
        // Bulk upsert papers in one query
        if (batchData.papers && batchData.papers.length > 0) {
          const paperVals = batchData.papers.map((item) => ({
            resourceId: item.resourceId,
            arxivId: item.arxivId ?? null,
            doi: item.doi ?? null,
            semanticScholarId: item.semanticScholarId ?? null,
            abstract: item.abstract ?? null,
            citationCount: item.citationCount ?? null,
            influentialCitationCount: item.influentialCitationCount ?? null,
            categories: item.categories ?? null,
            methodology: item.methodology ?? null,
            year: item.year ?? null,
            updatedAt: new Date(),
          }));
          await tx
            .insert(resourcePapers)
            .values(paperVals)
            .onConflictDoUpdate({
              target: resourcePapers.resourceId,
              set: {
                arxivId: sql`COALESCE(excluded.arxiv_id, ${resourcePapers.arxivId})`,
                doi: sql`COALESCE(excluded.doi, ${resourcePapers.doi})`,
                semanticScholarId: sql`COALESCE(excluded.semantic_scholar_id, ${resourcePapers.semanticScholarId})`,
                abstract: sql`COALESCE(excluded.abstract, ${resourcePapers.abstract})`,
                citationCount: sql`COALESCE(excluded.citation_count, ${resourcePapers.citationCount})`,
                influentialCitationCount: sql`COALESCE(excluded.influential_citation_count, ${resourcePapers.influentialCitationCount})`,
                categories: sql`COALESCE(excluded.categories, ${resourcePapers.categories})`,
                methodology: sql`COALESCE(excluded.methodology, ${resourcePapers.methodology})`,
                year: sql`COALESCE(excluded.year, ${resourcePapers.year})`,
                updatedAt: sql`now()`,
              },
            });
          results.papers = batchData.papers.length;
        }

        // Bulk upsert forum posts in one query
        if (batchData.forumPosts && batchData.forumPosts.length > 0) {
          const forumVals = batchData.forumPosts.map((item) => ({
            resourceId: item.resourceId,
            forum: item.forum,
            forumPostId: item.forumPostId ?? null,
            forumSlug: item.forumSlug ?? null,
            karma: item.karma ?? null,
            commentCount: item.commentCount ?? null,
            authorUsername: item.authorUsername ?? null,
            forumTags: item.forumTags ?? null,
            sequenceTitle: item.sequenceTitle ?? null,
            curated: item.curated ?? null,
            crossPostedFrom: item.crossPostedFrom ?? null,
            canonicalForum: item.canonicalForum ?? null,
            updatedAt: new Date(),
          }));
          await tx
            .insert(resourceForumPosts)
            .values(forumVals)
            .onConflictDoUpdate({
              target: resourceForumPosts.resourceId,
              set: {
                forum: sql`excluded.forum`,
                forumPostId: sql`COALESCE(excluded.forum_post_id, ${resourceForumPosts.forumPostId})`,
                forumSlug: sql`COALESCE(excluded.forum_slug, ${resourceForumPosts.forumSlug})`,
                karma: sql`COALESCE(excluded.karma, ${resourceForumPosts.karma})`,
                commentCount: sql`COALESCE(excluded.comment_count, ${resourceForumPosts.commentCount})`,
                authorUsername: sql`COALESCE(excluded.author_username, ${resourceForumPosts.authorUsername})`,
                forumTags: sql`COALESCE(excluded.forum_tags, ${resourceForumPosts.forumTags})`,
                sequenceTitle: sql`COALESCE(excluded.sequence_title, ${resourceForumPosts.sequenceTitle})`,
                curated: sql`COALESCE(excluded.curated, ${resourceForumPosts.curated})`,
                crossPostedFrom: sql`COALESCE(excluded.cross_posted_from, ${resourceForumPosts.crossPostedFrom})`,
                canonicalForum: sql`COALESCE(excluded.canonical_forum, ${resourceForumPosts.canonicalForum})`,
                updatedAt: sql`now()`,
              },
            });
          results.forumPosts = batchData.forumPosts.length;
        }

        // Bulk upsert policy docs in one query
        if (batchData.policyDocs && batchData.policyDocs.length > 0) {
          const policyVals = batchData.policyDocs.map((item) => ({
            resourceId: item.resourceId,
            documentType: item.documentType ?? null,
            jurisdictionEntityId: item.jurisdictionEntityId ?? null,
            agencyEntityId: item.agencyEntityId ?? null,
            policyEntityId: item.policyEntityId ?? null,
            effectiveDate: item.effectiveDate ?? null,
            documentStatus: item.documentStatus ?? null,
            referenceNumber: item.referenceNumber ?? null,
            updatedAt: new Date(),
          }));
          await tx
            .insert(resourcePolicyDocs)
            .values(policyVals)
            .onConflictDoUpdate({
              target: resourcePolicyDocs.resourceId,
              set: {
                documentType: sql`COALESCE(excluded.document_type, ${resourcePolicyDocs.documentType})`,
                jurisdictionEntityId: sql`COALESCE(excluded.jurisdiction_entity_id, ${resourcePolicyDocs.jurisdictionEntityId})`,
                agencyEntityId: sql`COALESCE(excluded.agency_entity_id, ${resourcePolicyDocs.agencyEntityId})`,
                policyEntityId: sql`COALESCE(excluded.policy_entity_id, ${resourcePolicyDocs.policyEntityId})`,
                effectiveDate: sql`COALESCE(excluded.effective_date, ${resourcePolicyDocs.effectiveDate})`,
                documentStatus: sql`COALESCE(excluded.document_status, ${resourcePolicyDocs.documentStatus})`,
                referenceNumber: sql`COALESCE(excluded.reference_number, ${resourcePolicyDocs.referenceNumber})`,
                updatedAt: sql`now()`,
              },
            });
          results.policyDocs = batchData.policyDocs.length;
        }
      });

      return c.json({ ok: true, upserted: results }, 201);
    } catch (err) {
      logger.error({ err }, "batch-details upsert failed");
      return dbError(c, "batch-details upsert", err);
    }
  })

  // ---- GET /all-details (paginated listing with sub-table data) ----

  .get("/all-details", async (c) => {
    const parsed = PaginationQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { limit, offset, type } = parsed.data;
    const db = getDrizzleDb();

    const conditions: SQL | undefined = type
      ? eq(resources.type, type)
      : undefined;

    const rows = await db
      .select()
      .from(resources)
      .where(conditions)
      .orderBy(resources.id)
      .limit(limit)
      .offset(offset);

    if (rows.length === 0) {
      const countResult = await db.select({ count: count() }).from(resources).where(conditions);
      return c.json({ resources: [], total: countResult[0].count, limit, offset });
    }

    const ids = rows.map((r) => r.id);
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);

    // Fetch all sub-table rows for this page of resources in parallel
    const [paperRows, forumRows, policyRows] = await Promise.all([
      db.select().from(resourcePapers).where(sql`${resourcePapers.resourceId} IN (${idList})`),
      db.select().from(resourceForumPosts).where(sql`${resourceForumPosts.resourceId} IN (${idList})`),
      db.select().from(resourcePolicyDocs).where(sql`${resourcePolicyDocs.resourceId} IN (${idList})`),
    ]);

    // Index by resourceId
    const paperIndex = new Map(paperRows.map((r) => [r.resourceId, r]));
    const forumIndex = new Map(forumRows.map((r) => [r.resourceId, r]));
    const policyIndex = new Map(policyRows.map((r) => [r.resourceId, r]));

    const countResult = await db.select({ count: count() }).from(resources).where(conditions);

    return c.json({
      resources: rows.map((r) => ({
        ...formatResource(r),
        paper: paperIndex.has(r.id) ? formatPaper(paperIndex.get(r.id)!) : null,
        forumPost: forumIndex.has(r.id) ? formatForumPost(forumIndex.get(r.id)!) : null,
        policyDoc: policyIndex.has(r.id) ? formatPolicyDoc(policyIndex.get(r.id)!) : null,
      })),
      total: countResult[0].count,
      limit,
      offset,
    });
  })

  // ---- GET /:id (get by ID) ----

  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(resources)
      .where(eq(resources.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Resource not found: ${id}`);
    }

    // Also fetch citations and sub-table data
    // JOIN wiki_pages to recover slug from integer page ID
    const [citations, paperRows, forumRows, policyRows] = await Promise.all([
      db.select({ pageId: wikiPages.slug })
        .from(resourceCitations)
        .leftJoin(wikiPages, eq(wikiPages.id, resourceCitations.pageId))
        .where(eq(resourceCitations.resourceId, id)),
      db.select().from(resourcePapers).where(eq(resourcePapers.resourceId, id)).limit(1),
      db.select().from(resourceForumPosts).where(eq(resourceForumPosts.resourceId, id)).limit(1),
      db.select().from(resourcePolicyDocs).where(eq(resourcePolicyDocs.resourceId, id)).limit(1),
    ]);

    return c.json({
      ...formatResource(rows[0]),
      paper: paperRows.length > 0 ? formatPaper(paperRows[0]) : null,
      forumPost: forumRows.length > 0 ? formatForumPost(forumRows[0]) : null,
      policyDoc: policyRows.length > 0 ? formatPolicyDoc(policyRows[0]) : null,
      citedBy: citations.map((row) => row.pageId).filter((p): p is string => p != null),
    });
  });

export const resourcesRoute = resourcesApp;
export type ResourcesRoute = typeof resourcesApp;
