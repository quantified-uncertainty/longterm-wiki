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

const MAX_URL_LENGTH = 2048;
const MAX_BATCH = 200;

const VALID_STATUSES = ["pending", "approved", "rejected", "auto_verified"] as const;
type Status = (typeof VALID_STATUSES)[number];

const SuggestionInput = z.object({
  recordType: z.string().min(1).max(50),
  recordId: z.string().min(1).max(500),
  fieldName: z.string().max(200).nullable().optional(),
  entityId: z.string().max(200).nullable().optional(),
  suggestedUrl: z.string().url().max(MAX_URL_LENGTH),
  title: z.string().max(500).nullable().optional(),
  snippet: z.string().max(2000).nullable().optional(),
  relevanceScore: z.number().min(0).max(1).nullable().optional(),
  sourceProvider: z.string().min(1).max(50),
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
  notes: z.string().max(2000).nullable().optional(),
});

const urlSuggestionsApp = new Hono()
  .post("/", async (c) => {
    const raw = await parseJsonBody(c);
    if (raw == null) return invalidJsonError(c);
    const parsed = BatchUpsertBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { suggestions } = parsed.data;

    try {
      const db = getDrizzleDb();
      // COALESCE-based conflict target cannot be expressed via Drizzle's typed
      // .onConflictDoUpdate(), so we use raw SQL per-row. The matching unique
      // index lives in migration 0176. Batch is bounded by Zod (MAX_BATCH=200).
      let upserted = 0;
      for (const s of suggestions) {
        await db.execute(sql`
          INSERT INTO sourcing_url_suggestions (
            record_type, record_id, field_name, entity_id,
            suggested_url, title, snippet, relevance_score,
            source_provider, generator_model, status, notes,
            created_at, updated_at
          ) VALUES (
            ${s.recordType},
            ${s.recordId},
            ${s.fieldName ?? null},
            ${s.entityId ?? null},
            ${s.suggestedUrl},
            ${s.title ?? null},
            ${s.snippet ?? null},
            ${s.relevanceScore ?? null},
            ${s.sourceProvider},
            ${s.generatorModel ?? null},
            ${s.status},
            ${s.notes ?? null},
            NOW(), NOW()
          )
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
        `);
        upserted += 1;
      }
      return c.json({ upserted });
    } catch (err) {
      return dbError(c, "url-suggestions upsert", err, {
        batchSize: suggestions.length,
      });
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

      return c.json({ suggestions: rows, count: rows.length });
    } catch (err) {
      return dbError(c, "url-suggestions query", err);
    }
  })
  .patch("/:id{[0-9]+}", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) {
      return validationError(c, "id must be a positive integer");
    }

    const raw = await parseJsonBody(c);
    if (raw == null) return invalidJsonError(c);
    const parsed = PatchBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { status, reviewedBy, notes } = parsed.data;
    const now = new Date();

    try {
      const db = getDrizzleDb();
      const updated = await db
        .update(sourcingUrlSuggestions)
        .set({
          status,
          reviewedBy: reviewedBy ?? null,
          notes: notes ?? undefined, // preserve existing when undefined
          reviewedAt: now,
          updatedAt: now,
        })
        .where(eq(sourcingUrlSuggestions.id, id))
        .returning({ id: sourcingUrlSuggestions.id });

      if (updated.length === 0) {
        return notFoundError(c, `suggestion ${id} not found`);
      }
      return c.json({ ok: true, id });
    } catch (err) {
      return dbError(c, "url-suggestions patch", err, { id });
    }
  });

export const urlSuggestionsRoute = urlSuggestionsApp;
export type UrlSuggestionsRoute = typeof urlSuggestionsApp;

export { VALID_STATUSES };
export type { Status };
