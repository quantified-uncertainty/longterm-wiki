/**
 * SaferAI Ratings HTML scraper (QUA-750).
 *
 * Extracts top-level dimension scores from the comparison page at
 * `https://ratings.safer-ai.org/comparison/` and emits a `grades.json`
 * file matching the SaferAI adapter's `SaferAIWaveFile` shape (see
 * `saferai.ts`).
 *
 * Strategy: regex-based parsing of the very predictable WordPress markup
 * — the comparison page renders each rating row as a `<div class="level">`
 * with a `<div class="title">` heading followed by 12 ordered
 * `<a class="val color-NN-NN">NN%</a>` cells (one per company in a fixed
 * column order pulled from `data-company` attributes). Top-level rows are
 * detected by their "N. " heading prefix; nested sub-rows ("N.M",
 * "N.M.L") are deliberately skipped.
 *
 * The acceptance criteria for QUA-750 only require the four top-level
 * pillars + overall — sub-pillar scores are out of scope for v1 and would
 * require a richer parent/child schema in scorecard_grades.
 *
 * The scraper is intentionally strict: if it can't find exactly 12
 * companies, exactly the 4 expected pillar slugs, or the expected score
 * count per row, it throws. That signals layout drift and the operator
 * should refresh the cached HTML and either fix the parser or fall back
 * to LLM extraction (deferred — see QUA-750 follow-up).
 */

const COMPANY_HEADER_RE = /data-company="([^"]+)"/g;
const TITLE_RE = /class="title(?:\s+final)?"[^>]*>([^<]+?)(?:\s*<svg|\s*<\/)/gs;
const VAL_RE = /class="val color-\d+-\d+"[^>]*>(\d+)%/g;

const EXPECTED_COMPANY_COUNT = 12;
const EXPECTED_PILLAR_COUNT = 4;
const TOP_LEVEL_TITLE_RE = /^(\d)\.\s+(.+)$/;

/** Maps a SaferAI section heading to the canonical dimension slug. */
const PILLAR_SLUGS: Record<string, string> = {
  "1": "risk-identification",
  "2": "risk-analysis-evaluation",
  "3": "risk-treatment",
  "4": "risk-governance",
};

/** Display labels — matches SaferAI's pillar names verbatim. */
const PILLAR_LABELS: Record<string, string> = {
  "1": "Risk Identification",
  "2": "Risk Analysis and Evaluation",
  "3": "Risk Treatment",
  "4": "Risk Governance",
};

/** SaferAI publishes equal weights across the four pillars (0.25 each). */
const PILLAR_WEIGHT = 0.25;

export interface ScrapedSaferaiWave {
  publishedAt: string;
  waveLabel: string;
  sourceUrl: string;
  methodologyUrl: string | null;
  license: string | null;
  notes: string | null;
  isLatest: boolean;
  dimensions: Array<{ slug: string; label: string; weight: number }>;
  grades: Array<{
    org: string;
    scores: Record<string, string>;
  }>;
}

export interface ScrapeOptions {
  /** Override the published date. Default: derived from the "as of …" text on the page. */
  publishedAt?: string;
  /** Override the wave label. Default: derived from the published date. */
  waveLabel?: string;
  /** URL to record on the snapshot. Default: comparison page URL. */
  sourceUrl?: string;
  /** Mark this wave as the latest (default: true). */
  isLatest?: boolean;
}

/** Parse the body of the SaferAI comparison HTML page. */
export function scrapeSaferaiHtml(
  html: string,
  opts: ScrapeOptions = {},
): ScrapedSaferaiWave {
  const bodyStart = html.indexOf("<body");
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;

  // 1. Extract the company column order from the first 12 distinct
  // `data-company="X"` headers (the matrix repeats them per row, so we
  // dedupe while preserving the order of first appearance).
  const companies: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(COMPANY_HEADER_RE)) {
    const name = m[1].trim();
    if (seen.has(name)) continue;
    seen.add(name);
    companies.push(name);
    if (companies.length === EXPECTED_COMPANY_COUNT) break;
  }
  if (companies.length !== EXPECTED_COMPANY_COUNT) {
    throw new Error(
      `[saferai-scraper] expected ${EXPECTED_COMPANY_COUNT} companies via data-company, got ${companies.length}: [${companies.join(", ")}]. SaferAI markup may have drifted — refresh cached HTML.`,
    );
  }

  // 2. Walk each `<div class="title…">` heading and collect the next 12
  // `<a class="val color-…">NN%</a>` values that appear before the next
  // heading. This naturally handles both top-level rows ("Overall score",
  // "1. Risk Identification") and nested sub-rows ("1.1 …", "2.1.1 …")
  // — we filter to top-level after collection.
  type Row = { title: string; values: string[]; offset: number };
  const titles: Row[] = [];
  for (const m of body.matchAll(TITLE_RE)) {
    titles.push({ title: m[1].trim(), values: [], offset: m.index ?? 0 });
  }
  for (let i = 0; i < titles.length; i++) {
    const start = titles[i].offset;
    const end = i + 1 < titles.length ? titles[i + 1].offset : body.length;
    const chunk = body.slice(start, end);
    const vals: string[] = [];
    for (const m of chunk.matchAll(VAL_RE)) {
      vals.push(m[1]);
      if (vals.length === EXPECTED_COMPANY_COUNT) break;
    }
    titles[i].values = vals;
  }

  // 3. Pull "Overall score" + the four "N. <Pillar>" rows.
  const overall = titles.find((t) => /^Overall score\b/i.test(t.title));
  if (!overall) {
    throw new Error(
      `[saferai-scraper] could not find "Overall score" row. SaferAI markup may have drifted.`,
    );
  }
  if (overall.values.length !== EXPECTED_COMPANY_COUNT) {
    throw new Error(
      `[saferai-scraper] "Overall score" row has ${overall.values.length} values, expected ${EXPECTED_COMPANY_COUNT}.`,
    );
  }

  const pillars: Array<{ num: string; slug: string; label: string; values: string[] }> = [];
  for (const t of titles) {
    const m = TOP_LEVEL_TITLE_RE.exec(t.title);
    if (!m) continue;
    const num = m[1];
    const slug = PILLAR_SLUGS[num];
    if (!slug) continue;
    if (pillars.some((p) => p.num === num)) continue; // first occurrence wins
    if (t.values.length !== EXPECTED_COMPANY_COUNT) {
      throw new Error(
        `[saferai-scraper] pillar "${t.title}" has ${t.values.length} values, expected ${EXPECTED_COMPANY_COUNT}.`,
      );
    }
    pillars.push({ num, slug, label: PILLAR_LABELS[num], values: t.values });
  }
  if (pillars.length !== EXPECTED_PILLAR_COUNT) {
    throw new Error(
      `[saferai-scraper] expected ${EXPECTED_PILLAR_COUNT} top-level pillars (1.–4.), found ${pillars.length}: [${pillars.map((p) => p.num).join(", ")}].`,
    );
  }
  pillars.sort((a, b) => a.num.localeCompare(b.num));

  // 4. Derive published date + wave label from the page if not given.
  // The page renders "Up to date as of <Month> <YYYY>" near the footer.
  let inferredPublished: string | null = null;
  let inferredLabel: string | null = null;
  const asOf = /as of\s+([A-Za-z]+)\s+(\d{4})/.exec(body);
  if (asOf) {
    const monthName = asOf[1];
    const year = asOf[2];
    const monthNum = monthNameToNumber(monthName);
    if (monthNum) {
      inferredPublished = `${year}-${monthNum}-01`;
      inferredLabel = `${monthName} ${year}`;
    }
  }
  const publishedAt = opts.publishedAt ?? inferredPublished;
  if (!publishedAt) {
    throw new Error(
      `[saferai-scraper] could not infer publishedAt from "as of …" text. Pass --published-at=YYYY-MM-DD.`,
    );
  }
  const waveLabel = opts.waveLabel ?? inferredLabel ?? publishedAt;

  // 5. Assemble the wave file.
  const dimensions = pillars.map((p) => ({
    slug: p.slug,
    label: p.label,
    weight: PILLAR_WEIGHT,
  }));

  const grades = companies.map((org, colIdx) => {
    const scores: Record<string, string> = {
      overall: `${overall.values[colIdx]}%`,
    };
    for (const p of pillars) {
      scores[p.slug] = `${p.values[colIdx]}%`;
    }
    return { org, scores };
  });

  return {
    publishedAt,
    waveLabel,
    sourceUrl: opts.sourceUrl ?? "https://ratings.safer-ai.org/comparison/",
    methodologyUrl: "https://ratings.safer-ai.org/methodology/",
    license: "CC BY-SA 4.0",
    notes: null,
    isLatest: opts.isLatest ?? true,
    dimensions,
    grades,
  };
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function monthNameToNumber(name: string): string | null {
  const idx = MONTHS.indexOf(name.toLowerCase());
  if (idx < 0) return null;
  return String(idx + 1).padStart(2, "0");
}
