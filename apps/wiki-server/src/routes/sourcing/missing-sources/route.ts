/**
 * Missing Sources — returns records across tables where source IS NULL,
 * and a companion endpoint to update the source URL for a single record.
 *
 * Used by `crux tb backfill-sources` to get the work queue for source URL
 * discovery and to write back a discovered URL without touching other columns.
 *
 * GET  /              — All records missing sources, grouped by table
 * POST /update-source — Update source/url column for a single record
 */

import { Hono } from "hono";
import { z } from "zod";
import { getDrizzleDb } from "../../../db.js";
import { zv } from "../../shared/utils.js";
import { TABLE_QUERIES, safeQuery, type TableResult } from "./queries.js";
import { UPDATE_BY_TABLE, UPDATE_TABLE_KEYS } from "./updates.js";

const MissingSourcesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  table: z.string().max(50).optional(),
});

const UpdateSourceBody = z.object({
  table: z.enum(UPDATE_TABLE_KEYS),
  recordId: z.string().min(1).max(100),
  url: z.string().url().max(2000),
});

const missingSourcesApp = new Hono()
  .get("/", zv("query", MissingSourcesQuery), async (c) => {
    const { limit, table: tableFilter } = c.req.valid("query");
    const db = getDrizzleDb();
    const cap = Math.min(limit, 2000);

    const tables: Record<string, TableResult> = {};
    let totalMissing = 0;

    for (const [name, query] of Object.entries(TABLE_QUERIES)) {
      if (tableFilter && tableFilter !== name) continue;
      const result = await safeQuery(name, () => query(db, cap));
      tables[name] = result;
      totalMissing += result.total;
    }

    return c.json({ tables, totalMissing });
  })
  .post("/update-source", zv("json", UpdateSourceBody), async (c) => {
    const { table, recordId, url } = c.req.valid("json");
    const db = getDrizzleDb();

    // Numeric-ID tables reject non-numeric recordIds before we hit the query,
    // otherwise Number("abc") → NaN silently matches nothing.
    if ((table === "facts" || table === "page_citations") && !/^\d+$/.test(recordId)) {
      return c.json({ updated: 0, error: "recordId must be numeric for this table" }, 400);
    }

    try {
      const updated = await UPDATE_BY_TABLE[table](db, recordId, url);
      return c.json({ updated });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[update-source] ${table}/${recordId}: ${msg}`);
      return c.json({ updated: 0, error: "internal update failure" }, 500);
    }
  });

export const missingSourcesRoute = missingSourcesApp;
export type MissingSourcesRoute = typeof missingSourcesApp;
