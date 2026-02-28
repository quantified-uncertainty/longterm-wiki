import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Cookie name duplicated from @/lib/auth to avoid pulling in next/headers in Edge runtime.
const ADMIN_COOKIE_NAME = "admin_session";

/** Convert a hex string to a Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/** Convert a Uint8Array to a hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison of two hex strings.
 * Prevents timing attacks by always comparing the full length.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = hexToBytes(a);
  const bBuf = hexToBytes(b);
  let result = 0;
  for (let i = 0; i < aBuf.length; i++) {
    result |= aBuf[i] ^ bBuf[i];
  }
  return result === 0;
}

/**
 * Verify a session token's HMAC signature (Edge-compatible version).
 * Uses Web Crypto API (SubtleCrypto) which is available in Edge Runtime.
 * Duplicated from @/lib/auth because middleware runs in Edge runtime
 * and cannot import next/headers or Node.js crypto.
 */
async function verifySessionToken(
  token: string,
  secret: string,
): Promise<boolean> {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return false;

  const nonce = token.slice(0, dotIndex);
  const providedHmac = token.slice(dotIndex + 1);

  if (!nonce || !providedHmac) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(nonce),
    );
    const expectedHmac = bytesToHex(new Uint8Array(signature));

    return constantTimeEqual(providedHmac, expectedHmac);
  } catch {
    return false;
  }
}

/**
 * Middleware handles two concerns:
 * 1. Admin auth gating for /internal/* routes
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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- Admin auth gate ---
  // When ADMIN_PASSWORD is set, /internal/* requires a valid session cookie.
  // If not set, internal pages remain open (dev mode / no-auth deployments).
  if (pathname.startsWith("/internal")) {
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (adminPassword) {
      const token = request.cookies.get(ADMIN_COOKIE_NAME)?.value;
      if (!token || !(await verifySessionToken(token, adminPassword))) {
        const loginUrl = request.nextUrl.clone();
        loginUrl.pathname = "/login";
        loginUrl.searchParams.set("from", pathname);
        return NextResponse.redirect(loginUrl);
      }
    }
  }

  // If already logged in and visiting /login, redirect to /internal
  if (pathname === "/login") {
    const adminPassword = process.env.ADMIN_PASSWORD;
    const token = request.cookies.get(ADMIN_COOKIE_NAME)?.value;
    if (
      adminPassword &&
      token &&
      (await verifySessionToken(token, adminPassword))
    ) {
      const url = request.nextUrl.clone();
      url.pathname = "/internal";
      return NextResponse.redirect(url);
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
  if (segments[0] === "ai-transition-model" || segments[0] === "ai-transition-model-views") {
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
