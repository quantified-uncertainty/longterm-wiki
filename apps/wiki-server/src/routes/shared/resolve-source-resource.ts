/**
 * Resolve source URLs to resource IDs for records with source columns.
 *
 * Used by sync endpoints to auto-populate sourceResourceId when a source URL
 * is provided but sourceResourceId is not. Runs within the sync transaction.
 */

import { sql } from "drizzle-orm";
import { resources } from "../../schema.js";
import { urlVariants } from "./url-variants.js";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../../schema.js";

type DbOrTx =
  | import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

/**
 * Batch-resolve source URLs to resource IDs.
 * Returns a Map<sourceUrl, resourceId> for all matched URLs.
 */
export async function resolveSourceResourceIds(
  tx: DbOrTx,
  sourceUrls: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(sourceUrls.filter(Boolean))];
  if (unique.length === 0) return new Map();

  // Build all URL variants for fuzzy matching
  const allVariants = new Map<string, string>(); // variant → original URL
  for (const url of unique) {
    for (const v of urlVariants(url)) {
      allVariants.set(v, url);
    }
  }

  const variantList = [...allVariants.keys()];
  const rows = await tx
    .select({ id: resources.id, url: resources.url })
    .from(resources)
    .where(sql`${resources.url} IN (${sql.join(variantList.map(v => sql`${v}`), sql`, `)})`);

  const result = new Map<string, string>();
  for (const row of rows) {
    // Map back to the original source URL
    const originalUrl = allVariants.get(row.url);
    if (originalUrl && !result.has(originalUrl)) {
      result.set(originalUrl, row.id);
    }
  }

  return result;
}
