/**
 * AI Lab Watch HTML parser (QUA-751).
 *
 * Pure parsing — no network, no fs. Given the homepage HTML at
 * https://ailabwatch.org/, extract the per-(org × dimension) percent
 * scores and the per-org overall percent score.
 *
 * The site's category cells expose deterministic accessibility metadata:
 *
 *   <a aria-label="Risk assessment score for Anthropic: 44%" ...>
 *
 * which makes the per-cell scrape unambiguous regardless of CSS or layout
 * changes. The "Overall score" rollup is parsed from a separate stacked
 * list rather than the matrix.
 *
 * The scraper is built for the frozen Sept 2025 state — no LLM fallback,
 * no rewave logic. If `parseAILabWatchHtml` ever returns the wrong shape
 * the upstream site has changed, and the right move is to fix the parser
 * (and the cached HTML), not to soften the parse.
 */

import { load, type CheerioAPI } from "cheerio";

/**
 * The 7 AI Lab Watch dimensions. The slugs match the URL paths
 * (`/categories/<slug>`) and become `dimensionSlug` in the emitted
 * grades.json. Labels match the verbatim aria-label prefixes on the
 * cells, so the matcher is exact-string and trivially auditable.
 */
export const AILW_DIMENSIONS: ReadonlyArray<{
  slug: string;
  /** Verbatim aria-label prefix (case-insensitive match below). */
  ariaPrefix: string;
  /** Display label written into grades.json. */
  label: string;
}> = [
  { slug: "risk-assessment", ariaPrefix: "Risk assessment", label: "Risk assessment" },
  { slug: "scheming", ariaPrefix: "Scheming risk prevention", label: "Scheming risk prevention" },
  { slug: "safety-research", ariaPrefix: "Boosting safety research", label: "Boosting safety research" },
  { slug: "misuse", ariaPrefix: "Misuse prevention", label: "Misuse prevention" },
  { slug: "security", ariaPrefix: "Prep for extreme security", label: "Prep for extreme security" },
  { slug: "information-sharing", ariaPrefix: "Risk info sharing", label: "Risk info sharing" },
  { slug: "planning", ariaPrefix: "Planning", label: "Planning" },
] as const;

/**
 * Org companies on the scorecard. Slugs match the URL paths
 * (`/companies/<slug>`); display names are lifted from the rendered HTML.
 * The 7 entries are the full set as of the Sept 2025 freeze.
 */
export const AILW_ORGS: ReadonlyArray<{ slug: string; display: string }> = [
  { slug: "anthropic", display: "Anthropic" },
  { slug: "deepmind", display: "DeepMind" },
  { slug: "openai", display: "OpenAI" },
  { slug: "meta", display: "Meta" },
  { slug: "xai", display: "xAI" },
  { slug: "microsoft", display: "Microsoft" },
  { slug: "deepseek", display: "DeepSeek" },
] as const;

const ARIA_RE =
  /^(?<dim>.+?)\s+score\s+for\s+(?<org>.+?)\s*:\s*(?<pct>\d+)\s*%\s*$/i;

export interface ParsedAILabWatch {
  /** Per-(org × dimension) percent in 0-100. Keyed by orgSlug then dimSlug. */
  perDimension: Record<string, Record<string, number>>;
  /** Per-org overall percent in 0-100. Keyed by orgSlug. */
  overall: Record<string, number>;
}

/**
 * Parse the raw AI Lab Watch homepage HTML into an in-memory grade map.
 * Throws on any structural mismatch — missing dimension, missing org,
 * unparseable percent — so the caller's grades.json is either complete
 * or absent. No silent gaps.
 */
export function parseAILabWatchHtml(html: string): ParsedAILabWatch {
  const $ = load(html);

  const perDimension: Record<string, Record<string, number>> = {};
  for (const o of AILW_ORGS) perDimension[o.slug] = {};

  const dimByPrefix = new Map(
    AILW_DIMENSIONS.map((d) => [d.ariaPrefix.toLowerCase(), d]),
  );
  const orgByDisplay = new Map(
    AILW_ORGS.map((o) => [o.display.toLowerCase(), o]),
  );

  $("[aria-label]").each((_, el) => {
    const label = $(el).attr("aria-label");
    if (!label) return;
    const m = ARIA_RE.exec(label);
    if (!m?.groups) return;
    const dimRaw = m.groups.dim.trim().toLowerCase();
    const orgRaw = m.groups.org.trim().toLowerCase();
    const pct = Number(m.groups.pct);
    const dim = dimByPrefix.get(dimRaw);
    const org = orgByDisplay.get(orgRaw);
    if (!dim || !org || !Number.isFinite(pct)) return;
    perDimension[org.slug][dim.slug] = pct;
  });

  // Validate: every org × dimension cell must be present.
  const missing: string[] = [];
  for (const o of AILW_ORGS) {
    for (const d of AILW_DIMENSIONS) {
      if (perDimension[o.slug][d.slug] == null) {
        missing.push(`${o.slug}/${d.slug}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `parseAILabWatchHtml: missing ${missing.length} cells: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`,
    );
  }

  const overall = parseOverallScores($);

  // Validate: every org has an overall.
  const missingOverall = AILW_ORGS.filter((o) => overall[o.slug] == null);
  if (missingOverall.length > 0) {
    throw new Error(
      `parseAILabWatchHtml: missing overall scores for ${missingOverall.map((o) => o.slug).join(", ")}`,
    );
  }

  return { perDimension, overall };
}

/**
 * Extract overall scores from the "Overall score" rollup list. The site
 * renders each cell as:
 *
 *   <a href="/companies/<slug>">
 *     …company logo + name…
 *     <div class="…">
 *       <div class="…text-white">NN<div>%</div></div>
 *       <div ... background-color … />
 *     </div>
 *   </a>
 *
 * We anchor on the `/companies/<slug>` href and find the inner score
 * container by its `text-white` class — its first text node is the
 * numeric percent. The matrix-header anchors above the table are also
 * `/companies/<slug>` anchors but contain only an `<img>` and no score
 * child, so they're skipped.
 */
function parseOverallScores($: CheerioAPI): Record<string, number> {
  const orgSlugs = new Set(AILW_ORGS.map((o) => o.slug));
  const overall: Record<string, number> = {};

  $("a[href^='/companies/']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const slug = href.replace(/^\/companies\//, "").replace(/\/$/, "");
    if (!orgSlugs.has(slug)) return;
    if (overall[slug] != null) return; // first match wins (the rollup is first on the page)

    // Find the score container — `<div class="… text-white">NN<div>%</div></div>`.
    // Its first text-node child is the numeric percent. Reading the full
    // `.text()` would yield "NN%" because Cheerio concatenates descendants.
    const scoreNode = $(el).find("div.text-white").first();
    if (scoreNode.length === 0) return;
    const ownText = scoreNode
      .contents()
      .filter((_, n) => (n as { type?: string }).type === "text")
      .text()
      .trim();
    if (!/^\d+$/.test(ownText)) return;
    const pct = Number(ownText);
    if (!Number.isFinite(pct)) return;
    overall[slug] = pct;
  });

  return overall;
}
