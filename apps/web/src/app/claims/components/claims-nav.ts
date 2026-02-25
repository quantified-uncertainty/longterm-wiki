import type { NavSection } from "@/lib/internal-nav";
import { fetchFromWikiServer } from "@lib/wiki-server";
import type { ClaimRow } from "@wiki-server/api-types";

interface PaginatedClaimsResponse {
  claims: ClaimRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Build sidebar navigation for the Claims Explorer section.
 * Fetches entity list from the wiki-server API to populate the Entities section.
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
    const entityIds = [
      ...new Set(result.claims.map((c) => c.entityId)),
    ].sort();

    if (entityIds.length > 0) {
      sections.push({
        title: "Entities",
        items: entityIds.map((id) => ({
          label: id,
          href: `/claims/entity/${id}`,
        })),
      });
    }
  }

  return sections;
}
