import type { NavSection } from "@/lib/internal-nav";
import { fetchFromWikiServer } from "@lib/wiki-server";
import type { ClaimRow } from "@wiki-server/api-types";

interface PaginatedClaimsResponse {
  claims: ClaimRow[];
  total: number;
  limit: number;
  offset: number;
}

/** Max entities shown in sidebar before truncating with a "Browse all" link */
const MAX_SIDEBAR_ENTITIES = 20;

/**
 * Build sidebar navigation for the Claims Explorer section.
 * Fetches entity list from the wiki-server API to populate the Entities section.
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

  // Fetch entities that have claims
  const result = await fetchFromWikiServer<PaginatedClaimsResponse>(
    "/api/claims/all?limit=200",
    { revalidate: 300 }
  );

  if (result) {
    // Count claims per entity and sort by count descending
    const entityCounts = new Map<string, number>();
    for (const c of result.claims) {
      entityCounts.set(c.entityId, (entityCounts.get(c.entityId) ?? 0) + 1);
    }

    const sorted = [...entityCounts.entries()]
      .sort((a, b) => b[1] - a[1]);

    if (sorted.length > 0) {
      const displayed = sorted.slice(0, MAX_SIDEBAR_ENTITIES);
      const items = displayed.map(([id, count]) => ({
        label: `${id} (${count})`,
        href: `/claims/entity/${id}`,
      }));

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
