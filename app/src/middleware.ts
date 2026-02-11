import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Redirects old-style content URLs to the new /wiki/:slug canonical URLs.
 *
 * Old site (longtermwiki.com) used paths like:
 *   /knowledge-base/risks/deceptive-alignment
 *   /knowledge-base/organizations/anthropic
 *   /ai-transition-model/compute
 *
 * New site serves all wiki content through /wiki/:id (numeric E42 or slug).
 * The /wiki/[id] route handles slug → numeric ID resolution internally.
 */

// Paths under /ai-transition-model/ that have dedicated routes in the new site
const ATM_PRESERVED_ROUTES = new Set(["graph"]);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Normalize: strip trailing slash
  const path =
    pathname.endsWith("/") && pathname.length > 1
      ? pathname.slice(0, -1)
      : pathname;

  const segments = path.split("/").filter(Boolean);

  // /knowledge-base/[category/]slug → /wiki/slug
  if (segments[0] === "knowledge-base" && segments.length >= 2) {
    const slug = segments[segments.length - 1];
    const url = request.nextUrl.clone();
    url.pathname = `/wiki/${slug}`;
    return NextResponse.redirect(url, 308);
  }

  // /ai-transition-model/slug → /wiki/slug
  // Skip paths that have their own routes (e.g. /ai-transition-model/graph)
  if (segments[0] === "ai-transition-model" && segments.length >= 2) {
    const slug = segments[segments.length - 1];
    if (!ATM_PRESERVED_ROUTES.has(slug)) {
      const url = request.nextUrl.clone();
      url.pathname = `/wiki/${slug}`;
      return NextResponse.redirect(url, 308);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/knowledge-base/:path+", "/ai-transition-model/:path+"],
};
