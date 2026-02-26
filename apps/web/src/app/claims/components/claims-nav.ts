import type { NavSection } from "@/lib/internal-nav";
import { fetchFromWikiServer } from "@lib/wiki-server";
import { getEntityById } from "@data";

interface NetworkResponse {
  nodes: { entityId: string; claimCount: number }[];
  edges: { source: string; target: string; weight: number }[];
}

export interface ClaimsEntityItem {
  entityId: string;
  title: string;
  href: string;
  claimCount: number;
  entityType: string;
}

/** Static nav sections for the claims explorer (no entity list). */
export async function getClaimsNav(): Promise<NavSection[]> {
  return [
    {
      title: "Explorer",
      defaultOpen: true,
      items: [
        { label: "Overview", href: "/claims" },
        { label: "Browse Claims", href: "/claims/explore" },
        { label: "Relationships", href: "/claims/relationships" },
        { label: "Network", href: "/claims/network" },
        { label: "Publications", href: "/claims/publications" },
        { label: "Resources", href: "/claims/resources" },
      ],
    },
  ];
}

/**
 * Fetch entity list for the searchable claims sidebar.
 * Returns ALL entities with claims, sorted by claim count descending.
 */
export async function getClaimsEntities(): Promise<ClaimsEntityItem[]> {
  const result = await fetchFromWikiServer<NetworkResponse>(
    "/api/claims/network",
    { revalidate: 300 }
  );

  if (!result) return [];

  return result.nodes
    .filter((n) => n.claimCount > 0)
    .sort((a, b) => b.claimCount - a.claimCount)
    .map((n) => {
      const entity = getEntityById(n.entityId);
      return {
        entityId: n.entityId,
        title: entity?.title ?? n.entityId,
        href: `/claims/entity/${n.entityId}`,
        claimCount: n.claimCount,
        entityType: entity?.type ?? "unknown",
      };
    });
}
