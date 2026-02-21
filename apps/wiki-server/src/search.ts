/**
 * In-memory MiniSearch module for wiki page search.
 *
 * Reuses the same MiniSearch configuration (fields, boosts, fuzzy, re-ranking)
 * as the frontend search in apps/web/src/lib/search.ts.
 * Loads documents from the wiki_pages PostgreSQL table.
 */

import MiniSearch from "minisearch";
import { getDrizzleDb } from "./db.js";
import { wikiPages } from "./schema.js";

const SEARCH_FIELDS = [
  "title",
  "description",
  "llmSummary",
  "tags",
  "entityType",
  "id",
];

const FIELD_BOOSTS: Record<string, number> = {
  title: 3.0,
  description: 2.0,
  llmSummary: 1.5,
  tags: 1.5,
  entityType: 1.0,
  id: 1.0,
};

export interface PageSearchResult {
  id: string;
  score: number;
  title: string;
  description: string;
  numericId: string | null;
  entityType: string | null;
  category: string | null;
  readerImportance: number | null;
  quality: number | null;
}

interface PageMetadata {
  title: string;
  description: string | null;
  numericId: string | null;
  entityType: string | null;
  category: string | null;
  readerImportance: number | null;
  quality: number | null;
}

let miniSearch: MiniSearch | null = null;
let docsMap: Map<string, PageMetadata> | null = null;

/**
 * Build/rebuild the search index from the wiki_pages database table.
 * Returns the number of documents indexed.
 */
export async function rebuildSearchIndex(): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db
    .select({
      id: wikiPages.id,
      title: wikiPages.title,
      description: wikiPages.description,
      llmSummary: wikiPages.llmSummary,
      tags: wikiPages.tags,
      entityType: wikiPages.entityType,
      numericId: wikiPages.numericId,
      category: wikiPages.category,
      readerImportance: wikiPages.readerImportance,
      quality: wikiPages.quality,
    })
    .from(wikiPages);

  miniSearch = new MiniSearch({
    fields: SEARCH_FIELDS,
    storeFields: [],
  });

  docsMap = new Map();

  const docs = rows.map((r) => {
    docsMap!.set(r.id, {
      title: r.title,
      description: r.description,
      numericId: r.numericId,
      entityType: r.entityType,
      category: r.category,
      readerImportance: r.readerImportance,
      quality: r.quality,
    });

    // Tags are stored as JSON array string (e.g. '["ai","safety"]').
    // Parse and space-join for MiniSearch so individual tags are searchable.
    let tagsText = "";
    if (r.tags) {
      try {
        const parsed = JSON.parse(r.tags);
        tagsText = Array.isArray(parsed) ? parsed.join(" ") : r.tags;
      } catch {
        tagsText = r.tags;
      }
    }

    return {
      id: r.id,
      title: r.title,
      description: r.description ?? "",
      llmSummary: r.llmSummary ?? "",
      tags: tagsText,
      entityType: r.entityType ?? "",
    };
  });

  miniSearch.addAll(docs);
  return docs.length;
}

/**
 * Search the index. Uses the same ranking as the frontend:
 * - MiniSearch fuzzy + prefix search with field boosts
 * - Re-ranking: exact title match (3x boost) + importance tiebreaker
 */
export function search(query: string, limit = 20): PageSearchResult[] {
  if (!miniSearch || !docsMap || !query.trim()) return [];

  const raw = miniSearch.search(query, {
    boost: FIELD_BOOSTS,
    fuzzy: 0.2,
    prefix: true,
  });

  const q = query.trim().toLowerCase();

  const scored = raw.map((hit) => {
    const meta = docsMap!.get(hit.id);
    const title = (meta?.title ?? "").toLowerCase();

    let boost = 1.0;
    if (title === q) boost *= 3.0;
    boost *= 1 + (meta?.readerImportance ?? 0) / 300;

    return {
      id: hit.id,
      score: hit.score * boost,
      title: meta?.title ?? hit.id,
      description: meta?.description ?? "",
      numericId: meta?.numericId ?? null,
      entityType: meta?.entityType ?? null,
      category: meta?.category ?? null,
      readerImportance: meta?.readerImportance ?? null,
      quality: meta?.quality ?? null,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Initialize the search index on server startup.
 * Silently skips if the wiki_pages table is empty.
 */
export async function initSearch(): Promise<void> {
  try {
    const count = await rebuildSearchIndex();
    console.log(`Search index: ${count} pages indexed`);
  } catch (err) {
    console.warn("Search index initialization failed (table may be empty):", err);
  }
}

/**
 * Returns the number of indexed documents, or 0 if not initialized.
 */
export function getIndexedCount(): number {
  return docsMap?.size ?? 0;
}
