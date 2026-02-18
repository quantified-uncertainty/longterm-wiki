/**
 * Generate Grokipedia links from existing Wikipedia links.
 *
 * Since Grokipedia forked Wikipedia's content and uses the same URL slug pattern,
 * we can derive Grokipedia URLs from existing Wikipedia links with high confidence.
 *
 * Also generates title-based matches for pages without Wikipedia links,
 * since Grokipedia has 6M+ articles covering most general topics.
 *
 * Usage:
 *   node --import tsx/esm crux/scripts/grokipedia-from-wikipedia.mjs           # dry run
 *   node --import tsx/esm crux/scripts/grokipedia-from-wikipedia.mjs --apply   # write changes
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { parse, stringify } from "yaml";

const PROJECT_ROOT = join(import.meta.dirname, "../..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const PAGES_JSON = join(PROJECT_ROOT, "app/src/data/pages.json");
const EXTERNAL_LINKS_YAML = join(DATA_DIR, "external-links.yaml");
const APP_EXTERNAL_LINKS_YAML = join(
  PROJECT_ROOT,
  "app/src/data/external-links.yaml"
);
const GROKIPEDIA_BASE = "https://grokipedia.com/page/";

const apply = process.argv.includes("--apply");

// Load data
const pages = JSON.parse(readFileSync(PAGES_JSON, "utf-8"));
const externalLinks = parse(readFileSync(EXTERNAL_LINKS_YAML, "utf-8")) || [];
const linkMap = new Map(externalLinks.map((e) => [e.pageId, e]));

console.log(`Loaded ${pages.length} pages, ${externalLinks.length} external link entries\n`);

// Count existing grokipedia links
const existingGrokipedia = externalLinks.filter(
  (e) => e.links.grokipedia
).length;
console.log(`Existing Grokipedia links: ${existingGrokipedia}\n`);

// Strategy 1: Derive from Wikipedia links
const wikiDerived = [];
for (const entry of externalLinks) {
  if (entry.links.grokipedia) continue; // already has one
  if (!entry.links.wikipedia) continue;

  const wikiUrl = entry.links.wikipedia;
  const match = wikiUrl.match(/\/wiki\/(.+?)(?:#.*)?$/);
  if (!match) continue;

  let slug = match[1];
  // Decode percent-encoding for readability
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // keep as-is if decoding fails
  }

  // Skip disambiguation/section-only slugs that are unlikely to match
  if (slug.includes("#")) {
    // Has a section anchor — use the base article
    slug = slug.split("#")[0];
  }

  wikiDerived.push({
    pageId: entry.pageId,
    grokipediaUrl: GROKIPEDIA_BASE + slug,
    source: "wikipedia",
    slug,
  });
}

console.log(
  `Strategy 1 (Wikipedia-derived): ${wikiDerived.length} potential matches`
);
for (const m of wikiDerived) {
  console.log(`  ${m.pageId} → ${m.grokipediaUrl}`);
}

// Strategy 2: Title-based matching for high-importance pages
// These are pages where the title is a well-known concept that Grokipedia
// (with 6M+ articles) almost certainly has.
const titleDerived = [];
const pagesWithoutWikiLink = new Set(
  pages
    .filter((p) => {
      const entry = linkMap.get(p.id);
      // No wikipedia link and no grokipedia link already
      if (entry && (entry.links.wikipedia || entry.links.grokipedia))
        return false;
      if (!entry) return true;
      return !entry.links.grokipedia;
    })
    .filter(
      (p) =>
        p.entityType !== "table" &&
        p.entityType !== "diagram" &&
        p.entityType !== "insight"
    )
    .map((p) => p.id)
);

// Title-based matching: only for entity types where the page title is very likely
// to correspond to a real encyclopedia article on Grokipedia.
// We can't verify URLs in this environment, so be conservative.

// Entity types that map well to encyclopedia articles:
// - "person": real people have Wikipedia/Grokipedia articles
// - "organization": real orgs have Wikipedia/Grokipedia articles
// These have standard names that match directly.

// Types we SKIP (titles are custom to this wiki, won't exist on Grokipedia):
// model, analysis, crux, argument, overview, parameter, scenario, internal,
// insight, table, diagram, project, safety-agenda, ai-transition-model-*

const titleMatchTypes = new Set(["person", "organization"]);

// Skip pages whose titles contain wiki-specific disambiguators or suffixes
// that wouldn't match a real Grokipedia article
const skipTitlePatterns = [
  /\(Overview\)/i,
  /Funder\)/i,         // e.g. "Dustin Moskovitz (AI Safety Funder)"
  /Industry\)/i,       // e.g. "Elon Musk (AI Industry)"
  /Investor\)/i,       // e.g. "Marc Andreessen (AI Investor)"
  /Pioneer\)/i,        // e.g. "Philip Tetlock (Forecasting Pioneer)"
  /Czar\)/i,           // e.g. "David Sacks (White House AI Czar)"
  /Track Record$/i,
  /Model$/i,
  /Assessment$/i,
  /Comparison/i,
  /\b(?:Overview|Directory|Browse)\b/i,
  /super PAC$/i,       // e.g. "Leading the Future super PAC"
  /: Track Record$/i,
  /ML Alignment Theory Scholars/i,  // MATS-specific title
  /by Eliezer Yudkowsky$/i,         // "The Sequences by Eliezer Yudkowsky"
  /AI Revenue Sources$/i,           // wiki-specific compilation page
];

for (const page of pages) {
  if (!pagesWithoutWikiLink.has(page.id)) continue;
  if (!titleMatchTypes.has(page.entityType)) continue;

  const title = page.title;

  // Skip titles with wiki-specific patterns
  if (skipTitlePatterns.some((p) => p.test(title))) continue;

  // Skip very long titles (unlikely to be a standard article name)
  if (title.length > 60) continue;

  // Skip titles with special chars that aren't standard in encyclopedia slugs
  if (/[<>{}|\\:&+]/.test(title)) continue;

  // For persons: use the title directly (names match well)
  // For orgs: use the title directly (most org names match)
  const slug = title.replace(/ /g, "_");

  titleDerived.push({
    pageId: page.id,
    grokipediaUrl: GROKIPEDIA_BASE + slug,
    source: "title",
    slug,
    entityType: page.entityType,
    importance: page.readerImportance || 0,
  });
}

console.log(
  `\nStrategy 2 (title-based, high-confidence): ${titleDerived.length} potential matches`
);
for (const m of titleDerived) {
  console.log(
    `  ${m.pageId} → ${m.grokipediaUrl} [${m.entityType || "unknown"}, importance=${m.importance}]`
  );
}

// Combine all matches
const allMatches = [...wikiDerived, ...titleDerived];
console.log(`\nTotal new Grokipedia links to add: ${allMatches.length}`);

if (apply && allMatches.length > 0) {
  console.log("\nApplying changes...");

  for (const m of allMatches) {
    const existing = linkMap.get(m.pageId);
    if (existing) {
      existing.links.grokipedia = m.grokipediaUrl;
    } else {
      const newEntry = {
        pageId: m.pageId,
        links: { grokipedia: m.grokipediaUrl },
      };
      externalLinks.push(newEntry);
      linkMap.set(m.pageId, newEntry);
    }
  }

  // Sort by pageId
  externalLinks.sort((a, b) => a.pageId.localeCompare(b.pageId));

  const yamlStr = stringify(externalLinks, {
    lineWidth: 0,
    defaultKeyType: "PLAIN",
    defaultStringType: "PLAIN",
  });

  writeFileSync(EXTERNAL_LINKS_YAML, yamlStr);
  writeFileSync(APP_EXTERNAL_LINKS_YAML, yamlStr);
  console.log(`Written to ${EXTERNAL_LINKS_YAML}`);
  console.log(`Written to ${APP_EXTERNAL_LINKS_YAML}`);
  console.log(`Done! Added ${allMatches.length} Grokipedia links.`);
} else if (!apply) {
  console.log("\nDry run — use --apply to write changes.");
}
