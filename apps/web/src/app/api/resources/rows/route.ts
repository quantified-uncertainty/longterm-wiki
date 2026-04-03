import { NextResponse } from "next/server";
import {
  getAllResources,
  getPagesForResource,
  getResourceCredibility,
  getResourcePublication,
} from "@/data";
import type { ResourceRow } from "../../../resources/resources-table";

/**
 * GET /api/resources/rows
 *
 * Returns all resource rows as JSON for the /sources page resources table.
 * Statically generated at build time so the 17MB+ dataset is served as a
 * separate cacheable fetch rather than embedded in the page HTML.
 */
export const dynamic = "force-static";

export function GET(): NextResponse<ResourceRow[]> {
  const resources = getAllResources();
  const rows: ResourceRow[] = resources.map((r) => {
    const publication = getResourcePublication(r);
    const credibility = getResourceCredibility(r);
    const citingPages = getPagesForResource(r.id);
    return {
      id: r.id,
      title: r.title,
      url: r.url,
      type: r.type,
      publicationName: publication?.name ?? null,
      credibility: credibility ?? null,
      citingPageCount: citingPages.length,
      tags: r.tags ?? [],
      publishedDate: r.published_date ?? null,
      contextNote: r.context_note ?? null,
      resourceSubtype: r.resource_subtype ?? null,
      importanceScore: r.importance_score ?? null,
      enrichmentStatus: r.enrichment_status ?? null,
      citationCount: r.paper?.citation_count ?? null,
      karma: r.forum_post?.karma ?? null,
    };
  });
  return NextResponse.json(rows);
}
