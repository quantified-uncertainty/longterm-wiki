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
// Changed from "force-static" to "force-dynamic" (2026-05-31): the static build
// baked the entire ~19.4MB JSON into an ISR fallback file, which exceeds Vercel's
// 19.07MB limit and broke production deploys (FALLBACK_BODY_TOO_LARGE). Nothing in
// the app currently fetches this endpoint, so serving it on-demand is safe. Revert
// to "force-static" once the payload is shrunk/paginated if static caching is wanted.
export const dynamic = "force-dynamic";

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
