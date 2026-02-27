import type { NavSection } from "@/lib/internal-nav";
import { fetchFromWikiServer } from "@lib/wiki-server";
import { getEntityById, getEntityHref } from "@data";
import type { ClaimsNetworkResult } from "@wiki-server/api-response-types";

export interface ClaimsEntityItem {
  entityId: string;
  title: string;
  href: string;
  claimCount: number;
  entityType: string;
}

/** Static nav sections for the claims explorer (no entity list). */
export async function getClaimsNav(): Promise<NavSection[]> {
  // Resolve fact-dashboard to its /wiki/E<id> URL if registered
  const factDashboardHref = getEntityHref("fact-dashboard");
  const resolvedFactHref = factDashboardHref.startsWith("/wiki/E")
    ? factDashboardHref
    : "/internal/fact-dashboard";

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
        { label: "Fact Dashboard", href: resolvedFactHref },
      ],
    },
  ];
}

/**
 * Fetch entity list for the searchable claims sidebar.
 * Returns ALL entities with claims, sorted by claim count descending.
 */
export async function getClaimsEntities(): Promise<ClaimsEntityItem[]> {
  const result = await fetchFromWikiServer<ClaimsNetworkResult>(
    "/api/claims/network",
    { revalidate: 300 }
  );

  if (!result) return [];

  return result.nodes
    .filter((n) => {
      // Include entities with primary claims
      if (n.claimCount > 0) return true;
      // Include mention-only entities if they're known wiki entities
      if ((n.mentionCount ?? 0) > 0 && getEntityById(n.entityId)) return true;
      return false;
    })
    .sort((a, b) => {
      // Sort by total relevance (primary claims + mentions)
      const totalA = a.claimCount + (a.mentionCount ?? 0);
      const totalB = b.claimCount + (b.mentionCount ?? 0);
      return totalB - totalA;
    })
    .map((n) => {
      const entity = getEntityById(n.entityId);
      return {
        entityId: n.entityId,
        title: entity?.title ?? n.entityId,
        href: `/claims/entity/${n.entityId}`,
        claimCount: n.claimCount + (n.mentionCount ?? 0),
        entityType: entity?.type ?? "unknown",
      };
    });
}
