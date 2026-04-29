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

// Accept integer percents only — the live site uses these exclusively for
// the frozen Sept-2025 wave. A future `13.5%` would currently *not* match
// this regex and the strict cell-presence validator would then throw
// "missing N cells", which is misleading. The narrower aria-label scanner
// below catches that case explicitly.
const ARIA_RE =
  /^(?<dim>.+?)\s+score\s+for\s+(?<org>.+?)\s*:\s*(?<pct>\d+)\s*%\s*$/i;

/** Same shape as ARIA_RE but accepts decimal percents — used solely to
 * detect "we found a score-shaped label we couldn't parse" so the error
 * message points at the offending label, not at the missing cell. */
const ARIA_RE_LOOSE =
  /^(?<dim>.+?)\s+score\s+for\s+(?<org>.+?)\s*:\s*(?<pct>[\d.]+)\s*%\s*$/i;

export interface ParsedAILabWatch {
  /** Per-(org × dimension) percent in 0-100. Keyed by orgSlug then dimSlug. */
  perDimension: Record<string, Record<string, number>>;
  /** Per-org overall percent in 0-100. Keyed by orgSlug. */
  overall: Record<string, number>;
}

/**
 * Shape of `data/scorecards/raw/ailabwatch/<wave>/grades.json`. Matches
 * the `AILabWatchWaveFile` interface in `sources/ailabwatch.ts` so the
 * adapter parses the file we emit without translation.
 */
export interface AILabWatchGradesFile {
  publishedAt: string;
  waveLabel: string;
  sourceUrl: string;
  methodologyUrl?: string | null;
  license: string | null;
  notes: string;
  isLatest: boolean;
  dimensions: Array<{ slug: string; label: string; weight: number | null }>;
  grades: Array<{
    org: string;
    aliases?: string[];
    scores: Record<string, string>;
    sourceUrls?: Record<string, string>;
  }>;
}

export interface BuildGradesOpts {
  /** ISO YYYY-MM-DD date for the snapshot. */
  publishedAt: string;
  /** Display label for the wave. */
  waveLabel: string;
  /** Source URL recorded on the snapshot. */
  sourceUrl: string;
  /** Methodology URL recorded on the snapshot. */
  methodologyUrl?: string | null;
  /** Verbatim notes — used for the "no longer maintained" disclosure. */
  notes: string;
}

/**
 * Build the `grades.json` payload from a parsed scorecard. Pure function
 * — testable without fs or network — so a regression in the formatting
 * layer is caught by unit test, not by a sync-against-prod failure.
 */
export function buildAILabWatchGradesFile(
  parsed: ParsedAILabWatch,
  opts: BuildGradesOpts,
): AILabWatchGradesFile {
  const dims = AILW_DIMENSIONS.map((d) => ({
    slug: d.slug,
    label: d.label,
    // The site internally uses per-category weights for its "Weighted
    // score" branding but does not expose them as numbers in HTML.
    // Leave null rather than fabricate values.
    weight: null,
  }));

  const grades: AILabWatchGradesFile["grades"] = AILW_ORGS.map((org) => {
    const overall = parsed.overall[org.slug];
    const perDim = parsed.perDimension[org.slug];
    if (overall == null) {
      throw new Error(`buildAILabWatchGradesFile: no overall score for "${org.slug}"`);
    }
    if (!perDim) {
      throw new Error(`buildAILabWatchGradesFile: no per-dimension scores for "${org.slug}"`);
    }
    const scores: Record<string, string> = { overall: `${overall}%` };
    for (const d of AILW_DIMENSIONS) {
      const v = perDim[d.slug];
      if (v == null) {
        throw new Error(
          `buildAILabWatchGradesFile: no "${d.slug}" score for org "${org.slug}"`,
        );
      }
      scores[d.slug] = `${v}%`;
    }
    return { org: org.display, scores };
  });

  return {
    publishedAt: opts.publishedAt,
    waveLabel: opts.waveLabel,
    sourceUrl: opts.sourceUrl,
    methodologyUrl: opts.methodologyUrl ?? null,
    license: null,
    notes: opts.notes,
    isLatest: true,
    dimensions: dims,
    grades,
  };
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

  // Track aria-labels that *looked* like score labels but didn't parse,
  // so the error message can finger the offending label rather than just
  // claiming "missing N cells".
  const unparseable: string[] = [];

  $("[aria-label]").each((_, el) => {
    const label = $(el).attr("aria-label");
    if (!label) return;
    const m = ARIA_RE.exec(label);
    if (!m?.groups) {
      // The score-label-looking-but-unparseable case (e.g., decimals,
      // unexpected characters). Anything that doesn't even match the
      // loose form is a non-score label (Toggle menu, Switch theme, etc.)
      if (ARIA_RE_LOOSE.test(label)) unparseable.push(label);
      return;
    }
    const dimRaw = m.groups.dim.trim().toLowerCase();
    const orgRaw = m.groups.org.trim().toLowerCase();
    const pct = Number(m.groups.pct);
    const dim = dimByPrefix.get(dimRaw);
    const org = orgByDisplay.get(orgRaw);
    if (!dim || !org || !Number.isFinite(pct)) return;
    // Defense against site format change or HTML tampering: percents are
    // 0-100 by definition. Anything outside that range is more likely a
    // site bug or injection than a legitimate score; reject loudly so
    // bad data doesn't propagate into the snapshot.
    if (pct < 0 || pct > 100) {
      throw new Error(
        `parseAILabWatchHtml: out-of-range percent (${pct}) in aria-label "${label}"`,
      );
    }
    perDimension[org.slug][dim.slug] = pct;
  });

  if (unparseable.length > 0) {
    throw new Error(
      `parseAILabWatchHtml: ${unparseable.length} aria-label(s) had non-integer percent: ${unparseable.slice(0, 5).join(" | ")}`,
    );
  }

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
      `parseAILabWatchHtml: missing ${missing.length} cells: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "..." : ""}`,
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
    // Strip query string + fragment defensively before slug match. The
    // current site uses bare paths but a future render with `?ref=…` or
    // an in-page anchor would otherwise leave the slug unrecognized and
    // throw "missing overall scores for …".
    const slug = href
      .replace(/^\/companies\//, "")
      .replace(/[?#].*$/, "")
      .replace(/\/$/, "");
    if (!orgSlugs.has(slug)) return;
    if (overall[slug] != null) return; // first MATCH wins — see comment below

    // Find the score container — `<div class="… text-white">NN<div>%</div></div>`.
    // Its first text-node child is the numeric percent. Reading the full
    // `.text()` would yield "NN%" because Cheerio concatenates descendants.
    //
    // Note: the FIRST `/companies/<slug>` anchor on the live page is a
    // matrix-header anchor with no `.text-white` child — we skip that one
    // and the next anchor (the rollup row) carries the real score. So
    // "first match wins" means "first anchor whose .text-white child has
    // a numeric text node," not "first anchor in document order."
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
