/**
 * Seoul Commitment Tracker scraper (QUA-752).
 *
 * Extracts per-(company, dimension) verdicts from the Next.js client bundle
 * served by `https://www.seoul-tracker.org` and emits a `grades.json` file
 * matching the Seoul adapter's `SeoulWaveFile` shape (see `seoul.ts`).
 *
 * Strategy: the index page is a Next.js SPA, so the static HTML only
 * contains the company sidebar (16 buttons with overall colors). The
 * per-company / per-dimension verdicts live in the page chunk under
 * `/_next/static/chunks/app/page-<hash>.js` as three minified JS literals:
 *
 *   - `[{id:"amazon",name:"Amazon"}, …]`         — companies
 *   - `[{id:"risk-evaluations",name:"Risk Evaluation"}, …]` — dimensions
 *   - `{amazon:{"risk-evaluations":2, …}, …}`    — score table (1-4)
 *
 * The score scale (verified against the page's color logic — see
 * `s<=1?danger : s<=2?warning : s<=4?success` in the chunk):
 *
 *   1 → Unfulfilled
 *   2 → Partial
 *   3 → Fulfilled
 *   4 → Fulfilled (rare; Anthropic's halting-procedures + safety-investment
 *       are the only 4s as of Feb 2025; the page renders 3 and 4 with the
 *       same green band)
 *
 * Overall verdict per company (matches the colored sidebar buttons —
 * verified against all 16 orgs):
 *
 *   min ≥ 2 → Fulfilled
 *   max ≤ 1 → Unfulfilled
 *   else    → Partial
 *
 * The scraper is intentionally strict: if it can't find the page-chunk
 * URL, the three data literals, exactly 16 companies, exactly 5
 * dimensions, or a numeric verdict for every (org, dimension) pair, it
 * throws. That signals layout drift and the operator should refresh the
 * cached HTML/chunk and either fix the parser or fall back to manual
 * extraction.
 */

const PAGE_CHUNK_RE = /\/_next\/static\/chunks\/app\/page-[A-Za-z0-9]+\.js/;
const COMPANIES_NEEDLE = '[{id:"amazon",name:"Amazon"}';
const DIMENSIONS_NEEDLE = '[{id:"risk-evaluations",name:"Risk Evaluation"}';
const SCORES_NEEDLE = '{amazon:{"risk-evaluations":';

const EXPECTED_COMPANY_COUNT = 16;
const EXPECTED_DIMENSION_COUNT = 5;

const NUMERIC_VERDICT_LABELS: Record<number, string> = {
  1: "Unfulfilled",
  2: "Partial",
  3: "Fulfilled",
  // The tracker visually merges 3 and 4 into the same green band, so we
  // treat them as the same categorical verdict ("Fulfilled"). The numeric
  // score is preserved internally and could be surfaced separately if
  // future tracker waves start using 4 more meaningfully.
  4: "Fulfilled",
};

/** Compute the company's overall verdict from its per-dimension scores. */
export function computeOverallVerdict(scores: Record<string, number>): string {
  const values = Object.values(scores);
  if (values.length === 0) {
    throw new Error("[seoul-scraper] cannot compute overall: no scores");
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min >= 2) return "Fulfilled";
  if (max <= 1) return "Unfulfilled";
  return "Partial";
}

export function numericToVerdict(score: number): string {
  const label = NUMERIC_VERDICT_LABELS[score];
  if (!label) {
    throw new Error(
      `[seoul-scraper] unknown numeric verdict ${score}; expected 1-4. Tracker may have introduced a new score band — verify the legend at https://www.seoul-tracker.org and update NUMERIC_VERDICT_LABELS.`,
    );
  }
  return label;
}

export interface ScrapedSeoulWave {
  publishedAt: string;
  waveLabel: string;
  sourceUrl: string;
  methodologyUrl: string | null;
  license: string | null;
  notes: string | null;
  isLatest: boolean;
  dimensions: Array<{ slug: string; label: string }>;
  grades: Array<{
    org: string;
    /** dimensionSlug → "Fulfilled" | "Partial" | "Unfulfilled"; "overall" included. */
    scores: Record<string, string>;
  }>;
}

export interface ScrapeOptions {
  /** Override the published date. Default: derived from the "Deadline: <Month> <DD>, <YYYY>" header. */
  publishedAt?: string;
  /** Override the wave label. Default: derived from publishedAt. */
  waveLabel?: string;
  /** URL to record on the snapshot. Default: tracker home page. */
  sourceUrl?: string;
  /** Mark this wave as the latest (default: true). */
  isLatest?: boolean;
}

interface ParsedChunk {
  companies: Array<{ id: string; name: string }>;
  dimensions: Array<{ id: string; name: string }>;
  scores: Record<string, Record<string, number>>;
}

/**
 * Find a balanced bracketed expression (`{…}` or `[…]`) starting at `start`
 * in `s`. Returns the substring including the outer brackets. Quoted
 * strings are skipped to avoid mistaking a `}` inside a string for a
 * close. Used to walk the minified JS literals out of the page chunk.
 */
function readBalanced(s: string, start: number, open: string, close: string): string {
  if (s[start] !== open) {
    throw new Error(
      `[seoul-scraper] expected '${open}' at offset ${start}, got '${s[start]}'`,
    );
  }
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  throw new Error(
    `[seoul-scraper] unbalanced ${open}…${close} starting at offset ${start}`,
  );
}

/**
 * Quote unquoted property keys in a JS-object-literal string so it can be
 * parsed as JSON. Handles `{key:` and `,key:` cases. Skips keys that are
 * already quoted. Does not handle string interpolation, comments, or
 * methods — fine for our minified data literals which are pure data.
 */
function jsObjectToJson(jsExpr: string): string {
  // Match a `{` or `,` followed by an identifier-looking key followed by a colon.
  // We use a negative-lookbehind for `"` to skip already-quoted keys.
  return jsExpr.replace(/([{,])\s*([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
}

function parseChunk(chunk: string): ParsedChunk {
  // Companies array
  const companiesIdx = chunk.indexOf(COMPANIES_NEEDLE);
  if (companiesIdx < 0) {
    throw new Error(
      `[seoul-scraper] could not find companies array (needle: ${JSON.stringify(COMPANIES_NEEDLE)}). Page chunk layout may have drifted.`,
    );
  }
  const companiesRaw = readBalanced(chunk, companiesIdx, "[", "]");
  const companies = JSON.parse(jsObjectToJson(companiesRaw)) as Array<{
    id: string;
    name: string;
  }>;

  // Dimensions array
  const dimensionsIdx = chunk.indexOf(DIMENSIONS_NEEDLE);
  if (dimensionsIdx < 0) {
    throw new Error(
      `[seoul-scraper] could not find dimensions array (needle: ${JSON.stringify(DIMENSIONS_NEEDLE)}). Page chunk layout may have drifted.`,
    );
  }
  const dimensionsRaw = readBalanced(chunk, dimensionsIdx, "[", "]");
  const dimensions = JSON.parse(jsObjectToJson(dimensionsRaw)) as Array<{
    id: string;
    name: string;
  }>;

  // Scores object
  const scoresIdx = chunk.indexOf(SCORES_NEEDLE);
  if (scoresIdx < 0) {
    throw new Error(
      `[seoul-scraper] could not find scores object (needle: ${JSON.stringify(SCORES_NEEDLE)}). Page chunk layout may have drifted.`,
    );
  }
  const scoresRaw = readBalanced(chunk, scoresIdx, "{", "}");
  const scores = JSON.parse(jsObjectToJson(scoresRaw)) as Record<
    string,
    Record<string, number>
  >;

  return { companies, dimensions, scores };
}

/** Parse a "Deadline: <Month> <DD>, <YYYY>" header into a YYYY-MM-DD string. */
function parseDeadline(html: string): string | null {
  const m = /Deadline:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(html);
  if (!m) return null;
  const monthNum = monthNameToNumber(m[1]);
  if (!monthNum) return null;
  return `${m[3]}-${monthNum}-${m[2].padStart(2, "0")}`;
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
  const lower = name.toLowerCase().replace(/\.$/, "");
  // Try full name first, then 3-letter abbreviation (jan, feb, …) since
  // the tracker header uses the abbreviated form ("Deadline: Feb 10, 2025").
  let idx = MONTHS.indexOf(lower);
  if (idx < 0 && lower.length >= 3) {
    idx = MONTHS.findIndex((m) => m.startsWith(lower));
  }
  if (idx < 0) return null;
  return String(idx + 1).padStart(2, "0");
}

/** Extract the page-chunk URL referenced by the index HTML. */
export function findPageChunkUrl(html: string): string | null {
  const m = PAGE_CHUNK_RE.exec(html);
  return m ? m[0] : null;
}

/**
 * Build a `ScrapedSeoulWave` from the index HTML + the page chunk
 * contents. Both inputs come from `https://www.seoul-tracker.org` (the
 * HTML for the deadline header, the chunk for the actual data).
 */
export function scrapeSeoul(
  indexHtml: string,
  pageChunkJs: string,
  opts: ScrapeOptions = {},
): ScrapedSeoulWave {
  const { companies, dimensions, scores } = parseChunk(pageChunkJs);

  if (companies.length !== EXPECTED_COMPANY_COUNT) {
    throw new Error(
      `[seoul-scraper] expected ${EXPECTED_COMPANY_COUNT} companies, got ${companies.length}: [${companies.map((c) => c.name).join(", ")}]. Tracker may have added/removed signatories.`,
    );
  }
  if (dimensions.length !== EXPECTED_DIMENSION_COUNT) {
    throw new Error(
      `[seoul-scraper] expected ${EXPECTED_DIMENSION_COUNT} dimensions, got ${dimensions.length}: [${dimensions.map((d) => d.name).join(", ")}]. Tracker may have changed its commitment categories.`,
    );
  }

  const dimSlugs = dimensions.map((d) => d.id);

  const grades = companies.map((company) => {
    const companyScores = scores[company.id];
    if (!companyScores) {
      throw new Error(
        `[seoul-scraper] no scores for company "${company.id}" (${company.name})`,
      );
    }
    const verdicts: Record<string, string> = {};
    for (const slug of dimSlugs) {
      const numeric = companyScores[slug];
      if (typeof numeric !== "number") {
        throw new Error(
          `[seoul-scraper] missing score for ${company.id}/${slug}; got ${JSON.stringify(numeric)}`,
        );
      }
      verdicts[slug] = numericToVerdict(numeric);
    }
    verdicts.overall = computeOverallVerdict(companyScores);
    return { org: company.name, scores: verdicts };
  });

  // Derive publishedAt + waveLabel from the page header if not given.
  let inferredPublished: string | null = parseDeadline(indexHtml);
  const publishedAt = opts.publishedAt ?? inferredPublished;
  if (!publishedAt) {
    throw new Error(
      `[seoul-scraper] could not infer publishedAt from "Deadline: <Month> <DD>, <YYYY>" text. Pass --published-at=YYYY-MM-DD.`,
    );
  }
  const waveLabel = opts.waveLabel ?? deriveWaveLabel(publishedAt);

  return {
    publishedAt,
    waveLabel,
    sourceUrl: opts.sourceUrl ?? "https://www.seoul-tracker.org",
    methodologyUrl: "https://www.seoul-tracker.org",
    license: null,
    notes: null,
    isLatest: opts.isLatest ?? true,
    dimensions: dimensions.map((d) => ({ slug: d.id, label: d.name })),
    grades,
  };
}

function deriveWaveLabel(publishedAt: string): string {
  // Default label: "<MonthName> <YYYY>" derived from a YYYY-MM-DD date.
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(publishedAt);
  if (!m) return publishedAt;
  const monthIdx = parseInt(m[2], 10) - 1;
  if (monthIdx < 0 || monthIdx >= MONTHS.length) return publishedAt;
  const monthName = MONTHS[monthIdx][0].toUpperCase() + MONTHS[monthIdx].slice(1);
  return `${monthName} ${m[1]}`;
}
