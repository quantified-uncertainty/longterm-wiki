import type { NavSection } from "@/lib/internal-nav";
import { fetchFromWikiServer } from "@lib/wiki-server";
import { getEntityById, getEntityHref } from "@data";

export interface StatementEntityItem {
  entityId: string;
  title: string;
  href: string;
  statementCount: number;
  entityType: string;
}

export interface PropertyCategoryItem {
  category: string;
  statementCount: number;
  propertyCount: number;
}

/** Static nav sections for the statements explorer. */
export async function getStatementsNav(): Promise<NavSection[]> {
  const propertyExplorerHref = getEntityHref("property-explorer-dashboard");
  const resolvedPropHref = propertyExplorerHref.startsWith("/wiki/E")
    ? propertyExplorerHref
    : "/statements/properties";

  return [
    {
      title: "Explorer",
      defaultOpen: true,
      items: [
        { label: "Overview", href: "/statements" },
        { label: "Browse Statements", href: "/statements/browse" },
        { label: "Properties", href: "/statements/properties" },
      ],
    },
  ];
}

/**
 * Fetch property categories with statement counts for the sidebar.
 */
export async function getStatementCategories(): Promise<
  PropertyCategoryItem[]
> {
  const result = await fetchFromWikiServer<{
    properties: {
      id: string;
      label: string;
      category: string;
      statementCount: number;
    }[];
  }>("/api/statements/properties", { revalidate: 300 });

  if (!result) return [];

  // Aggregate by category
  const categoryMap = new Map<
    string,
    { statementCount: number; propertyCount: number }
  >();
  for (const p of result.properties) {
    const entry = categoryMap.get(p.category) ?? {
      statementCount: 0,
      propertyCount: 0,
    };
    entry.statementCount += p.statementCount;
    entry.propertyCount += 1;
    categoryMap.set(p.category, entry);
  }

  return [...categoryMap.entries()]
    .map(([category, data]) => ({
      category,
      ...data,
    }))
    .sort((a, b) => b.statementCount - a.statementCount);
}

/**
 * Fetch entity list for the statements sidebar.
 * Returns entities with statement counts, sorted by count descending.
 */
export async function getStatementEntities(): Promise<StatementEntityItem[]> {
  // Paginate through all active statements (API max page size is 500)
  const PAGE_SIZE = 500;
  const allStatements: { subjectEntityId: string }[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const result = await fetchFromWikiServer<{
      statements: { subjectEntityId: string }[];
      total: number;
    }>(`/api/statements?limit=${PAGE_SIZE}&offset=${offset}&status=active`, {
      revalidate: 300,
    });

    if (!result) break;
    total = result.total;
    allStatements.push(...result.statements);
    offset += PAGE_SIZE;
  }

  if (allStatements.length === 0) return [];

  // Count statements per entity
  const entityCounts = new Map<string, number>();
  for (const s of allStatements) {
    entityCounts.set(
      s.subjectEntityId,
      (entityCounts.get(s.subjectEntityId) ?? 0) + 1
    );
  }

  return [...entityCounts.entries()]
    .map(([entityId, count]) => {
      const entity = getEntityById(entityId);
      return {
        entityId,
        title: entity?.title ?? entityId,
        href: `/statements/entity/${entityId}`,
        statementCount: count,
        entityType: entity?.type ?? "unknown",
      };
    })
    .sort((a, b) => b.statementCount - a.statementCount);
}
