/**
 * Batch fix resource titles — domain-only and scraping-failure titles
 *
 * Fixes ~139 resources that have bad titles:
 * - Domain-only (e.g., "www.cs.toronto.edu", "arxiv.org")
 * - Empty/missing titles
 * - Generic words ("Book")
 * - Version numbers ("2.0", "2.2")
 *
 * The fixes were pre-computed by fetching real titles from each URL.
 * The manifest is stored in `crux/scripts/resource-title-fixes.json`.
 *
 * Usage:
 *   # Dry run (default) — just print what would change
 *   npx tsx crux/scripts/fix-resource-titles.ts
 *
 *   # Apply fixes to wiki-server
 *   WIKI_SERVER_ENV=prod npx tsx crux/scripts/fix-resource-titles.ts --apply
 *
 *   # Re-fetch titles from URLs (ignores manifest, fetches live)
 *   npx tsx crux/scripts/fix-resource-titles.ts --fetch
 *
 *   # Fetch and apply
 *   WIKI_SERVER_ENV=prod npx tsx crux/scripts/fix-resource-titles.ts --fetch --apply
 */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { apiRequest } from "../lib/wiki-server/client.ts";
import { hostMatches } from "@longterm-wiki/url-utils";
import { decodeHtmlEntities as decodeEntities } from "../lib/html-utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResourceFix {
  id: string;
  url: string;
  oldTitle: string | null;
  newTitle: string;
  type: string | null;
  stableId: string | null;
}

// ---------------------------------------------------------------------------
// Title detection — identifies resources with bad titles
// ---------------------------------------------------------------------------

const DOMAIN_ONLY_PATTERN =
  /^(?:www\.)?[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z]{2,})+$/;

const GENERIC_WORDS = new Set(["book", "page", "home", "homepage", "index"]);

const VERSION_PATTERN = /^[\d.]+$/;

export function isBadTitle(title: string | null | undefined): boolean {
  if (!title || title.trim().length === 0) return true;
  const t = title.trim();
  if (DOMAIN_ONLY_PATTERN.test(t)) return true;
  if (GENERIC_WORDS.has(t.toLowerCase())) return true;
  if (VERSION_PATTERN.test(t)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Title extraction from HTML
// ---------------------------------------------------------------------------

export function extractTitleFromHtml(html: string): string | null {
  if (!html) return null;

  // Try og:title first (more reliable for articles)
  let m = html.match(
    /<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i
  );
  if (!m) {
    m = html.match(
      /content=["']([^"']+)["']\s+(?:property|name)=["']og:title["']/i
    );
  }
  if (m) return decodeHtmlEntities(m[1]).trim();

  // Fall back to <title> tag
  m = html.match(/<title[^>]*>([^<]+)<\/title>/is);
  if (m) {
    return decodeHtmlEntities(m[1].replace(/\s+/g, " ")).trim();
  }

  return null;
}

function decodeHtmlEntities(s: string): string {
  // Delegate to the shared helper, which decodes `&amp;` last to avoid
  // double-unescaping inputs like `&amp;lt;`.
  return decodeEntities(s);
}

// ---------------------------------------------------------------------------
// Title validation — checks if a fetched title is itself a scraping failure
// ---------------------------------------------------------------------------

const SCRAPING_FAILURE_TERMS = [
  "just a moment",
  "access denied",
  "page not found",
  "not found",
  "404",
  "sign in",
  "verify",
  "loading",
  "attention required",
  "are you a robot",
  "cloudflare",
  "forbidden",
  "captcha",
  "security check",
  "please wait",
  "redirecting",
];

export function isScrapingFailure(title: string): boolean {
  if (!title || title.trim().length < 3) return true;
  const t = title.trim().toLowerCase();
  return SCRAPING_FAILURE_TERMS.some((term) => t.includes(term));
}

// ---------------------------------------------------------------------------
// Title derivation from URL patterns
// ---------------------------------------------------------------------------

export function deriveTitleFromUrl(url: string): string | null {
  // Wikipedia: /wiki/Article_Name -> "Article Name"
  const wikiMatch = url.match(/wikipedia\.org\/wiki\/([^?#]+)/);
  if (wikiMatch) {
    return decodeURIComponent(wikiMatch[1]).replace(/_/g, " ");
  }

  // Twitter/X profiles: x.com/handle -> "@handle on X"
  const xMatch = url.match(/(?:x\.com|twitter\.com)\/(\w+)\/?$/);
  if (xMatch) {
    return `@${xMatch[1]} on X`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Load fixes from manifest
// ---------------------------------------------------------------------------

function loadManifest(): ResourceFix[] {
  const manifestPath = join(
    import.meta.dirname || __dirname,
    "resource-title-fixes.json"
  );
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf-8")) as ResourceFix[];
}

// ---------------------------------------------------------------------------
// Fetch titles from URLs
// ---------------------------------------------------------------------------

async function fetchTitle(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    if (
      contentType.includes("pdf") ||
      contentType.includes("image") ||
      contentType.includes("video")
    ) {
      return null;
    }

    // Only read the first 50KB
    const reader = response.body?.getReader();
    if (!reader) return null;

    let text = "";
    const decoder = new TextDecoder();
    while (text.length < 50_000) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {
      // Intentional: we don't need the rest of the body
    });

    return extractTitleFromHtml(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Apply fixes to wiki-server
// ---------------------------------------------------------------------------

async function applyFix(fix: ResourceFix): Promise<boolean> {
  // typed-client-ok: QUA-770 baseline — one-shot maintenance script
  const result = await apiRequest<{ id: string }>("POST", "/api/resources", {
    id: fix.id,
    url: fix.url,
    title: fix.newTitle,
    type: fix.type,
    stableId: fix.stableId,
  });

  return result.ok;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const fetchLive = args.includes("--fetch");

  let fixes: ResourceFix[];

  if (fetchLive) {
    console.log("Fetching titles from URLs (this may take a while)...\n");

    // Load snapshot to find bad resources
    const snapshotPath = join(
      import.meta.dirname || __dirname,
      "../../data/resources-snapshot.json"
    );
    if (!existsSync(snapshotPath)) {
      console.error(`Snapshot not found: ${snapshotPath}`);
      process.exit(1);
    }

    interface SnapshotResource {
      id: string;
      url: string;
      title?: string;
      type?: string;
      stable_id?: string;
    }

    const resources = JSON.parse(
      readFileSync(snapshotPath, "utf-8")
    ) as SnapshotResource[];
    const badResources = resources.filter((r) => isBadTitle(r.title));

    console.log(`Found ${badResources.length} resources with bad titles\n`);

    fixes = [];
    let fetched = 0;
    let failed = 0;

    for (const r of badResources) {
      // Try URL-pattern derivation first
      const derived = deriveTitleFromUrl(r.url);
      if (derived) {
        fixes.push({
          id: r.id,
          url: r.url,
          oldTitle: r.title || null,
          newTitle: derived,
          type: r.type || null,
          stableId: r.stable_id || null,
        });
        continue;
      }

      // Skip non-fetchable URLs
      if (
        r.url.toLowerCase().endsWith(".pdf") ||
        hostMatches(r.url, "glassdoor.com") ||
        hostMatches(r.url, "bloomberg.com")
      ) {
        failed++;
        continue;
      }

      // Fetch from URL
      const title = await fetchTitle(r.url);
      if (title && !isScrapingFailure(title)) {
        fixes.push({
          id: r.id,
          url: r.url,
          oldTitle: r.title || null,
          newTitle: title,
          type: r.type || null,
          stableId: r.stable_id || null,
        });
        fetched++;
      } else {
        failed++;
      }

      // Rate limit: 500ms between fetches
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Progress
      if ((fetched + failed) % 20 === 0) {
        console.log(
          `  Progress: ${fetched + failed}/${badResources.length} (${fixes.length} fixed, ${failed} failed)`
        );
      }
    }

    console.log(
      `\nFetch complete: ${fixes.length} fixes found, ${failed} failed\n`
    );
  } else {
    fixes = loadManifest();
    console.log(`Loaded ${fixes.length} fixes from manifest\n`);
  }

  // Print all fixes
  console.log("Resource title fixes:\n");
  for (const fix of fixes) {
    const old = fix.oldTitle || "(empty)";
    console.log(`  ${fix.id}: "${old}" -> "${fix.newTitle}"`);
    console.log(`    URL: ${fix.url}`);
  }

  console.log(`\nTotal: ${fixes.length} fixes`);

  if (!apply) {
    console.log(
      "\n[DRY RUN] No changes applied. Use --apply to update wiki-server.\n"
    );
    return;
  }

  // Apply fixes
  console.log("\nApplying fixes to wiki-server...\n");
  let success = 0;
  let errors = 0;

  for (const fix of fixes) {
    try {
      const ok = await applyFix(fix);
      if (ok) {
        console.log(`  OK: ${fix.id} -> "${fix.newTitle}"`);
        success++;
      } else {
        console.error(`  FAIL: ${fix.id}`);
        errors++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${fix.id} - ${msg}`);
      errors++;
    }

    // Rate limit: 100ms between API calls
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(`\nDone: ${success} updated, ${errors} errors`);
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("fix-resource-titles crashed:", err);
  process.exit(1);
});
