/**
 * Sourcing Resolve Contradicted — QUA-728
 *
 * Sweep tool for the existing `contradicted` sourcing verdicts. The QUA-650
 * retro-scan reasoning indicated many of these are subject-identity mismatches
 * (the source is about a different entity than the record's). This command
 * classifies each contradicted verdict by comparing the existing source URL's
 * Wikidata QID against the record's entity QID, then optionally queues
 * URL-replacement suggestions for the subject-mismatch bucket.
 *
 * Buckets:
 *   subject-mismatch    Existing URL has a Wikidata QID that differs from
 *                       the entity QID → URL is wrong, eligible for repair.
 *   subject-match       Existing URL has a QID that matches the entity QID →
 *                       URL is about the right entity; the contradiction is
 *                       likely a data-value error, leave for manual triage.
 *   indeterminate       URL has no extractable QID OR the entity has no
 *                       recorded Wikidata QID → cannot decide deterministically.
 *   no-source-url       No evidence row carries a sourceUrl.
 *
 * Two-step workflow:
 *   1. `crux sourcing-resolve-contradicted --apply` — classifies + writes URL
 *      suggestions (status='pending') for the `subject-mismatch` bucket. The
 *      QUA-724 subject-identity gate pre-filters candidate URLs at suggest time
 *      so the new URLs are guaranteed to point at the right entity.
 *   2. Operator/auto-approver runs `crux sourcing-apply-suggestions` to swap
 *      the source URL and re-verify the verdict. That command updates the
 *      verdict (contradicted → confirmed/partial/etc.) and is what actually
 *      drops the system contradicted count.
 *
 * Defaults to dry-run (preview). Pass `--apply` to write suggestions.
 */

import type {
  CommandOptions as BaseOptions,
  CommandResult,
} from '../lib/command-types.ts';
import {
  listVerdicts,
  getEvidenceByRecords,
  evidenceRecordKey,
  MAX_EVIDENCE_BY_RECORDS,
  upsertUrlSuggestions,
  type VerdictListEntry,
} from '../lib/wiki-server/sourcing-client.ts';
import { extractQid } from '../lib/sourcing/wikidata-matcher.ts';
import { getEntityWikidataQid } from '../lib/sourcing/entity-wikidata-qid.ts';
import { suggestUrls, GENERATOR_MODEL } from '../lib/sourcing/suggest-urls.ts';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const DEFAULT_BUDGET_USD = 1.0;
const DEFAULT_MAX_CANDIDATES = 3;
const MAX_CANDIDATES_PER_RECORD = 10;
const PAGE_SIZE = 200;
const UPSERT_CHUNK = 100;
const DEFAULT_CONCURRENCY = 5;
// Mirrors the server-side input caps in
// apps/wiki-server/src/routes/sourcing/url-suggestions.ts SuggestionInput.
const MAX_TITLE_CHARS = 500;
const MAX_SNIPPET_CHARS = 2000;

// ── Types ─────────────────────────────────────────────────────────────

/** One of four classification buckets. */
export type ContradictedBucket =
  | 'subject-mismatch'
  | 'subject-match'
  | 'indeterminate'
  | 'no-source-url';

export interface ClassifiedRecord {
  verdict: VerdictListEntry;
  /** Latest evidence sourceUrl, or null when no evidence carries one. */
  existingUrl: string | null;
  /** Wikidata QID extracted from `existingUrl` (or null). */
  urlQid: string | null;
  /** Wikidata QID for `verdict.entityId` (or null). */
  entityQid: string | null;
  bucket: ContradictedBucket;
  /** Set after `--apply` if suggestUrls produced ≥1 candidate. */
  candidatesFound?: number;
}

interface ResolveOptions extends BaseOptions {
  limit?: string;
  type?: string;
  entity?: string;
  budget?: string;
  'max-candidates'?: string;
  maxCandidates?: string;
  apply?: boolean;
  json?: boolean;
  ci?: boolean;
}

interface RunSummary {
  scanned: number;
  bySource: Record<ContradictedBucket, number>;
  /** Records where suggestUrls produced ≥1 candidate (subject-mismatch only). */
  replaceableUrlFound: number;
  /** Records where suggestUrls returned 0 candidates after the gate. */
  noReplacement: number;
  /** Total candidate URLs upserted (across replaceableUrlFound records). */
  suggestionsWritten: number;
  costUsd: number;
  budgetExhausted: boolean;
  providerErrors: number;
  /** Records that hit suggestUrls but the gate dropped some candidates. */
  subjectMismatchesDropped: number;
}

function makeSummary(): RunSummary {
  return {
    scanned: 0,
    bySource: {
      'subject-mismatch': 0,
      'subject-match': 0,
      indeterminate: 0,
      'no-source-url': 0,
    },
    replaceableUrlFound: 0,
    noReplacement: 0,
    suggestionsWritten: 0,
    costUsd: 0,
    budgetExhausted: false,
    providerErrors: 0,
    subjectMismatchesDropped: 0,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function parseBoundedInt(
  raw: unknown,
  fallback: number,
  max: number,
  flag: string,
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`warning: ignoring --${flag}=${raw} (expected positive integer)\n`);
    return fallback;
  }
  return Math.min(n, max);
}

function parsePositiveFloat(raw: unknown, fallback: number, flag: string): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`warning: ignoring --${flag}=${raw} (expected positive number)\n`);
    return fallback;
  }
  return n;
}

function clampForUpsert(
  value: string | null | undefined,
  max: number,
): string | null | undefined {
  if (value == null) return value;
  return value.length <= max ? value : value.slice(0, max);
}

/** Minimal concurrency pool — same pattern as sourcing-suggest-urls. */
async function runWithConcurrency<T>(
  concurrency: number,
  tasks: Array<() => Promise<T>>,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ── Verdict pagination ────────────────────────────────────────────────

async function fetchAllContradictedVerdicts(opts: {
  recordType?: string;
  entity?: string;
  limit: number;
}): Promise<{ rows: VerdictListEntry[]; serverTotal: number }> {
  const collected: VerdictListEntry[] = [];
  let serverTotal = 0;
  let offset = 0;
  while (collected.length < opts.limit) {
    const pageSize = Math.min(PAGE_SIZE, opts.limit - collected.length);
    const response = await listVerdicts({
      verdict: 'contradicted',
      recordType: opts.recordType,
      limit: pageSize,
      offset,
    });
    if (!response.ok) {
      throw new Error(`listVerdicts failed: ${response.message ?? 'unknown error'}`);
    }
    serverTotal = response.data.total;
    const rows = response.data.verdicts;
    if (rows.length === 0) break;
    collected.push(...rows);
    offset += rows.length;
    if (offset >= serverTotal) break;
  }
  // Optional client-side entity filter — same shape as sourcing-suggest-urls.
  // The server's listVerdicts route doesn't accept an entity filter, so we
  // page everything and trim here. Acceptable for our scale (<1k rows).
  if (opts.entity) {
    const want = opts.entity;
    return {
      rows: collected.filter(
        (v) =>
          v.entityId === want ||
          (v.entityDisplayName ?? '').toLowerCase() === want.toLowerCase(),
      ),
      serverTotal,
    };
  }
  return { rows: collected, serverTotal };
}

// ── Entity-slug resolution ────────────────────────────────────────────

/**
 * Resolve the entity slug for a verdict. Falls back through:
 *   1. `verdict.entityId` if non-null (preferred — written by recent
 *      verdict-write paths).
 *   2. Citation recordIds of the form `page:<slug>:<fn>` — wiki page slugs
 *      are entity slugs in this codebase (`data/entities/<slug>.yaml`
 *      pairs with `content/docs/.../<slug>.mdx`), so we can parse the slug
 *      out of the recordId for free.
 *
 * Returns null when neither path yields a slug. The caller treats null as
 * "indeterminate" — we can't know the entity QID without a slug.
 *
 * NOTE: We do NOT fall back to fetching the underlying record (e.g.
 * personnel → org slug) here. That would require per-record-type API
 * calls and join logic; the data-quality fix is to backfill
 * `source_check_verdicts.entity_id` server-side rather than have every
 * client resolve it. See QUA-728's PR description for the dry-run finding
 * that 100% of contradicted verdicts currently have `entityId=null`.
 */
export function resolveEntitySlug(verdict: VerdictListEntry): string | null {
  if (verdict.entityId) return verdict.entityId;
  if (verdict.recordType === 'citation') {
    // page:<slug>:<fn>  e.g.  page:nist-ai-rmf:fn8
    const match = verdict.recordId.match(/^page:([^:]+):/);
    if (match) return match[1];
  }
  return null;
}

// ── Classification ────────────────────────────────────────────────────

/**
 * Classify one verdict by comparing its existing source URL's QID to the
 * entity's QID. Pure function so tests can exercise the matrix without
 * setting up the full command.
 */
export function classifyContradicted(input: {
  verdict: VerdictListEntry;
  existingUrl: string | null;
  entityQid: string | null;
}): ClassifiedRecord {
  const { verdict, existingUrl, entityQid } = input;
  if (!existingUrl) {
    return {
      verdict,
      existingUrl,
      urlQid: null,
      entityQid,
      bucket: 'no-source-url',
    };
  }
  const urlQid = extractQid(existingUrl);
  if (!urlQid || !entityQid) {
    return {
      verdict,
      existingUrl,
      urlQid,
      entityQid,
      bucket: 'indeterminate',
    };
  }
  if (urlQid === entityQid) {
    return {
      verdict,
      existingUrl,
      urlQid,
      entityQid,
      bucket: 'subject-match',
    };
  }
  return {
    verdict,
    existingUrl,
    urlQid,
    entityQid,
    bucket: 'subject-mismatch',
  };
}

// ── Output formatting ─────────────────────────────────────────────────

function summaryToJson(s: RunSummary, dryRun: boolean) {
  return {
    scanned: s.scanned,
    by_bucket: { ...s.bySource },
    replaceable_url_found: s.replaceableUrlFound,
    no_replacement: s.noReplacement,
    suggestions_written: s.suggestionsWritten,
    subject_mismatches_dropped: s.subjectMismatchesDropped,
    cost_usd: Number(s.costUsd.toFixed(4)),
    budget_exhausted: s.budgetExhausted,
    provider_errors: s.providerErrors,
    dry_run: dryRun,
  };
}

function formatSummary(s: RunSummary, dryRun: boolean): string {
  const writtenLine = dryRun
    ? '(dry-run; no writes)'
    : `${s.suggestionsWritten} suggestion(s) written across ${s.replaceableUrlFound} record(s)`;
  return `
=== Summary ===
Scanned:                ${s.scanned}
  subject-mismatch:     ${s.bySource['subject-mismatch']} (URL is about wrong entity → repair)
  subject-match:        ${s.bySource['subject-match']} (URL OK → likely value-mismatch, manual triage)
  indeterminate:        ${s.bySource.indeterminate} (no QID on URL or entity)
  no-source-url:        ${s.bySource['no-source-url']}
Replaceable URL found:  ${s.replaceableUrlFound}
No replacement:         ${s.noReplacement}
URL suggestions:        ${writtenLine}
Provider gate drops:    ${s.subjectMismatchesDropped}
Provider errors:        ${s.providerErrors}
Cost:                   $${s.costUsd.toFixed(4)}
Budget exhausted:       ${s.budgetExhausted ? 'yes' : 'no'}
`.trim();
}

// ── Main command ──────────────────────────────────────────────────────

async function resolveContradictedCommand(
  _args: string[],
  options: ResolveOptions,
): Promise<CommandResult> {
  const limit = parseBoundedInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT, 'limit');
  const budgetCap = parsePositiveFloat(options.budget, DEFAULT_BUDGET_USD, 'budget');
  const maxCandidates = parseBoundedInt(
    options['max-candidates'] ?? options.maxCandidates,
    DEFAULT_MAX_CANDIDATES,
    MAX_CANDIDATES_PER_RECORD,
    'max-candidates',
  );
  const recordTypeFilter = options.type?.trim() || undefined;
  const entityFilter = options.entity?.trim() || undefined;
  const apply = Boolean(options.apply);
  const isJson = Boolean(options.json || options.ci);

  const log = (msg: string) => { if (!isJson) console.log(msg); };

  log('Sourcing Resolve Contradicted (QUA-728)');
  log(`  limit:          ${limit}`);
  if (recordTypeFilter) log(`  record type:    ${recordTypeFilter}`);
  if (entityFilter) log(`  entity:         ${entityFilter}`);
  log(`  apply:          ${apply ? 'yes (writes URL suggestions)' : 'no (dry-run)'}`);
  if (apply) {
    log(`  budget:         $${budgetCap.toFixed(2)}`);
    log(`  max-candidates: ${maxCandidates}`);
  }
  log('');

  const summary = makeSummary();

  // ── Step 1: fetch all contradicted verdicts ───────────────────────
  let pageResult: { rows: VerdictListEntry[]; serverTotal: number };
  try {
    pageResult = await fetchAllContradictedVerdicts({
      recordType: recordTypeFilter,
      entity: entityFilter,
      limit,
    });
  } catch (e: unknown) {
    return {
      exitCode: 1,
      output: `Failed to fetch contradicted verdicts: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const verdicts = pageResult.rows;
  log(`Fetched ${verdicts.length} contradicted verdict(s)${pageResult.serverTotal > verdicts.length ? ` (${pageResult.serverTotal} total on server)` : ''}.`);

  if (verdicts.length === 0) {
    const output = isJson
      ? JSON.stringify({ summary: summaryToJson(summary, !apply), records: [] })
      : `No contradicted verdicts matched.`;
    return { exitCode: 0, output };
  }

  // ── Step 2: batch-fetch evidence to learn each record's existing URL ──
  const existingUrlByKey = new Map<string, string | null>();
  for (let i = 0; i < verdicts.length; i += MAX_EVIDENCE_BY_RECORDS) {
    const chunk = verdicts.slice(i, i + MAX_EVIDENCE_BY_RECORDS);
    const evidenceRes = await getEvidenceByRecords(
      chunk.map((v) => ({ recordType: v.recordType, recordId: v.recordId })),
      { limitPerRecord: 5 },
    );
    if (!evidenceRes.ok) {
      return {
        exitCode: 1,
        output: `Failed to batch-fetch evidence: ${evidenceRes.message ?? 'unknown error'}`,
      };
    }
    for (const [key, rows] of Object.entries(evidenceRes.data.evidenceByKey)) {
      // Pick the latest evidence row that carries a sourceUrl. Server returns
      // rows ordered by `checked_at DESC` so `rows[0]` is the latest. We don't
      // skip deterministic checkers here (unlike retro-scan-subjects) because
      // a deterministic checker confirming a `contradicted` outcome already
      // means the URL is OK and the value is wrong — i.e. the row will land
      // in `subject-match` if the URL has a Wikidata QID, which is the
      // correct disposition.
      existingUrlByKey.set(key, rows.find((r) => r.sourceUrl)?.sourceUrl ?? null);
    }
  }

  // ── Step 3: classify each verdict ────────────────────────────────
  const classified: ClassifiedRecord[] = verdicts.map((v) => {
    const existingUrl = existingUrlByKey.get(evidenceRecordKey(v.recordType, v.recordId)) ?? null;
    const entitySlug = resolveEntitySlug(v);
    const entityQid = getEntityWikidataQid(entitySlug);
    return classifyContradicted({ verdict: v, existingUrl, entityQid });
  });
  for (const c of classified) {
    summary.scanned++;
    summary.bySource[c.bucket]++;
  }

  // ── Step 4: in --apply mode, suggest URL replacements for subject-mismatch ──
  type UpsertInput = Parameters<typeof upsertUrlSuggestions>[0][number];
  const toUpsert: UpsertInput[] = [];
  if (apply) {
    const eligible = classified.filter((c) => c.bucket === 'subject-mismatch');
    log(`Generating URL suggestions for ${eligible.length} subject-mismatch record(s)…`);

    const tasks = eligible.map((c) => async () => {
      // Shared budget gate.
      if (summary.costUsd >= budgetCap) {
        if (!summary.budgetExhausted) {
          summary.budgetExhausted = true;
          log(`Budget reached ($${summary.costUsd.toFixed(4)} >= $${budgetCap.toFixed(2)}); skipping remaining records.`);
        }
        return;
      }
      const v = c.verdict;
      const claimText = v.reasoning?.trim() || v.displayName?.trim() || '';
      // Prefer the verdict's display name; fall back to the resolved entity
      // slug. The slug isn't a perfect search query but beats nothing.
      const resolvedSlug = resolveEntitySlug(v);
      const entityName =
        v.entityDisplayName?.trim() || resolvedSlug || v.displayName?.trim() || '';
      if (!claimText || !entityName) {
        // Treat as no-replacement; subject-mismatch with no usable text.
        c.candidatesFound = 0;
        return;
      }

      const result = await suggestUrls({
        entityName,
        claimText,
        fieldName: v.fieldName ?? undefined,
        existingUrl: c.existingUrl,
        maxCandidates,
        // Pass the entity QID so the gate pre-filters candidate URLs that
        // don't point at this entity. Without this we'd risk replacing one
        // wrong URL with another wrong URL.
        entityWikidataQid: c.entityQid,
      });

      summary.costUsd += result.costUsd;
      for (const p of result.providersSkipped) {
        if (!p.endsWith(':no-key')) summary.providerErrors++;
      }
      if (result.subjectMismatches.length > 0) {
        summary.subjectMismatchesDropped += result.subjectMismatches.length;
      }
      c.candidatesFound = result.candidates.length;

      for (const cand of result.candidates) {
        toUpsert.push({
          recordType: v.recordType,
          recordId: v.recordId,
          fieldName: v.fieldName,
          entityId: v.entityId,
          suggestedUrl: cand.url,
          title: clampForUpsert(cand.title, MAX_TITLE_CHARS),
          snippet: clampForUpsert(cand.snippet, MAX_SNIPPET_CHARS),
          relevanceScore: cand.relevanceScore,
          sourceProvider: cand.sourceProvider,
          generatorModel: GENERATOR_MODEL,
          // Keep contradicted suggestions at 'pending' — humans should approve
          // before swap+recheck. Conservative posture for high-stakes records.
          status: 'pending',
        });
      }
    });
    await runWithConcurrency(DEFAULT_CONCURRENCY, tasks);

    // Tally replaceable vs no-replacement after suggestions ran.
    for (const c of classified) {
      if (c.bucket !== 'subject-mismatch') continue;
      if ((c.candidatesFound ?? 0) > 0) summary.replaceableUrlFound++;
      else summary.noReplacement++;
    }

    // Upsert in chunks (server caps at 200; chunk at 100 for headroom).
    if (toUpsert.length > 0) {
      for (let i = 0; i < toUpsert.length; i += UPSERT_CHUNK) {
        const chunk = toUpsert.slice(i, i + UPSERT_CHUNK);
        const upsert = await upsertUrlSuggestions(chunk);
        if (!upsert.ok) {
          return {
            exitCode: 1,
            output: `upsert failed at chunk ${i / UPSERT_CHUNK + 1}: ${upsert.message ?? 'unknown error'}`,
          };
        }
        summary.suggestionsWritten += upsert.data.upserted;
      }
    }
  } else {
    // Dry-run: nothing to do, but the summary needs replaceable/no-replacement
    // tallies derived purely from classification (without suggestUrls).
    // In dry-run we cannot know how many candidates suggestUrls would return,
    // so report subject-mismatch count under "potentially replaceable" without
    // splitting it. The replaceable_url_found and no_replacement counters stay
    // at 0 in the JSON to make this distinction explicit.
  }

  // ── Step 5: emit the report ────────────────────────────────────────
  const records = classified.map((c) => ({
    record_type: c.verdict.recordType,
    record_id: c.verdict.recordId,
    entity_id: c.verdict.entityId,
    entity_display_name: c.verdict.entityDisplayName,
    field_name: c.verdict.fieldName,
    existing_url: c.existingUrl,
    url_qid: c.urlQid,
    entity_qid: c.entityQid,
    bucket: c.bucket,
    candidates_found: c.candidatesFound ?? null,
  }));

  // Per-record table for the human path. Limit to the most actionable bucket
  // first so operators don't have to scroll past "subject-match" rows.
  if (!isJson) {
    const buckets: ContradictedBucket[] = [
      'subject-mismatch',
      'indeterminate',
      'subject-match',
      'no-source-url',
    ];
    for (const bucket of buckets) {
      const rows = classified.filter((c) => c.bucket === bucket);
      if (rows.length === 0) continue;
      log('');
      log(`── ${bucket} (${rows.length}) ──`);
      for (const c of rows) {
        const v = c.verdict;
        const name = v.displayName ?? v.entityDisplayName ?? v.recordId;
        const qids = c.urlQid && c.entityQid
          ? `URL=${c.urlQid} entity=${c.entityQid}`
          : c.urlQid
            ? `URL=${c.urlQid} entity=?`
            : c.entityQid
              ? `URL=? entity=${c.entityQid}`
              : 'no QIDs';
        const cands = c.candidatesFound != null ? ` candidates=${c.candidatesFound}` : '';
        log(`  ${v.recordType}/${v.recordId}  ${qids}${cands}`);
        log(`    name:    ${String(name).slice(0, 80)}`);
        if (c.existingUrl) log(`    url:     ${c.existingUrl.slice(0, 100)}`);
      }
    }
  }

  const output = isJson
    ? JSON.stringify({ summary: summaryToJson(summary, !apply), records })
    : formatSummary(summary, !apply);
  return { exitCode: 0, output };
}

// ── Exports ───────────────────────────────────────────────────────────

export const commands = {
  default: resolveContradictedCommand,
};

export function getHelp(): string {
  return `
Sourcing Resolve Contradicted — sweep + classify + queue URL replacements
                                  for contradicted sourcing verdicts (QUA-728).

Usage:
  crux sourcing-resolve-contradicted [options]

Options:
  --limit=N            Max verdicts to scan (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})
  --type=X             Filter by record type (e.g., fact, grant, personnel)
  --entity=X           Filter by entityId or entityDisplayName
  --apply              Write URL suggestions for the subject-mismatch bucket.
                       Without this flag the command runs as a dry-run that only
                       classifies and reports.
  --budget=N           USD cap on suggestUrls provider spend (default: $${DEFAULT_BUDGET_USD.toFixed(2)}).
  --max-candidates=N   Candidates per record (default: ${DEFAULT_MAX_CANDIDATES}, max: ${MAX_CANDIDATES_PER_RECORD})
  --json / --ci        Machine-readable JSON output

Buckets:
  subject-mismatch   URL has a Wikidata QID that differs from the entity QID →
                     URL is wrong, eligible for repair via URL replacement.
  subject-match      URL QID matches the entity QID → URL is about the right
                     entity, contradiction is likely a data-value error
                     (manual triage).
  indeterminate      URL has no extractable QID OR the entity has no recorded
                     Wikidata QID — cannot decide deterministically.
  no-source-url      No evidence row carries a sourceUrl.

Workflow:
  1. crux sourcing-resolve-contradicted                     # dry-run preview
  2. crux sourcing-resolve-contradicted --apply             # writes URL suggestions
  3. (operator) review suggestions in /internal/url-suggestions
  4. crux sourcing-apply-suggestions --status=approved      # swap + recheck

Step 4 is what actually re-verifies and drops the system contradicted count.
This command only classifies + queues; it never mutates verdicts directly.

Requires WIKI_SERVER_ENV=prod in agent slots.
`.trim();
}
