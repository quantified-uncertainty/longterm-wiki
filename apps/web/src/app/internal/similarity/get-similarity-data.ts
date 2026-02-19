import {
  getAllPages,
  getTypedEntityById,
  getRelatedGraphFor,
  getEntityHref,
} from "@data/index";
import { ENTITY_TYPES } from "@data/entity-ontology";

export interface SimilarityNode {
  id: string;
  href: string;
  title: string;
  entityType: string;
  color: string;
  importance: number;
  quality: number;
  category: string;
}

export interface SimilarityEdge {
  source: string;
  target: string;
  score: number;
}

export interface SimilarityGraphData {
  nodes: SimilarityNode[];
  edges: SimilarityEdge[];
  entityTypes: { type: string; label: string; color: string; count: number }[];
}

function getColor(entityType: string): string {
  const def = ENTITY_TYPES[entityType];
  return def?.headerColor ?? "#6b7280";
}

export function getSimilarityGraphData(): SimilarityGraphData {
  const pages = getAllPages();

  // Filter to non-internal, non-insight pages
  const visiblePages = pages.filter(
    (p) => p.category !== "internal" && !p.id.startsWith("insight-")
  );

  const pageIds = new Set(visiblePages.map((p) => p.id));

  // Build nodes
  const nodes: SimilarityNode[] = visiblePages.map((p) => {
    const entity = getTypedEntityById(p.id);
    const entityType =
      (entity as { entityType?: string } | undefined)?.entityType ?? "unknown";
    return {
      id: p.id,
      href: getEntityHref(p.id),
      title: p.title,
      entityType,
      color: getColor(entityType),
      importance: p.readerImportance ?? 50,
      quality: p.quality ?? 30,
      category: p.category,
    };
  });

  // Build edges from relatedGraph (page-to-page only)
  const edgeMap = new Map<string, SimilarityEdge>();

  for (const page of visiblePages) {
    const related = getRelatedGraphFor(page.id);
    for (const r of related) {
      if (!pageIds.has(r.id)) continue;
      // Deduplicate: use sorted key
      const key =
        page.id < r.id ? `${page.id}|${r.id}` : `${r.id}|${page.id}`;
      const existing = edgeMap.get(key);
      // Take the max score for bidirectional edges
      if (!existing || r.score > existing.score) {
        edgeMap.set(key, {
          source: page.id < r.id ? page.id : r.id,
          target: page.id < r.id ? r.id : page.id,
          score: r.score,
        });
      }
    }
  }

  const edges = Array.from(edgeMap.values());

  // Compute entity type stats
  const typeCounts: Record<string, number> = {};
  for (const n of nodes) {
    typeCounts[n.entityType] = (typeCounts[n.entityType] || 0) + 1;
  }
  const entityTypes = Object.entries(typeCounts)
    .map(([type, count]) => ({
      type,
      label: ENTITY_TYPES[type]?.label ?? type,
      color: getColor(type),
      count,
    }))
    .sort((a, b) => b.count - a.count);

  return { nodes, edges, entityTypes };
}
