import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

/**
 * Middleware handles two concerns:
 * 1. Admin auth gating for /internal/* routes (via GitHub OAuth / next-auth)
 * 2. Redirecting old-style content URLs to /wiki/:slug
 */

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

/**
 * Whether GitHub OAuth is fully configured.
 * Requires GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and NEXTAUTH_SECRET.
 * If any is missing, auth is disabled (open dev mode OR clear misconfiguration).
 */
function isOAuthConfigured(): boolean {
  return (
    !!process.env.GITHUB_CLIENT_ID &&
    !!process.env.GITHUB_CLIENT_SECRET &&
    !!process.env.NEXTAUTH_SECRET
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- Admin auth gate ---
  // When GitHub OAuth env vars are fully configured, /internal/* requires a valid session.
  // If not configured, internal pages remain open (dev mode / no-auth deployments).
  if (pathname.startsWith("/internal")) {
    if (isOAuthConfigured()) {
      const token = await getToken({
        req: request,
        secret: process.env.NEXTAUTH_SECRET,
      });

      if (!token) {
        const loginUrl = request.nextUrl.clone();
        loginUrl.pathname = "/login";
        // next-auth uses `callbackUrl` for post-login redirect.
        // request.nextUrl.href is always same-origin; next-auth also validates
        // callbackUrl against NEXTAUTH_URL in its redirect callback.
        loginUrl.searchParams.set("callbackUrl", request.nextUrl.href);
        return NextResponse.redirect(loginUrl);
      }
    }
  }

  // If already logged in and visiting /login, redirect to /internal
  if (pathname === "/login") {
    if (isOAuthConfigured()) {
      const token = await getToken({
        req: request,
        secret: process.env.NEXTAUTH_SECRET,
      });

      if (token) {
        const url = request.nextUrl.clone();
        url.pathname = "/internal";
        url.search = "";
        return NextResponse.redirect(url);
      }
    }

    return NextResponse.next();
  }

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
    "/internal",
    "/internal/:path+",
    "/login",
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
