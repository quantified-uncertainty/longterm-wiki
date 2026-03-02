import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Knowledge-base category directories that had index pages in the old site.
// These don't map to individual wiki pages, so we redirect them to /wiki.
const KB_CATEGORIES = new Set([
  "capabilities",
  "cruxes",
  "debates",
  "forecasting",
  "future-projections",
  "history",
  "incidents",
  "intelligence-paradigms",
  "metrics",
  "models",
  "organizations",
  "people",
  "reports",
  "responses",
  "risks",
  "worldviews",
]);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Normalize: strip trailing slash
  const path =
    pathname.endsWith("/") && pathname.length > 1
      ? pathname.slice(0, -1)
      : pathname;

  const segments = path.split("/").filter(Boolean);

  // /browse → /wiki (legacy browse pages merged into wiki)
  // /browse/resources → /wiki/resources, /browse/tags → /wiki/tags
  if (segments[0] === "browse") {
    const url = request.nextUrl.clone();
    if (segments.length <= 1) {
      url.pathname = "/wiki";
    } else {
      url.pathname = `/wiki/${segments[segments.length - 1]}`;
    }
    return NextResponse.redirect(url, 308);
  }

  // /knowledge-base → /wiki (root index page)
  // /knowledge-base/risks → /wiki (category index — no standalone page in new site)
  // /knowledge-base/[category/]slug → /wiki/slug
  if (segments[0] === "knowledge-base") {
    const url = request.nextUrl.clone();
    if (segments.length <= 1) {
      // Root: /knowledge-base
      url.pathname = "/wiki";
      return NextResponse.redirect(url, 308);
    }
    const slug = segments[segments.length - 1];
    if (segments.length === 2 && KB_CATEGORIES.has(slug)) {
      // Category index: /knowledge-base/risks → /wiki?entity=risks
      // Preserve category context so the explore grid can pre-filter by type.
      url.pathname = "/wiki";
      url.searchParams.set("entity", slug);
      return NextResponse.redirect(url, 308);
    }
    url.pathname = `/wiki/${slug}`;
    return NextResponse.redirect(url, 308);
  }

  // /ai-transition-model* → /wiki (ATM section removed; redirect old URLs)
  if (
    segments[0] === "ai-transition-model" ||
    segments[0] === "ai-transition-model-views"
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/wiki";
    return NextResponse.redirect(url, 308);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/browse",
    "/browse/:path+",
    "/knowledge-base",
    "/knowledge-base/:path+",
    "/ai-transition-model",
    "/ai-transition-model/:path+",
    "/ai-transition-model-views",
    "/ai-transition-model-views/:path+",
  ],
};
