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
import {
  listVerdicts,
  getEvidenceByRecords,
  evidenceRecordKey,
  MAX_EVIDENCE_BY_RECORDS,
  type EvidenceByRecordsResult,
} from '../lib/wiki-server/sourcing-client.ts';
import {
  classifyByUrl,
  normalizeUrlForJoin,
  extractHost,
  FLAG_THRESHOLD,
} from '../lib/sourcing/url-quality.ts';
import { truncate } from '../lib/text-utils.ts';

// Re-export for callers that still import from this file (Phase 1 compat).
export { classifyByUrl, normalizeUrlForJoin, extractHost };

// ── Module constants ──

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

  // Accumulate evidence across chunks, then iterate `verdictRecords` in
  // input order so report output stays deterministic regardless of
  // server-side grouping by recordType.
  const allEvidence: EvidenceByRecordsResult['evidenceByKey'] = {};
  for (let i = 0; i < verdictRecords.length; i += MAX_EVIDENCE_BY_RECORDS) {
    const chunk = verdictRecords.slice(i, i + MAX_EVIDENCE_BY_RECORDS);
    const res = await getEvidenceByRecords(
      chunk.map((v) => ({ recordType: v.recordType, recordId: v.recordId })),
      { limitPerRecord: EVIDENCE_PER_RECORD },
    );
    if (!res.ok) {
      return {
        exitCode: 1,
        output: `Failed to batch-fetch evidence: ${res.message ?? 'unknown error'}`,
      };
    }
    Object.assign(allEvidence, res.data.evidenceByKey);
  }

  const rows: AuditRow[] = [];
  for (const v of verdictRecords) {
    const evidenceRows = allEvidence[evidenceRecordKey(v.recordType, v.recordId)];
    if (!evidenceRows) continue;
    for (const e of evidenceRows) {
      if (!e.sourceUrl) continue;
      const sourceUrl = e.sourceUrl;
      const cls = classifyByUrl(sourceUrl);
      const flagged = cls.purpose === 'homepage' && cls.confidence >= FLAG_THRESHOLD;
      rows.push({
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
      const id = truncate(r.recordId, 24, { ellipsis: '..' });
      const field = r.fieldName ? `.${r.fieldName}` : '';
      const url = truncate(r.sourceUrl, 60, { ellipsis: '...' });
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
