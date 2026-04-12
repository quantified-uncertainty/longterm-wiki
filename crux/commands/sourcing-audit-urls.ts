/**
 * Source-Check URL Audit — identifies evidence rows whose source URL points at
 * a generic homepage or a dead/paywalled page, ranked by domain and record type.
 *
 * Read-only; no LLM calls; no wiki-server writes. Intended workflow:
 *   1. Run `crux sourcing-audit-urls` to get a ranked list of offender domains.
 *   2. Manually inspect top offenders and fix bad URLs (replace homepages with
 *      specific pages, or delete evidence where no better URL exists).
 *   3. Run `crux sourcing-recheck` on the corrected subset.
 *
 * Phase 1 of QUA-113. Follow-ups: QUA-312 (extract URL classifier to shared
 * module, wire into classifier + re-ingest pipeline), QUA-313 (backfill +
 * sourcing-mark). See GitHub Discussion #4221 for full plan.
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { listVerdicts, getEvidenceByRecord } from '../lib/wiki-server/sourcing-client.ts';

// ── Module constants ──

/** Confidence threshold: classifyByUrl score ≥ this marks a row as "flagged homepage". */
const FLAG_THRESHOLD = 0.7;

/** Parallel evidence-fetch requests. Keeps the wiki-server load light. */
const CONCURRENCY = 8;

/** Evidence rows fetched per verdict record. Most records have 1–2. */
const EVIDENCE_PER_RECORD = 5;

/** Default verdicts to audit. */
const DEFAULT_VERDICTS = ['unverifiable', 'partial'];

/** Default per-verdict fetch limit; capped to CLAMP_LIMIT. */
const DEFAULT_LIMIT = 100;
const CLAMP_LIMIT = 2000;

/** Output-truncation limits (human-readable mode only). */
const TOP_DOMAINS_SHOWN = 30;
const TOP_SAMPLES_SHOWN = 20;
const SAMPLE_IDS_PER_DOMAIN = 3;

/** Query parameters that indicate tracking, not data content. */
const TRACKING_PREFIXES = ['utm_', 'mc_', 'oly_'];
const TRACKING_EXACT = new Set(['fbclid', 'gclid', 'yclid', 'msclkid', '_ga']);

/** Query parameters that indicate specific content (force non-homepage classification). */
const DATA_PARAM_KEYS = new Set(['id', 'v', 'q', 'search', 'article', 'item', 'page', 'post']);

/** Known URL shorteners — cannot classify without following the redirect. */
const SHORTENERS = new Set([
  'bit.ly', 't.co', 'goo.gl', 'tinyurl.com', 'ow.ly', 'buff.ly',
  'is.gd', 'shorturl.at', 'rb.gy', 'cutt.ly',
]);

/** Single-segment paths that act as homepages on most sites. */
const HOMEPAGE_PATHS = new Set([
  '/about', '/about-us', '/about_us', '/aboutus',
  '/contact', '/contact-us', '/contactus',
  '/home', '/home.html', '/index', '/index.html', '/index.htm',
  '/welcome', '/main',
]);

/** True if the caller wants ANSI color codes (TTY and NO_COLOR unset). */
function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return !!process.stdout.isTTY;
}

const ANSI = {
  bold: '\x1b[1m',
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
} as const;

const bold = (s: string) => (useColor() ? `${ANSI.bold}${s}${ANSI.reset}` : s);
const yellow = (s: string) => (useColor() ? `${ANSI.yellow}${s}${ANSI.reset}` : s);

/** Parse and clamp a user-supplied `--limit`. Guards against NaN, negative, oversize. */
function clampLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, CLAMP_LIMIT);
}

// ── URL classifier (inline; extracted to crux/lib/sourcing/url-quality.ts in QUA-312) ──

/**
 * Classify a URL by shape alone. Deterministic, no network. Used both to
 * flag homepage sources in the audit and (in Phase 2) as a fast-path for
 * resource classification.
 *
 * Confidence is calibrated so that >= 0.8 is "write directly, skip LLM" in
 * future callers. This command treats >= 0.7 as homepage-flagged.
 */
export function classifyByUrl(raw: string): {
  purpose: 'homepage' | null;
  confidence: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { purpose: null, confidence: 0, reasons: ['unparseable'] };
  }

  // Non-http(s) — skip (file://, mailto:, etc.)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { purpose: null, confidence: 0, reasons: ['non-http-scheme'] };
  }

  const host = url.hostname.toLowerCase();

  // Wayback prefix — classify by the inner URL
  if (host === 'web.archive.org' || host === 'archive.org') {
    const match = url.pathname.match(/\/web\/[^/]+\/(.+)$/);
    if (match) {
      const inner = match[1].startsWith('http')
        ? match[1]
        : `https://${match[1]}`;
      const innerResult = classifyByUrl(inner);
      return {
        ...innerResult,
        reasons: ['wayback-wrapped', ...innerResult.reasons],
      };
    }
    return { purpose: null, confidence: 0.2, reasons: ['wayback-unresolved'] };
  }

  if (SHORTENERS.has(host)) {
    return { purpose: null, confidence: 0, reasons: ['shortener'] };
  }

  // PDF: never a homepage regardless of path depth
  if (url.pathname.toLowerCase().endsWith('.pdf')) {
    return { purpose: null, confidence: 0.9, reasons: ['pdf'] };
  }

  // Normalize path for analysis
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const depth = path === '/' ? 0 : path.split('/').filter(Boolean).length;
  // Meaningful fragment (e.g., Twitter status ID, deep anchor) — not homepage.
  // Ignore `#`, `#top`, or anything ≤ 4 characters including the leading `#`.
  if (url.hash.length > 4) {
    return { purpose: null, confidence: 0.3, reasons: ['deep-fragment'] };
  }

  // Named data params (?id=, ?q=, ?v=, ...) force NOT-homepage even at root.
  // Tracking-only queries (utm_*, fbclid, ...) are ignored. Other non-tracking,
  // non-data params (e.g., ?campaign=x) are treated as benign — imperfect but
  // keeps false-positive rate low.
  for (const k of url.searchParams.keys()) {
    const keyLower = k.toLowerCase();
    if (DATA_PARAM_KEYS.has(keyLower)) {
      return { purpose: null, confidence: 0.2, reasons: ['query-data-param'] };
    }
  }

  // Depth 0: bare domain or root path (tracking-only query is fine)
  if (depth === 0) {
    reasons.push('root-path');
    return { purpose: 'homepage', confidence: 0.95, reasons };
  }

  if (depth === 1 && HOMEPAGE_PATHS.has(path.toLowerCase())) {
    reasons.push(`homepage-path:${path.toLowerCase()}`);
    return { purpose: 'homepage', confidence: 0.85, reasons };
  }

  // Deep paths (2+ segments) — almost never homepages
  if (depth >= 2) {
    return { purpose: null, confidence: 0.1, reasons: [`depth:${depth}`] };
  }

  // Depth 1 with no matching homepage path — ambiguous
  return { purpose: null, confidence: 0.4, reasons: [`depth:1:${path}`] };
}

/**
 * Canonical URL form for comparing/grouping evidence URLs and resource URLs.
 * Strips: trailing slash, www., fragment, default ports, common tracking
 * params (utm_*, fbclid, gclid). Lowercases host.
 *
 * NOT a replacement for the 9 existing URL normalizers in the codebase —
 * those serve different semantics. This one is for audit-join + domain grouping.
 */
export function normalizeUrlForJoin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.trim().toLowerCase();
  }

  // Lowercase host; strip www.
  let host = url.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);

  // Drop default ports
  const portSuffix =
    (url.port === '' || (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443'))
      ? ''
      : `:${url.port}`;

  // Strip common tracking params (utm_*, fbclid, etc.); preserve data params.
  const filteredParams = new URLSearchParams();
  for (const [k, v] of url.searchParams.entries()) {
    const keyLower = k.toLowerCase();
    if (TRACKING_EXACT.has(keyLower)) continue;
    if (TRACKING_PREFIXES.some((p) => keyLower.startsWith(p))) continue;
    filteredParams.append(k, v);
  }
  const qs = filteredParams.toString();

  // Strip trailing slash from path (but keep "/" for root)
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');

  return `${url.protocol}//${host}${portSuffix}${path}${qs ? '?' + qs : ''}`;
}

/** Extract just the host portion, normalized, for domain grouping. */
export function extractHost(raw: string): string {
  try {
    let host = new URL(raw).hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    return '(invalid-url)';
  }
}

// ── Command ──────────────────────────────────────────────────────────

interface AuditOptions extends BaseOptions {
  verdict?: string;
  'bad-url-only'?: boolean;
  badUrlOnly?: boolean;
  limit?: string;
  json?: boolean;
}

interface AuditRow {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  verdict: string;
  sourceUrl: string;
  host: string;
  flagged: boolean;
  flagReasons: string[];
  confidence: number;
}

interface DomainSummary {
  host: string;
  total: number;
  flagged: number;
  byRecordType: Record<string, number>;
  sampleRecordIds: string[];
}

async function auditCommand(
  _args: string[],
  options: AuditOptions,
): Promise<CommandResult> {
  const verdictFilterRaw = options.verdict ?? DEFAULT_VERDICTS.join(',');
  const verdicts = verdictFilterRaw.split(',').map((v) => v.trim()).filter(Boolean);
  const limit = clampLimit(options.limit);
  const badUrlOnly = options['bad-url-only'] || options.badUrlOnly;
  const isJson = options.json;

  if (!isJson) {
    console.log(bold('Source-Check URL Audit'));
    console.log(`Verdicts: ${verdicts.join(', ')}`);
    console.log(`Limit:    ${limit} verdicts`);
    console.log('');
  }

  // ── Step 1: fetch verdict records (one query per verdict type) ──
  const verdictRecords: Array<{ recordType: string; recordId: string; verdict: string }> = [];
  for (const v of verdicts) {
    if (!isJson) console.log(`Fetching verdicts where verdict=${v}...`);
    const res = await listVerdicts({ verdict: v, limit });
    if (!res.ok) {
      return {
        exitCode: 1,
        output: `Failed to fetch verdicts (${v}): ${res.message ?? 'unknown error'}`,
      };
    }
    for (const row of res.data.verdicts) {
      verdictRecords.push({
        recordType: row.recordType,
        recordId: row.recordId,
        verdict: row.verdict,
      });
    }
  }

  if (verdictRecords.length === 0) {
    return {
      exitCode: 0,
      output: isJson
        ? JSON.stringify({ rows: [], domains: [], total: 0, totalFlagged: 0 })
        : 'No verdicts matched.',
    };
  }

  if (!isJson) {
    console.log(`  Found ${verdictRecords.length} verdict record(s) across ${verdicts.length} verdict type(s).`);
    console.log('Fetching evidence for each (this may take a minute)...');
  }

  // ── Step 2: fetch evidence per record ──
  // N+1 pattern — acceptable for audit use (default --limit=100 => ~200 req).
  // A dedicated bulk endpoint is a QUA-313 follow-up if this becomes slow.
  const rows: AuditRow[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < verdictRecords.length; i += CONCURRENCY) {
    const slice = verdictRecords.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (v) => {
        const res = await getEvidenceByRecord(v.recordType, v.recordId, { limit: 5 });
        if (!res.ok) return [];
        const out: AuditRow[] = [];
        for (const e of res.data.evidence) {
          if (!e.sourceUrl) continue;
          const sourceUrl = e.sourceUrl;
          const cls = classifyByUrl(sourceUrl);
          const flagged = cls.purpose === 'homepage' && cls.confidence >= FLAG_THRESHOLD;
          out.push({
            recordType: v.recordType,
            recordId: v.recordId,
            fieldName: e.fieldName,
            verdict: v.verdict,
            sourceUrl,
            host: extractHost(sourceUrl),
            flagged,
            flagReasons: cls.reasons,
            confidence: cls.confidence,
          });
        }
        return out;
      }),
    );
    for (const r of results) rows.push(...r);
  }

  // ── Step 3: aggregate by domain (over ALL rows, so totals are accurate
  // regardless of --bad-url-only; callers can filter the sample rows client-side).
  const domainMap = new Map<string, DomainSummary>();
  for (const r of rows) {
    let d = domainMap.get(r.host);
    if (!d) {
      d = {
        host: r.host,
        total: 0,
        flagged: 0,
        byRecordType: {},
        sampleRecordIds: [],
      };
      domainMap.set(r.host, d);
    }
    d.total++;
    if (r.flagged) d.flagged++;
    d.byRecordType[r.recordType] = (d.byRecordType[r.recordType] ?? 0) + 1;
    if (d.sampleRecordIds.length < SAMPLE_IDS_PER_DOMAIN) {
      d.sampleRecordIds.push(`${r.recordType}/${r.recordId}`);
    }
  }

  const domains = [...domainMap.values()]
    // When --bad-url-only, drop domains with no flagged rows so the table isn't noise.
    .filter((d) => (badUrlOnly ? d.flagged > 0 : true))
    .sort((a, b) => {
      // Rank by flagged-count first (most "homepage-like"), then by total
      if (b.flagged !== a.flagged) return b.flagged - a.flagged;
      return b.total - a.total;
    });

  const sampleRows = badUrlOnly ? rows.filter((r) => r.flagged) : rows;
  const totalFlagged = rows.filter((r) => r.flagged).length;

  // ── Step 4: output ──
  if (isJson) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        rows: sampleRows,
        domains,
        total: sampleRows.length,
        totalFlagged,
      }),
    };
  }

  return {
    exitCode: 0,
    output: formatHumanOutput(sampleRows, domains, totalFlagged, verdicts),
  };
}

function formatHumanOutput(
  rows: AuditRow[],
  domains: DomainSummary[],
  totalFlaggedOverall: number,
  verdicts: string[],
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(bold('=== Audit Summary ==='));
  lines.push(`Evidence rows:       ${rows.length}`);
  lines.push(`Flagged as homepage: ${totalFlaggedOverall}`);
  lines.push(`Unique domains:      ${domains.length}`);
  lines.push(`Verdict filter:      ${verdicts.join(', ')}`);
  lines.push('');

  lines.push(bold('Top domains (by flagged count, then total):'));
  lines.push('-'.repeat(100));
  lines.push(bold(`${'Flagged'.padStart(7)}  ${'Total'.padStart(5)}  ${'Domain'.padEnd(40)}  Record types`));
  for (const d of domains.slice(0, TOP_DOMAINS_SHOWN)) {
    const types = Object.entries(d.byRecordType)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}:${n}`)
      .join(' ');
    const flaggedStr = d.flagged > 0
      ? yellow(String(d.flagged).padStart(7))
      : String(d.flagged).padStart(7);
    lines.push(`${flaggedStr}  ${String(d.total).padStart(5)}  ${d.host.padEnd(40)}  ${types}`);
  }
  if (domains.length > TOP_DOMAINS_SHOWN) {
    lines.push(`  ... and ${domains.length - TOP_DOMAINS_SHOWN} more domains`);
  }
  lines.push('');

  const flagged = rows.filter((r) => r.flagged).slice(0, TOP_SAMPLES_SHOWN);
  if (flagged.length > 0) {
    lines.push(bold('Sample flagged evidence:'));
    lines.push('-'.repeat(100));
    for (const r of flagged) {
      const id = r.recordId.length > 24 ? r.recordId.slice(0, 22) + '..' : r.recordId;
      const field = r.fieldName ? `.${r.fieldName}` : '';
      const url = r.sourceUrl.length > 60 ? r.sourceUrl.slice(0, 57) + '...' : r.sourceUrl;
      lines.push(`  ${r.verdict.padEnd(14)} ${r.recordType.padEnd(18)} ${(id + field).padEnd(28)} ${url}`);
    }
  }

  lines.push('');
  lines.push('Next steps:');
  lines.push('  1. Inspect the top domains above. Common patterns: bare-domain links,');
  lines.push('     /about pages, broken redirects to landing pages.');
  lines.push('  2. For each offender: replace the URL with a specific data page,');
  lines.push('     or delete the evidence if no better URL exists.');
  lines.push('  3. After fixes, run: crux sourcing-recheck --type=<record-type>');

  return lines.join('\n');
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: auditCommand,
};

export function getHelp(): string {
  return `
Source-Check URL Audit — identify evidence rows whose source URL is a homepage

Usage:
  crux sourcing-audit-urls [options]

Options:
  --verdict=X,Y          Comma-separated verdict filter (default: unverifiable,partial)
  --limit=N              Max verdict records to fetch per verdict type (default: 100)
  --bad-url-only         Show only evidence rows flagged as homepage
  --json                 Machine-readable output

Output:
  Ranked list of domains by flagged-count (homepage-like URLs), then by total
  evidence-row count. Sample flagged URLs shown at the bottom.

Workflow:
  1. Run this command to identify top-offender domains.
  2. Inspect and fix bad URLs (replace homepages with specific data pages).
  3. Run crux sourcing-recheck on the corrected subset to re-verify.

Requires WIKI_SERVER_ENV=prod in agent slots (no local wiki-server).
`.trim();
}
