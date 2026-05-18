/**
 * URL suggestions for unverifiable verdicts — QUA-64.
 *
 * Stores web-search-generated candidate URLs for records where sourcing
 * returned `unverifiable`. Composite identity matches the sourcing verdicts
 * table (recordType, recordId, fieldName).
 *
 * Endpoints:
 *   POST /api/sourcing/url-suggestions        — batch upsert
 *   GET  /api/sourcing/url-suggestions        — query (by record / entity / status)
 *   PATCH /api/sourcing/url-suggestions/:id   — update status (approve / reject)
 */

import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { sourcingUrlSuggestions } from "../../schema.js";
import {
  zv,
  clampedLimit,
  parseJsonBody,
  validationError,
  invalidJsonError,
  dbError,
  notFoundError,
} from "../shared/utils.js";
import {
  VALID_SUGGESTION_STATUSES,
  type SuggestionStatus,
} from "../../api-types.js";

const MAX_BATCH = 200;

// Re-export so the small set of importers that read these from the route
// file continue to work; the canonical definition now lives in api-types
// where the worker container can reach it.
export { VALID_SUGGESTION_STATUSES };
export type { SuggestionStatus };

const VALID_STATUSES = VALID_SUGGESTION_STATUSES;

/** Providers known to the suggest-urls generator. */
export const VALID_SOURCE_PROVIDERS = [
  "exa",
  "perplexity",
  "scry",
  "manual",
] as const;
export type SourceProvider = (typeof VALID_SOURCE_PROVIDERS)[number];

const SuggestionInput = z.object({
  recordType: z.string().min(1).max(50),
  recordId: z.string().min(1).max(500),
  fieldName: z.string().max(200).nullable().optional(),
  entityId: z.string().max(200).nullable().optional(),
  suggestedUrl: z.string().url().max(2048),
  title: z.string().max(500).nullable().optional(),
  snippet: z.string().max(2000).nullable().optional(),
  relevanceScore: z.number().min(0).max(1).nullable().optional(),
  sourceProvider: z.enum(VALID_SOURCE_PROVIDERS),
  generatorModel: z.string().max(100).nullable().optional(),
  status: z.enum(VALID_STATUSES).default("pending"),
  notes: z.string().max(2000).nullable().optional(),
});

const BatchUpsertBody = z.object({
  suggestions: z.array(SuggestionInput).min(1).max(MAX_BATCH),
});

const QuerySchema = z.object({
  recordType: z.string().max(50).optional(),
  recordId: z.string().max(500).optional(),
  entityId: z.string().max(200).optional(),
  status: z.enum(VALID_STATUSES).optional(),
  limit: clampedLimit(MAX_BATCH, 50),
  offset: z.coerce.number().int().min(0).default(0),
});

const PatchBody = z.object({
  status: z.enum(VALID_STATUSES),
  reviewedBy: z.string().max(200).optional(),
  // `null` explicitly clears the notes column; omitting the key preserves it.
  notes: z.string().max(2000).nullable().optional(),
});

const urlSuggestionsApp = new Hono()
  .post("/", async (c) => {
    const raw = await parseJsonBody(c);
    if (raw == null) return invalidJsonError(c);
    const parsed = BatchUpsertBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { suggestions } = parsed.data;

    // COALESCE-based conflict target cannot be expressed via Drizzle's typed
    // .onConflictDoUpdate(), so we emit a multi-row VALUES list as raw SQL.
    // The matching unique index lives in migration 0176.
    const valueRows = suggestions.map(
      (s) => sql`(
        ${s.recordType}, ${s.recordId}, ${s.fieldName ?? null}, ${s.entityId ?? null},
        ${s.suggestedUrl}, ${s.title ?? null}, ${s.snippet ?? null}, ${s.relevanceScore ?? null},
        ${s.sourceProvider}, ${s.generatorModel ?? null}, ${s.status}, ${s.notes ?? null},
        NOW(), NOW()
      )`
    );

    try {
      await getDrizzleDb().transaction((tx) =>
        tx.execute(sql`
          INSERT INTO sourcing_url_suggestions (
            record_type, record_id, field_name, entity_id,
            suggested_url, title, snippet, relevance_score,
            source_provider, generator_model, status, notes,
            created_at, updated_at
          ) VALUES ${sql.join(valueRows, sql`, `)}
          ON CONFLICT (record_type, record_id, COALESCE(field_name, ''), suggested_url)
          DO UPDATE SET
            title = EXCLUDED.title,
            snippet = EXCLUDED.snippet,
            relevance_score = EXCLUDED.relevance_score,
            source_provider = EXCLUDED.source_provider,
            generator_model = EXCLUDED.generator_model,
            entity_id = EXCLUDED.entity_id,
            -- Preserve human decisions on re-generation: only overwrite status if still pending.
            status = CASE
              WHEN sourcing_url_suggestions.status = 'pending' THEN EXCLUDED.status
              ELSE sourcing_url_suggestions.status
            END,
            notes = COALESCE(EXCLUDED.notes, sourcing_url_suggestions.notes),
            updated_at = NOW()
        `)
      );
      return c.json({ upserted: suggestions.length });
    } catch (err) {
      return dbError(c, "url-suggestions upsert", err, { batchSize: suggestions.length });
    }
  })
  .get("/", zv("query", QuerySchema), async (c) => {
    const { recordType, recordId, entityId, status, limit, offset } =
      c.req.valid("query");

    const conditions = [];
    if (recordType) conditions.push(eq(sourcingUrlSuggestions.recordType, recordType));
    if (recordId) conditions.push(eq(sourcingUrlSuggestions.recordId, recordId));
    if (entityId) conditions.push(eq(sourcingUrlSuggestions.entityId, entityId));
    if (status) conditions.push(eq(sourcingUrlSuggestions.status, status));

    try {
      const db = getDrizzleDb();
      const rows = await db
        .select()
        .from(sourcingUrlSuggestions)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(sourcingUrlSuggestions.createdAt))
        .limit(limit)
        .offset(offset);

      // `returned` is the page size, not the total match count. A separate
      // COUNT(*) would double the query cost; callers that need pagination
      // totals should add an explicit `total=1` param in a follow-up.
      return c.json({ suggestions: rows, returned: rows.length });
    } catch (err) {
      return dbError(c, "url-suggestions query", err);
    }
  })
  .patch("/:id{[0-9]+}", async (c) => {
    const id = Number(c.req.param("id"));

    const raw = await parseJsonBody(c);
    if (raw == null) return invalidJsonError(c);
    const parsed = PatchBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    // Distinguish "notes omitted" (preserve) from "notes: null" (clear) against
    // the raw body — Zod can elide undefined keys on parse.
    const notesKeyPresent =
      typeof raw === "object" && raw !== null && "notes" in raw;
    const now = new Date();

    try {
      const updated = await getDrizzleDb()
        .update(sourcingUrlSuggestions)
        .set({
          status: parsed.data.status,
          reviewedBy: parsed.data.reviewedBy ?? null,
          reviewedAt: now,
          updatedAt: now,
          // Drizzle skips `undefined` fields but writes `null` as SQL NULL.
          ...(notesKeyPresent && { notes: parsed.data.notes ?? null }),
        })
        .where(eq(sourcingUrlSuggestions.id, id))
        .returning({ id: sourcingUrlSuggestions.id });

      if (updated.length === 0) return notFoundError(c, `suggestion ${id} not found`);
      return c.json({ ok: true, id });
    } catch (err) {
      return dbError(c, "url-suggestions patch", err, { id });
    }
  });

export const urlSuggestionsRoute = urlSuggestionsApp;
export type UrlSuggestionsRoute = typeof urlSuggestionsApp;
