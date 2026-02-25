import type { NavSection } from "@/lib/internal-nav";
import { fetchFromWikiServer } from "@lib/wiki-server";
import { getEntityById } from "@data";

interface NetworkResponse {
  nodes: { entityId: string; claimCount: number }[];
  edges: { source: string; target: string; weight: number }[];
}

/** Max entities shown in sidebar before truncating with a "Browse all" link */
const MAX_SIDEBAR_ENTITIES = 20;

/**
 * Build sidebar navigation for the Claims Explorer section.
 * Uses the network endpoint to get ALL entities with claims (not just first 200).
 * Entities are sorted by claim count (descending) so the most active appear first.
 */
export async function getClaimsNav(): Promise<NavSection[]> {
  const sections: NavSection[] = [
    {
      title: "Explorer",
      defaultOpen: true,
      items: [
        { label: "Overview", href: "/claims" },
        { label: "Browse Claims", href: "/claims/explore" },
        { label: "Relationships", href: "/claims/relationships" },
        { label: "Network", href: "/claims/network" },
      ],
    },
  ];

  // Use the network endpoint which returns ALL entities with claims
  const result = await fetchFromWikiServer<NetworkResponse>(
    "/api/claims/network",
    { revalidate: 300 }
  );

  if (result) {
    // Only show entities that have claims extracted FROM them (claimCount > 0)
    // Sort by claim count descending so the most active appear first
    const sorted = result.nodes
      .filter((n) => n.claimCount > 0)
      .sort((a, b) => b.claimCount - a.claimCount);

    if (sorted.length > 0) {
      const displayed = sorted.slice(0, MAX_SIDEBAR_ENTITIES);
      const items = displayed.map((n) => {
        const entity = getEntityById(n.entityId);
        return {
          label: `${entity?.title ?? n.entityId} (${n.claimCount})`,
          href: `/claims/entity/${n.entityId}`,
        };
      });

      // If there are more entities than the cap, add a "Browse all" link
      if (sorted.length > MAX_SIDEBAR_ENTITIES) {
        items.push({
          label: `Browse all ${sorted.length} entities...`,
          href: "/claims/explore",
        });
      }

      sections.push({
        title: `Entities (${sorted.length})`,
        items,
      });
    }
  }

  return sections;
}
