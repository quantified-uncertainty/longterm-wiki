import type { NavSection } from "@/lib/internal-nav";
import { fetchFromWikiServer } from "@lib/wiki-server";
import { getEntityById } from "@data";

interface NetworkResponse {
  nodes: { entityId: string; claimCount: number }[];
  edges: { source: string; target: string; weight: number }[];
}

/**
 * Build sidebar navigation for the Claims Explorer section.
 * Uses the network endpoint to get ALL entities with claims (not just first 200).
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
    const entityIds = result.nodes
      .filter((n) => n.claimCount > 0)
      .map((n) => n.entityId)
      .sort();

    if (entityIds.length > 0) {
      sections.push({
        title: "Entities",
        items: entityIds.map((id) => {
          const entity = getEntityById(id);
          return {
            label: entity?.title ?? id,
            href: `/claims/entity/${id}`,
          };
        }),
      });
    }
  }

  return sections;
}
