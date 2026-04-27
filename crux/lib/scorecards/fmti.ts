/**
 * Stanford FMTI (Foundation Model Transparency Index) Parser & Transformer
 *
 * Parses the CC-BY-4.0 CSVs published at github.com/stanford-crfm/fmti and
 * shapes them into the unified `scorecard_snapshots` + `scorecard_grades`
 * record types from QUA-688 Phase 1.
 *
 * Data structure across waves:
 *   - Dec 2025: Dec2025_indicators.csv (Domain, Subdomain, Indicator, ...)
 *               Dec2025_scores.csv     (Indicator, <org1>, <org2>, ...)
 *   - May 2024: May2024_scores.csv (Indicator, <org1>, ...) — no Domain/Subdomain
 *   - Oct 2023: October2023_scores.csv (Domain, Subdomain, Indicator, <orgs>, Total)
 *
 * This module is pure — it does not fetch, does not POST. See
 * `fmti-ingest.ts` for the orchestration layer.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single indicator definition (from indicators.csv or inline scores file). */
export interface FmtiIndicator {
  domain: string;
  subdomain: string;
  name: string;
}

/** A score row: indicator name + binary 0/1 score per org. */
export interface FmtiScoreRow {
  indicator: string;
  // Per-org score; missing/blank → null. Values are "0" or "1" in the source.
  scores: Record<string, number | null>;
}

/** Wave configuration. */
export interface FmtiWave {
  /** Stable id for the snapshot row (e.g. `fmti-dec-2025`). */
  snapshotId: string;
  /** Human label (e.g. `v1.2 Dec 2025`). */
  waveLabel: string;
  /** ISO date `YYYY-MM-DD`. */
  publishedAt: string;
  /** Sub-path under repo, e.g. `Dec2025`. */
  pathPrefix: string;
  /** Score CSV filename. */
  scoresFile: string;
  /**
   * Indicator-definitions CSV filename — null when the wave's scores CSV
   * is integrated (Domain, Subdomain, Indicator inline).
   */
  indicatorsFile: string | null;
  /**
   * True when the scores file's first three columns are
   * `Domain, Subdomain, Indicator` and a trailing `Total` column is present
   * (Oct 2023 layout).
   */
  scoresHasDomain: boolean;
  /** GitHub-flavored canonical URL for this wave (used as sourceUrl). */
  sourceUrl: string;
  methodologyUrl: string | null;
}

/** Snapshot record matching the `/api/scorecard-snapshots/sync` schema. */
export interface ScorecardSnapshotRecord {
  id: string;
  scorecardSource: "fmti";
  waveLabel: string;
  publishedAt: string;
  sourceUrl: string;
  methodologyUrl: string | null;
  license: string;
  orgCount: number;
  dimensionCount: number;
  notes: string | null;
  isLatest: boolean;
  sourceActive: boolean;
}

/** Grade record matching the `/api/scorecard-grades/sync` schema. */
export interface ScorecardGradeRecord {
  id: string;
  snapshotId: string;
  entityId: string;
  entityDisplayName: string;
  dimensionSlug: string;
  dimensionLabel: string;
  dimensionWeight: number | null;
  dimensionParentSlug: string | null;
  scoreNumeric: number | null;
  scoreLetter: string | null;
  scoreRaw: string;
  notes: string | null;
  sourceUrl: string | null;
}

/** Result returned by buildGradeRecords for one wave. */
export interface BuildResult {
  snapshot: ScorecardSnapshotRecord;
  grades: ScorecardGradeRecord[];
  /** Orgs from the CSV that the caller passed `null` for in `orgEntityIds` — skipped. */
  unresolvedOrgs: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FMTI_REPO_RAW = "https://raw.githubusercontent.com/stanford-crfm/fmti/main";

const DOMAIN_ORDER: Record<string, number> = {
  Upstream: 1,
  Model: 2,
  Downstream: 3,
};

/** All known FMTI waves, ordered oldest → newest. */
export const FMTI_WAVES: readonly FmtiWave[] = [
  {
    snapshotId: "fmti-oct-2023",
    waveLabel: "v1.0 October 2023",
    publishedAt: "2023-10-18",
    pathPrefix: "October2023",
    scoresFile: "October2023_scores.csv",
    indicatorsFile: null,
    scoresHasDomain: true,
    sourceUrl: "https://crfm.stanford.edu/fmti/October2023/",
    methodologyUrl: "https://arxiv.org/abs/2310.12941",
  },
  {
    snapshotId: "fmti-may-2024",
    waveLabel: "v1.1 May 2024",
    publishedAt: "2024-05-21",
    pathPrefix: "May2024",
    scoresFile: "May2024_scores.csv",
    indicatorsFile: null,
    scoresHasDomain: false,
    sourceUrl: "https://crfm.stanford.edu/fmti/May2024/",
    methodologyUrl: "https://arxiv.org/abs/2407.12929",
  },
  {
    snapshotId: "fmti-dec-2025",
    waveLabel: "v1.2 December 2025",
    publishedAt: "2025-12-01",
    pathPrefix: "Dec2025",
    scoresFile: "Dec2025_scores.csv",
    indicatorsFile: "Dec2025_indicators.csv",
    scoresHasDomain: false,
    sourceUrl: "https://crfm.stanford.edu/fmti/",
    methodologyUrl: "https://crfm.stanford.edu/fmti/",
  },
] as const;

/** Build the github raw URL for a wave's CSV file. */
export function fmtiRawUrl(wave: FmtiWave, file: string): string {
  return `${FMTI_REPO_RAW}/${wave.pathPrefix}/${file}`;
}

// ---------------------------------------------------------------------------
// CSV parser (RFC4180-ish, sufficient for FMTI files)
// ---------------------------------------------------------------------------

/**
 * Parse CSV text into rows of fields. Handles quoted fields with embedded
 * newlines, commas, and escaped quotes (`""` → `"`).
 *
 * Strips a leading UTF-8 BOM if present (Oct 2023 CSV has one).
 */
export function parseCsv(csv: string): string[][] {
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        cur.push(field);
        field = "";
      } else if (ch === "\n") {
        cur.push(field);
        rows.push(cur);
        cur = [];
        field = "";
      } else if (ch === "\r") {
        // skip — handled by \n
      } else {
        field += ch;
      }
    }
  }
  // Trailing field / row (file may not end with \n).
  if (field !== "" || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  // Drop trailing all-empty row (CSVs that end with \n produce one).
  while (rows.length > 0 && rows[rows.length - 1].every((f) => f === "")) {
    rows.pop();
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Wave-specific parsers
// ---------------------------------------------------------------------------

/**
 * Parse a Dec2025-style indicators.csv with columns:
 *   Domain, Subdomain, Indicator, Definition, Notes, Example disclosure
 *
 * Returns a list keyed by indicator name (preserving file order).
 */
export function parseFmtiIndicators(csv: string): FmtiIndicator[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];

  const header = rows[0].map((c) => c.trim());
  const domainIdx = header.indexOf("Domain");
  const subdomainIdx = header.indexOf("Subdomain");
  const indicatorIdx = header.indexOf("Indicator");
  if (domainIdx === -1 || subdomainIdx === -1 || indicatorIdx === -1) {
    throw new Error(
      `FMTI indicators CSV missing expected columns. Got header: ${header.join(", ")}`,
    );
  }

  const out: FmtiIndicator[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[indicatorIdx] ?? "").trim();
    if (!name) continue;
    out.push({
      domain: (r[domainIdx] ?? "").trim(),
      subdomain: (r[subdomainIdx] ?? "").trim(),
      name,
    });
  }
  return out;
}

/**
 * Parse a flat scores CSV (Dec2025 / May2024 layout) with header:
 *   Indicator, <org1>, <org2>, ...
 *
 * Returns one row per indicator with per-org binary scores.
 */
export function parseFmtiFlatScores(csv: string): {
  orgs: string[];
  rows: FmtiScoreRow[];
} {
  const rows = parseCsv(csv);
  if (rows.length < 2) return { orgs: [], rows: [] };

  const header = rows[0].map((c) => c.trim());
  if (header[0] !== "Indicator") {
    throw new Error(
      `FMTI flat scores CSV first column should be "Indicator". Got header: ${header.join(", ")}`,
    );
  }
  const orgs = header.slice(1).filter((h) => h.length > 0);

  const out: FmtiScoreRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const indicator = (r[0] ?? "").trim();
    if (!indicator) continue;
    const scores: Record<string, number | null> = {};
    for (let j = 0; j < orgs.length; j++) {
      const cell = (r[j + 1] ?? "").trim();
      scores[orgs[j]] = parseScoreCell(cell);
    }
    out.push({ indicator, scores });
  }
  return { orgs, rows: out };
}

/**
 * Parse the Oct 2023 integrated scores CSV with header:
 *   Domain, Subdomain, Indicator, <org1>, <org2>, ..., Total
 *
 * The trailing `Total` column is dropped.
 */
export function parseFmtiOct2023Scores(csv: string): {
  orgs: string[];
  rows: Array<FmtiScoreRow & { domain: string; subdomain: string }>;
} {
  const rows = parseCsv(csv);
  if (rows.length < 2) return { orgs: [], rows: [] };

  const header = rows[0].map((c) => c.trim());
  if (
    header[0] !== "Domain" ||
    header[1] !== "Subdomain" ||
    header[2] !== "Indicator"
  ) {
    throw new Error(
      `FMTI Oct2023 scores CSV expected first columns Domain,Subdomain,Indicator. Got: ${header.join(", ")}`,
    );
  }
  // Drop trailing Total column from the org list, if present.
  const orgEnd = header[header.length - 1] === "Total"
    ? header.length - 1
    : header.length;
  const orgs = header.slice(3, orgEnd).filter((h) => h.length > 0);

  const out: Array<FmtiScoreRow & { domain: string; subdomain: string }> = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const indicator = (r[2] ?? "").trim();
    if (!indicator) continue;
    const domain = (r[0] ?? "").trim();
    const subdomain = (r[1] ?? "").trim();
    // Skip aggregate footer rows like `,,Total,54,53,...` that the
    // October 2023 file appends at the bottom.
    if (!domain && !subdomain && indicator.toLowerCase() === "total") continue;
    const scores: Record<string, number | null> = {};
    for (let j = 0; j < orgs.length; j++) {
      const cell = (r[j + 3] ?? "").trim();
      scores[orgs[j]] = parseScoreCell(cell);
    }
    out.push({ domain, subdomain, indicator, scores });
  }
  return { orgs, rows: out };
}

function parseScoreCell(cell: string): number | null {
  if (cell === "" || cell === "-" || cell.toLowerCase() === "n/a") return null;
  const n = Number(cell);
  if (Number.isFinite(n)) return n;
  return null;
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

/** Lowercase kebab-case slug. */
export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Compose a parent slug for a domain (e.g. `upstream`). */
export function domainSlug(domain: string): string {
  return slugify(domain);
}

/**
 * Compose a parent slug for a subdomain. Prefixed with the domain to keep
 * slugs unique even if subdomain names ever overlap across domains.
 */
export function subdomainSlug(domain: string, subdomain: string): string {
  return `${slugify(domain)}--${slugify(subdomain)}`;
}

// ---------------------------------------------------------------------------
// Builder — given parsed indicators + scores + org resolver → records
// ---------------------------------------------------------------------------

/** Org resolver: org display name → entity stableId or null (unresolved). */
export type OrgResolver = (orgName: string) => string | null;

interface BuildOptions {
  wave: FmtiWave;
  /** True for the wave that should be tagged `is_latest=true`. */
  isLatest: boolean;
  /** Indicators with domain/subdomain. */
  indicators: FmtiIndicator[];
  /** Score rows aligned by `indicator` name to `indicators`. */
  scores: FmtiScoreRow[];
  /** Org names appearing in scores file. */
  orgs: string[];
  /** Resolves org display name → entity stableId. */
  resolveOrg: OrgResolver;
}

/**
 * Build a snapshot row + all grade rows for one FMTI wave.
 *
 * Per (resolved) org, emits:
 *   - 100 indicator-level grades (parent: subdomain)
 *   - ~13–19 subdomain rollups (parent: domain) — mean × 100
 *   - 3 domain rollups (parent: overall)         — mean × 100
 *   - 1 overall grade                            — mean × 100
 *
 * Indicators present in the scores CSV but missing from the indicators
 * list are emitted with empty domain/subdomain (parent: overall) — this
 * keeps degenerate input safe but is signalled via a non-empty
 * `unresolvedOrgs` list when it happens. (Currently it does not.)
 */
export function buildFmtiRecords(opts: BuildOptions): BuildResult {
  const { wave, isLatest, indicators, scores, orgs, resolveOrg } = opts;

  const indicatorMap = new Map(indicators.map((i) => [i.name, i] as const));

  // Resolve orgs once.
  const resolved: Array<{ name: string; entityId: string }> = [];
  const unresolvedOrgs: string[] = [];
  for (const o of orgs) {
    const id = resolveOrg(o);
    if (id) resolved.push({ name: o, entityId: id });
    else unresolvedOrgs.push(o);
  }

  // Stable order: domain, subdomain, indicator name.
  const indicatorOrder = (i: FmtiIndicator) =>
    `${(DOMAIN_ORDER[i.domain] ?? 9).toString().padStart(2, "0")}|${i.subdomain}|${i.name}`;
  const orderedIndicators = [...indicators].sort(
    (a, b) => indicatorOrder(a).localeCompare(indicatorOrder(b)),
  );

  const grades: ScorecardGradeRecord[] = [];

  for (const { name: orgName, entityId } of resolved) {
    // Per-indicator grades + accumulators for rollups.
    const subdomainAcc = new Map<
      string,
      { domain: string; subdomain: string; sum: number; n: number }
    >();
    const domainAcc = new Map<string, { sum: number; n: number }>();
    let overallSum = 0;
    let overallN = 0;

    for (const sr of scores) {
      const ind = indicatorMap.get(sr.indicator);
      const score = sr.scores[orgName];
      if (score == null) continue;

      const indicatorSlug = slugify(sr.indicator);
      const subSlug = ind ? subdomainSlug(ind.domain, ind.subdomain) : null;
      const domSlug = ind ? domainSlug(ind.domain) : null;

      grades.push({
        id: gradeId(wave.snapshotId, entityId, indicatorSlug),
        snapshotId: wave.snapshotId,
        entityId,
        entityDisplayName: orgName,
        dimensionSlug: indicatorSlug,
        dimensionLabel: sr.indicator,
        dimensionWeight: null,
        dimensionParentSlug: subSlug ?? "overall",
        scoreNumeric: score * 100, // 0/1 → 0/100 percent
        scoreLetter: null,
        scoreRaw: String(score),
        notes: null,
        sourceUrl: null,
      });

      if (ind) {
        const subKey = subSlug!;
        const accSub = subdomainAcc.get(subKey) ?? {
          domain: ind.domain,
          subdomain: ind.subdomain,
          sum: 0,
          n: 0,
        };
        accSub.sum += score;
        accSub.n += 1;
        subdomainAcc.set(subKey, accSub);

        const accDom = domainAcc.get(domSlug!) ?? { sum: 0, n: 0 };
        accDom.sum += score;
        accDom.n += 1;
        domainAcc.set(domSlug!, accDom);
      }
      overallSum += score;
      overallN += 1;
    }

    // Sort subdomain rollups by domain order, then subdomain name.
    const subdomainEntries = [...subdomainAcc.entries()].sort(([, a], [, b]) =>
      `${(DOMAIN_ORDER[a.domain] ?? 9).toString().padStart(2, "0")}|${a.subdomain}`.localeCompare(
        `${(DOMAIN_ORDER[b.domain] ?? 9).toString().padStart(2, "0")}|${b.subdomain}`,
      ),
    );
    for (const [slug, acc] of subdomainEntries) {
      const pct = acc.n === 0 ? 0 : (acc.sum / acc.n) * 100;
      grades.push({
        id: gradeId(wave.snapshotId, entityId, slug),
        snapshotId: wave.snapshotId,
        entityId,
        entityDisplayName: orgName,
        dimensionSlug: slug,
        dimensionLabel: acc.subdomain,
        dimensionWeight: null,
        dimensionParentSlug: domainSlug(acc.domain),
        scoreNumeric: round1(pct),
        scoreLetter: null,
        scoreRaw: `${acc.sum}/${acc.n}`,
        notes: null,
        sourceUrl: null,
      });
    }

    // Domain rollups (Upstream → Model → Downstream).
    const domainEntries = [...domainAcc.entries()].sort(([slugA], [slugB]) => {
      const labelA = invertSlug(slugA, indicators);
      const labelB = invertSlug(slugB, indicators);
      return (DOMAIN_ORDER[labelA] ?? 9) - (DOMAIN_ORDER[labelB] ?? 9);
    });
    for (const [slug, acc] of domainEntries) {
      const label = invertSlug(slug, indicators);
      const pct = acc.n === 0 ? 0 : (acc.sum / acc.n) * 100;
      grades.push({
        id: gradeId(wave.snapshotId, entityId, slug),
        snapshotId: wave.snapshotId,
        entityId,
        entityDisplayName: orgName,
        dimensionSlug: slug,
        dimensionLabel: label,
        dimensionWeight: null,
        dimensionParentSlug: "overall",
        scoreNumeric: round1(pct),
        scoreLetter: null,
        scoreRaw: `${acc.sum}/${acc.n}`,
        notes: null,
        sourceUrl: null,
      });
    }

    // Overall.
    const overallPct = overallN === 0 ? 0 : (overallSum / overallN) * 100;
    grades.push({
      id: gradeId(wave.snapshotId, entityId, "overall"),
      snapshotId: wave.snapshotId,
      entityId,
      entityDisplayName: orgName,
      dimensionSlug: "overall",
      dimensionLabel: "Overall",
      dimensionWeight: null,
      dimensionParentSlug: null,
      scoreNumeric: round1(overallPct),
      scoreLetter: null,
      scoreRaw: `${overallSum}/${overallN}`,
      notes: null,
      sourceUrl: null,
    });
  }

  // Distinct dimensions across all grades for orgCount/dimensionCount.
  const distinctDimensions = new Set(grades.map((g) => g.dimensionSlug));

  const snapshot: ScorecardSnapshotRecord = {
    id: wave.snapshotId,
    scorecardSource: "fmti",
    waveLabel: wave.waveLabel,
    publishedAt: wave.publishedAt,
    sourceUrl: wave.sourceUrl,
    methodologyUrl: wave.methodologyUrl,
    license: "CC-BY-4.0",
    orgCount: resolved.length,
    dimensionCount: distinctDimensions.size,
    notes: unresolvedOrgs.length === 0
      ? null
      : `Unresolved orgs (skipped): ${unresolvedOrgs.join(", ")}`,
    isLatest,
    sourceActive: true,
  };

  return { snapshot, grades, unresolvedOrgs };
}

/**
 * Compose a deterministic grade id within the 200-char primary-key limit.
 * Format: `<snapshotId>__<entitySidShort>__<dimensionSlug>`. We truncate
 * `entityId` only if a wildly long stableId surprised us — the schema
 * caps `id` at 300 chars in the sync schema (Zod), but the `things` table
 * `id` column is 300 chars too. Stay well under both.
 */
function gradeId(
  snapshotId: string,
  entityId: string,
  dimensionSlug: string,
): string {
  const id = `${snapshotId}__${entityId}__${dimensionSlug}`;
  if (id.length <= 250) return id;
  // Pathological: trim the dimension slug. We never expect this in practice.
  const room = 250 - snapshotId.length - entityId.length - 4;
  return `${snapshotId}__${entityId}__${dimensionSlug.slice(0, Math.max(8, room))}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Reverse a domain slug back to the original Domain label by scanning the
 * indicators list. Falls back to a Title-Case approximation.
 */
function invertSlug(slug: string, indicators: FmtiIndicator[]): string {
  for (const i of indicators) {
    if (slugify(i.domain) === slug) return i.domain;
  }
  return slug.replace(/(^|-)(.)/g, (_, sep, ch) => (sep ? " " : "") + ch.toUpperCase()).trim();
}
