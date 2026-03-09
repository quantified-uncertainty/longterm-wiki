/**
 * Explore page data: items from entities, pages, and diagrams.
 */

import { getDatabase, getTypedEntities, isRisk } from "./database";
import type { ContentFormat, RawEntity, AnyEntity } from "./database";
import { getEntityHref } from "./entity-nav";

export interface ExploreItem {
  id: string;
  numericId: string;
  title: string;
  type: string;
  description: string | null;
  tags: string[];
  clusters: string[];
  wordCount: number | null;
  quality: number | null;
  readerImportance: number | null;
  researchImportance: number | null;
  tacticalValue: number | null;
  backlinkCount: number | null;
  category: string | null;
  riskCategory: string | null;
  lastUpdated: string | null;
  dateCreated?: string | null;
  contentFormat?: ContentFormat;
  href?: string;
  meta?: string;
  sourceTitle?: string;
  /** Pre-computed blended score for "recommended" sort (build-time) */
  recommendedScore?: number;
}

// Map page categories to entity-like types for display
const CATEGORY_TO_TYPE: Record<string, string> = {
  responses: "approach",
  organizations: "organization",
  people: "person",
  factors: "model",
  "intelligence-paradigms": "capability",
  models: "model",
  scenarios: "model",
  reports: "analysis",
  cruxes: "crux",
  worldviews: "concept",
  risks: "risk",
  forecasting: "model",
  "foundation-models": "capability",
  incidents: "historical",
  internal: "internal",
  other: "concept",
};

// Table items are now derived from pages with contentFormat=table.
// The hardcoded TABLES array has been eliminated — all table pages are
// detected automatically via the contentFormat field in frontmatter.

// Resolve the page ID for an entity, handling cases where entity ID differs
// from page ID (e.g., entity "tmc-compute" → page "compute").
function resolvePageId(entity: AnyEntity, pageMap: Map<string, unknown>): string | null {
  // 1. Direct match: entity ID is the page ID
  if (pageMap.has(entity.id)) return entity.id;
  // 2. Entity has explicit path field → derive page ID from path
  const raw = entity as unknown as RawEntity;
  if (raw.path) {
    const segments = raw.path.replace(/\/$/, "").split("/");
    const pageId = segments[segments.length - 1];
    if (pageId && pageMap.has(pageId)) return pageId;
  }
  // 3. Factor entities: try "factors-{id}-overview" pattern
  const overviewId = `factors-${entity.id}-overview`;
  if (pageMap.has(overviewId)) return overviewId;
  return null;
}

export function getExploreItems(): ExploreItem[] {
  const db = getDatabase();
  const typedEntities = getTypedEntities();
  const pageMap = new Map((db.pages || []).map((p) => [p.id, p]));

  // Build a set of page IDs claimed by entities (including aliased ones)
  const entityClaimedPageIds = new Set<string>();
  const entityPageIdMap = new Map<string, string>(); // entity.id → resolved page ID
  for (const entity of typedEntities) {
    const pageId = resolvePageId(entity, pageMap);
    if (pageId) {
      entityClaimedPageIds.add(pageId);
      entityPageIdMap.set(entity.id, pageId);
    }
  }

  // Items from typed entities (only those with actual content pages and numeric IDs)
  const entityItems: ExploreItem[] = typedEntities.filter((entity) => {
    const pageId = entityPageIdMap.get(entity.id);
    if (!pageId) return false;
    const numId = entity.numericId || db.idRegistry?.bySlug[pageId];
    return !!numId;
  }).map((entity) => {
    const pageId = entityPageIdMap.get(entity.id)!;
    const page = pageMap.get(pageId)!;
    return {
      id: entity.id,
      numericId: (entity.numericId || db.idRegistry?.bySlug[pageId])!,
      title: entity.title,
      type: page?.contentFormat === "table" ? "table" : page?.contentFormat === "diagram" ? "diagram" : entity.entityType,
      description: page?.llmSummary || page?.description || entity.description || null,
      tags: entity.tags || [],
      clusters: entity.clusters?.length ? entity.clusters : (page?.clusters || []),
      wordCount: page?.wordCount ?? null,
      quality: page?.quality ?? null,
      readerImportance: page?.readerImportance ?? null,
      researchImportance: page?.researchImportance ?? null,
      tacticalValue: page?.tacticalValue ?? null,
      backlinkCount: page?.backlinkCount ?? null,
      category: page?.category ?? null,
      riskCategory: isRisk(entity) ? (entity.riskCategory || null) : null,
      lastUpdated: page?.lastUpdated ?? null,
      dateCreated: page?.dateCreated ?? null,
      contentFormat: page?.contentFormat,
      recommendedScore: page?.recommendedScore,
    };
  });

  // Items from pages that have no entity (only those with numeric IDs)
  const pageOnlyItems: ExploreItem[] = (db.pages || [])
    .filter((p) => !entityClaimedPageIds.has(p.id))
    .filter((p) => p.title && p.category !== "schema")
    .filter((p) => db.idRegistry?.bySlug[p.id])
    .map((page) => ({
      id: page.id,
      numericId: db.idRegistry!.bySlug[page.id],
      title: page.title,
      type: page.contentFormat === "table" ? "table" : page.contentFormat === "diagram" ? "diagram" : CATEGORY_TO_TYPE[page.category] || "concept",
      description: page.llmSummary || page.description || null,
      tags: page.tags || [],
      clusters: page.clusters || [],
      wordCount: page.wordCount ?? null,
      quality: page.quality ?? null,
      readerImportance: page.readerImportance ?? null,
      researchImportance: page.researchImportance ?? null,
      tacticalValue: page.tacticalValue ?? null,
      backlinkCount: page.backlinkCount ?? null,
      category: page.category ?? null,
      riskCategory: null,
      lastUpdated: page.lastUpdated ?? null,
      dateCreated: page.dateCreated ?? null,
      contentFormat: page.contentFormat,
      recommendedScore: page.recommendedScore,
    }));

  // Diagram items — entities with causeEffectGraph data
  // Generic entities preserve all raw fields including causeEffectGraph.
  // Entity IDs may differ from page IDs, resolved via resolvePageId above.
  function resolveDiagramHref(e: AnyEntity): string | null {
    const pageId = resolvePageId(e, pageMap);
    if (!pageId) return null;
    const numId = db.idRegistry?.bySlug[pageId];
    return numId ? `/wiki/${numId}` : `/wiki/${pageId}`;
  }

  const diagramItems: ExploreItem[] = typedEntities
    .filter((e) => {
      const ceg = (e as unknown as RawEntity).causeEffectGraph;
      if (!ceg?.nodes?.length) return false;
      // Only include diagrams that resolve to a valid page
      return resolveDiagramHref(e) !== null;
    })
    .map((e) => {
      const ceg = (e as unknown as RawEntity).causeEffectGraph!;
      const nodeCount = ceg.nodes?.length || 0;
      return {
        id: `diagram-${e.id}`,
        numericId: `diagram-${e.id}`,
        title: ceg.title || e.title,
        type: "diagram",
        description: ceg.description || `Cause-effect diagram for ${e.title}`,
        tags: [] as string[],
        clusters: ["ai-safety"],
        wordCount: null,
        quality: null,
        readerImportance: null,
        researchImportance: null,
        tacticalValue: null,
        backlinkCount: null,
        category: null,
        riskCategory: null,
        lastUpdated: e.lastUpdated || null,
        dateCreated: null,
        contentFormat: "diagram" as ContentFormat,
        href: resolveDiagramHref(e)!,
        meta: `${nodeCount} nodes`,
      };
    });

  return [...entityItems, ...pageOnlyItems, ...diagramItems];
}
