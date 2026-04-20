/**
 * QUA-632 Phase 1 — T3 homepage rejection.
 *
 * T3 is "open web with stricter rejection".  The canonical failure mode the
 * rule targets: a record's `source` is set to the org's homepage, the LLM
 * reads the front page, and returns `unverifiable 0.9` because the page
 * mentions the entity in passing but doesn't specifically confirm the claim.
 *
 * We reject homepage-like URLs at the gate so T3 callers must supply a
 * specific sub-page (press release, blog post, docs page, etc.).
 */

const HOMEPAGE_PATHS = new Set([
  "",
  "/",
  "/index",
  "/index.html",
  "/index.htm",
  "/home",
]);

const SHALLOW_LANDING_PATHS = new Set([
  "/about",
  "/about-us",
  "/aboutus",
  "/contact",
  "/contact-us",
  "/contactus",
]);

export function isHomepageUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  const path = normalisePath(url.pathname);
  if (HOMEPAGE_PATHS.has(path)) return true;
  if (SHALLOW_LANDING_PATHS.has(path)) return true;
  return false;
}

function normalisePath(raw: string): string {
  // Strip trailing slashes except the root itself.
  let p = raw.toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}
