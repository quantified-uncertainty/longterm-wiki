/**
 * Grokipedia Integration Commands
 *
 * Tools for matching wiki pages to Grokipedia articles and managing
 * Grokipedia external links.
 *
 * Usage:
 *   pnpm crux grokipedia match              # Find matching Grokipedia articles (dry run)
 *   pnpm crux grokipedia match --apply      # Find and write to external-links.yaml
 *   pnpm crux grokipedia match --verbose    # Show slug details
 */

import type { CommandResult } from "../lib/cli.ts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { parse, stringify } from "yaml";
import { execSync } from "child_process";

const PROJECT_ROOT = join(import.meta.dirname, "../..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const PAGES_JSON = join(PROJECT_ROOT, "app/src/data/pages.json");
const EXTERNAL_LINKS_YAML = join(DATA_DIR, "external-links.yaml");
const APP_EXTERNAL_LINKS_YAML = join(
  PROJECT_ROOT,
  "app/src/data/external-links.yaml"
);

const GROKIPEDIA_BASE = "https://grokipedia.com/page/";
const REQUEST_TIMEOUT_MS = 8000;

interface PageInfo {
  id: string;
  title: string;
  entityType?: string;
  readerImportance?: number;
  researchImportance?: number;
}

interface ExternalLinkEntry {
  pageId: string;
  links: Record<string, string>;
}

/**
 * Convert a page title to a Grokipedia URL slug.
 * Grokipedia uses Wikipedia-style slugs: spaces → underscores, title case preserved.
 */
function titleToSlug(title: string): string {
  return title.replace(/ /g, "_");
}

/**
 * Generate candidate slugs for a page title.
 * Returns multiple variants to increase match rate.
 */
function generateCandidateSlugs(title: string): string[] {
  const slugs: string[] = [];

  // Direct title mapping (most common)
  slugs.push(titleToSlug(title));

  // "AI X" -> "Artificial_intelligence_X" (Grokipedia often uses full form)
  if (title.startsWith("AI ") && !title.startsWith("AI-")) {
    slugs.push(titleToSlug(title.replace(/^AI /, "Artificial intelligence ")));
  }

  return [...new Set(slugs)]; // dedupe
}

/**
 * Check if a Grokipedia page exists via curl HEAD request.
 * Uses curl instead of Node.js https because Node DNS resolution
 * fails in some sandboxed environments.
 */
function checkGrokipediaUrl(
  slug: string
): { exists: boolean; url: string; status: number } {
  const url = GROKIPEDIA_BASE + slug;
  try {
    const status = parseInt(
      execSync(
        `curl -sI -o /dev/null -w "%{http_code}" --max-time ${Math.round(REQUEST_TIMEOUT_MS / 1000)} "${url}"`,
        { encoding: "utf-8", timeout: REQUEST_TIMEOUT_MS + 4000 }
      ).trim(),
      10
    ) || 0;
    return { exists: status >= 200 && status < 400, url, status };
  } catch {
    return { exists: false, url, status: 0 };
  }
}

/**
 * Run URL checks sequentially (curl is synchronous via execSync).
 */
function checkAllUrls(
  items: Array<{ pageId: string; title: string; slugs: string[] }>
): Array<{ pageId: string; title: string; url: string; slug: string }> {
  const matches: Array<{
    pageId: string;
    title: string;
    url: string;
    slug: string;
  }> = [];
  let checked = 0;
  const total = items.reduce((sum, i) => sum + i.slugs.length, 0);

  for (const item of items) {
    for (const slug of item.slugs) {
      checked++;
      if (checked % 10 === 0) {
        process.stdout.write(
          `\r  Checked ${checked}/${total} URLs, ${matches.length} matches found...`
        );
      }

      const result = checkGrokipediaUrl(slug);
      if (result.exists) {
        matches.push({
          pageId: item.pageId,
          title: item.title,
          url: result.url,
          slug,
        });
        break; // Found a match, skip remaining slugs for this page
      }
    }
  }

  process.stdout.write("\n");
  return matches;
}

/**
 * Load existing external links
 */
function loadExternalLinks(): ExternalLinkEntry[] {
  if (!existsSync(EXTERNAL_LINKS_YAML)) return [];
  const raw = readFileSync(EXTERNAL_LINKS_YAML, "utf-8");
  return (parse(raw) as ExternalLinkEntry[]) || [];
}

/**
 * Save external links to both data/ and app/src/data/
 */
function saveExternalLinks(entries: ExternalLinkEntry[]): void {
  entries.sort((a, b) => a.pageId.localeCompare(b.pageId));

  const yamlStr = stringify(entries, {
    lineWidth: 0,
    defaultKeyType: "PLAIN",
    defaultStringType: "PLAIN",
  });

  writeFileSync(EXTERNAL_LINKS_YAML, yamlStr);
  writeFileSync(APP_EXTERNAL_LINKS_YAML, yamlStr);
}

/**
 * Match command: find Grokipedia articles for wiki pages
 */
async function match(
  args: string[],
  options: Record<string, unknown>
): Promise<CommandResult> {
  const apply = options.apply === true || args.includes("--apply");
  const verbose = options.verbose === true || args.includes("--verbose");
  const lines: string[] = [];

  lines.push("Grokipedia URL Matcher");
  lines.push("======================\n");

  // Load pages
  if (!existsSync(PAGES_JSON)) {
    return {
      output:
        "Error: pages.json not found. Run `cd app && node scripts/build-data.mjs` first.",
      exitCode: 1,
    };
  }

  const pages: PageInfo[] = JSON.parse(readFileSync(PAGES_JSON, "utf-8"));
  lines.push(`Loaded ${pages.length} wiki pages`);

  // Load existing external links to skip pages that already have grokipedia links
  const existingLinks = loadExternalLinks();
  const existingMap = new Map(existingLinks.map((e) => [e.pageId, e]));
  const alreadyLinked = new Set(
    existingLinks.filter((e) => e.links.grokipedia).map((e) => e.pageId)
  );
  lines.push(
    `${alreadyLinked.size} pages already have Grokipedia links (skipping)`
  );

  // Filter out internal pages and pages that already have grokipedia links
  const candidates = pages.filter((p) => {
    if (alreadyLinked.has(p.id)) return false;
    if (p.id.startsWith("internal-")) return false;
    if (p.entityType === "table" || p.entityType === "diagram") return false;
    return true;
  });
  lines.push(`${candidates.length} candidates to check\n`);

  // Generate candidate slugs for each page
  const items = candidates.map((p) => ({
    pageId: p.id,
    title: p.title,
    slugs: generateCandidateSlugs(p.title),
  }));

  const totalUrls = items.reduce((s, i) => s + i.slugs.length, 0);
  console.log(`Checking ${totalUrls} candidate URLs against grokipedia.com...`);
  const matches = checkAllUrls(items);

  lines.push(
    `Results: ${matches.length} matches found out of ${candidates.length} candidates\n`
  );

  // Display matches
  if (matches.length > 0) {
    lines.push("Matched pages:");
    for (const m of matches) {
      lines.push(`  ${m.pageId} → ${m.url}`);
      if (verbose) {
        lines.push(`    Title: "${m.title}" → Slug: "${m.slug}"`);
      }
    }
  }

  // Apply if requested
  if (apply && matches.length > 0) {
    lines.push(`\nApplying ${matches.length} new Grokipedia links...`);

    for (const m of matches) {
      const existing = existingMap.get(m.pageId);
      if (existing) {
        existing.links.grokipedia = m.url;
      } else {
        const newEntry: ExternalLinkEntry = {
          pageId: m.pageId,
          links: { grokipedia: m.url },
        };
        existingLinks.push(newEntry);
        existingMap.set(m.pageId, newEntry);
      }
    }

    saveExternalLinks(existingLinks);
    lines.push(`Written to ${EXTERNAL_LINKS_YAML}`);
    lines.push(`Written to ${APP_EXTERNAL_LINKS_YAML}`);
    lines.push(`Done! Added ${matches.length} Grokipedia links.`);
  } else if (!apply && matches.length > 0) {
    lines.push(
      `\nDry run — use --apply to write these links to external-links.yaml`
    );
  }

  return { output: lines.join("\n"), exitCode: 0 };
}

export const commands: Record<
  string,
  (
    args: string[],
    options: Record<string, unknown>
  ) => Promise<CommandResult>
> = {
  match,
  default: match,
};

export function getHelp(): string {
  return `
Grokipedia Domain - Match wiki pages to Grokipedia articles

Commands:
  match           Find matching Grokipedia articles for wiki pages (default)

Options:
  --apply         Write matches to external-links.yaml (default: dry run)
  --verbose       Show slug details for each match

Examples:
  crux grokipedia match              Preview matches (dry run)
  crux grokipedia match --apply      Find and write matches
  crux grokipedia match --verbose    Show detailed slug info
`;
}
