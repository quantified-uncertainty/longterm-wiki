/**
 * Source-Check Retro-Scan: Subject-Identity Mismatch (QUA-650)
 *
 * Re-examines every existing `confirmed` verdict in `source_check_verdicts`
 * through a lightweight LLM check that only asks: "does the source's primary
 * subject match the claim's subject?" Any row flagged as a mismatch is
 * downgraded to `partial` and marked `needsRecheck=true`, queuing it for a
 * full re-verification via `crux sourcing-recheck`.
 *
 * Follow-up to QUA-648, which fixed the prompt/response shape so future
 * sourcing checks can't false-confirm on subject-identity mismatches (e.g.
 * "Microsoft CEO" sourced from a "Microsoft AI" Wikidata page). Existing
 * confirmed rows were written before that fix — this command catches them.
 *
 * Usage:
 *   crux sourcing-retro-scan-subjects --dry-run        Preview what would be checked
 *   crux sourcing-retro-scan-subjects --limit=50       Sample 50 rows (with LLM)
 *   crux sourcing-retro-scan-subjects --apply          Actually persist downgrades
 *   crux sourcing-retro-scan-subjects --apply --budget=35 --record-type=personnel
 *
 * Writes a JSONL report to the path given by `--report=` (default:
 * `/tmp/qua650-retro-scan-<timestamp>.jsonl`) so batch runs can be audited
 * and resumed post-hoc.
 */

import { writeFileSync, createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { z } from 'zod';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import {
  listVerdicts,
  storeVerdict,
  getEvidenceByRecords,
  evidenceRecordKey,
  MAX_EVIDENCE_BY_RECORDS,
  type VerdictListEntry,
} from '../lib/wiki-server/sourcing-client.ts';
import { createLlmClient, callLlm, MODELS } from '../lib/llm.ts';
import { parseJsonResponse } from '../lib/anthropic.ts';
import {
  fetchSourceContent,
  storeSourcingEvidence,
} from '../lib/sourcing/index.ts';
import { escapeXml } from '../lib/prompt-utils.ts';
import {
  clampSourcingConcurrency,
  DEFAULT_SOURCING_CONCURRENCY,
} from '../lib/sourcing/concurrency.ts';
import type { SourcingVerdict, RecordType } from '../../apps/wiki-server/src/api-types.ts';

// ── Constants ────────────────────────────────────────────────────────

const LOG_PREFIX = '[retro-scan-subjects]';

/** Checker-model strings that are deterministic (QID / OpenAlex / dead-link / ...).
 *  Deterministic matches cannot have the subject-identity defect — their "match"
 *  is an exact ID compare, not an LLM judgement — so we skip them to save cost
 *  and avoid false-flag downgrades. */
const DETERMINISTIC_CHECKER_MODELS = new Set([
  'wikidata-api',
  'deterministic-row-match',
  'dead-link-detector',
  'relevance-gate',
  'openalex-matcher',
]);

/** Mirrors `isSid()` from `@longterm-wiki/id-utils` without the package dep.
 *  A stableId is `sid_` + exactly 10 alphanumeric chars. We use this to skip
 *  rows whose resolved "claim subject" is a raw stableId — the LLM can't
 *  judge subject-identity against an opaque id (it would always say "no match")
 *  and those rows are affected by a different bug (display-name cache leak,
 *  QUA-407). */
const SID_RE = /^sid_[A-Za-z0-9]{10}$/;

/** Haiku is cheap but the response shape is small; 200 tokens is plenty. */
const MAX_RESPONSE_TOKENS = 250;

/** Keep the source-content slice small — subject-identity is usually decidable
 *  from the first few paragraphs, and this keeps cost close to the ticket's
 *  $0.005/call estimate. Operators can tune via `--max-content`. */
const DEFAULT_MAX_CONTENT_CHARS = 10_000;

/** Rough Haiku cost at 10K-char content + 200-token response. Used for budget
 *  caps and dry-run estimates — not a precise meter. */
const ESTIMATED_COST_PER_CHECK = 0.003;

/** Slice previous-verdict reasoning before interpolating into the prompt —
 *  the full reasoning can be thousands of characters, and the LLM only needs
 *  enough to orient itself. */
const MAX_PREVIOUS_REASONING_CHARS = 600;

/** Cap each label in the mismatch prefix — keeps the reasoning column within
 *  the server's 5000-char limit and keeps the prefix machine-parseable. */
const MAX_PREFIX_LABEL_CHARS = 120;

/** `source_check_verdicts.reasoning` is varchar(5000); leave headroom for the
 *  prefix bracket we prepend. */
const MAX_REASONING_CHARS = 4900;

// ── Types ────────────────────────────────────────────────────────────

interface RetroScanOptions extends BaseOptions {
  limit?: string;
  offset?: string;
  budget?: string;
  'record-type'?: string;
  recordType?: string;
  concurrency?: string;
  'max-content'?: string;
  maxContent?: string;
  report?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  'scan-only'?: boolean;
  scanOnly?: boolean;
  ci?: boolean;
}

/** LLM response schema for the subject-identity check. Deliberately narrow —
 *  we are NOT re-verifying the claim value, only whether the source's subject
 *  is the same entity as the claim's subject. */
export const SubjectCheckSchema = z.object({
  source_subject: z.string().default(''),
  subjects_match: z.boolean(),
  confidence: z.number().min(0).max(1).default(0.5),
  reasoning: z.string().default(''),
});

export type SubjectCheckResult = z.infer<typeof SubjectCheckSchema>;

interface ScanRowOutcome {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  sourceUrl: string | null;
  /** One of: 'mismatch' | 'match' | 'skip:<reason>' | 'error:<code>' */
  status: string;
  sourceSubject?: string;
  claimSubject?: string;
  confidence?: number;
  reasoning?: string;
  applied?: boolean;
  errorMessage?: string;
}

interface ScanSummary {
  totalConsidered: number;
  scanned: number;
  mismatches: number;
  matches: number;
  skipped: number;
  /** Source-content cache misses (not_cached, fetch_error). Reported
   *  separately from real errors because they're a known-operational state —
   *  the resource-ingest pipeline processes these asynchronously and a later
   *  retro-scan pass will pick them up. Does NOT fail the exit code. */
  fetchMisses: number;
  /** Real errors: LLM failures, downgrade-write failures. Fails exit code. */
  errors: number;
  downgraded: number;
  downgradeErrors: number;
  budgetExhausted: boolean;
  estimatedCost: number;
}

// ── Prompt construction ──────────────────────────────────────────────

/**
 * Build a compact subject-identity prompt. Only asks whether the source's
 * primary subject matches the claim's — NOT whether the claimed value is
 * correct. The prompt mirrors the language of the shared
 * `prompt-guidelines.ts::Subject-identity mismatch` rule so the LLM's
 * judgement is consistent with the forward-going sourcing pipeline (QUA-648).
 *
 * All user-controlled fields (entity names, reasoning text, source content)
 * are wrapped in XML tags and escaped with `escapeXml` to prevent prompt
 * injection. See docs/agent-rules/llm-prompt-safety.md.
 */
export function buildSubjectIdentityPrompt(params: {
  claimSubjectLabel: string;
  recordType: string;
  fieldName: string | null;
  recordLabel: string;
  sourceUrl: string;
  sourceContent: string;
  previousReasoning: string | null;
  maxContentChars: number;
}): string {
  const content = params.sourceContent.slice(0, params.maxContentChars);
  const previousReasoning = params.previousReasoning?.slice(0, MAX_PREVIOUS_REASONING_CHARS) ?? '';

  return `You are checking whether a web source is actually about the same entity that a claim is about.

You are NOT being asked to verify the claim value itself. Only answer:
is the source's primary subject the same entity as the claim's subject?

Per the standing sourcing guideline (QUA-648):
- Subsidiaries, parent companies, products, namesakes, and similarly-named-but-different organizations all count as MISMATCHES.
- Name overlap alone is not enough (e.g. "OpenAI" confirming something about "OpenAI Japan" is a MISMATCH).
- When in doubt, prefer MISMATCH.

<claim>
<subject>${escapeXml(params.claimSubjectLabel)}</subject>
<record_type>${escapeXml(params.recordType)}</record_type>
<record_label>${escapeXml(params.recordLabel)}</record_label>
${params.fieldName ? `<field_name>${escapeXml(params.fieldName)}</field_name>\n` : ''}</claim>

<source_url>${escapeXml(params.sourceUrl)}</source_url>

<previous_verification_reasoning>
${escapeXml(previousReasoning) || '(none recorded)'}
</previous_verification_reasoning>

<source_content>
${escapeXml(content)}
</source_content>

Respond with ONLY a JSON object (no markdown fences):
{
  "source_subject": "Name the primary entity/subject this source is actually about (be specific — e.g. 'Microsoft AI', not just 'Microsoft'). If the source is unreadable or off-topic, say so.",
  "subjects_match": true | false,
  "confidence": 0.0 to 1.0,
  "reasoning": "One or two sentences explaining your decision."
}`;
}

// ── LLM call + parsing ───────────────────────────────────────────────

/**
 * Run the subject-identity LLM call. Returns the parsed result or an error.
 * The caller is responsible for fetch + storage; this function is pure
 * LLM-in / verdict-judgement-out.
 */
export async function callSubjectIdentityCheck(
  client: ReturnType<typeof createLlmClient>,
  prompt: string,
  retryLabel: string,
): Promise<{ ok: true; data: SubjectCheckResult } | { ok: false; error: string }> {
  let raw: unknown;
  try {
    const result = await callLlm(client, prompt, {
      model: MODELS.haiku,
      maxTokens: MAX_RESPONSE_TOKENS,
      temperature: 0,
      retryLabel,
    });
    raw = parseJsonResponse(result.text);
  } catch (e: unknown) {
    return { ok: false, error: `LLM call failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const parsed = SubjectCheckSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `LLM response failed validation: ${parsed.error.message}` };
  }
  return { ok: true, data: parsed.data };
}

// ── Evidence pre-filter ──────────────────────────────────────────────

/**
 * For a batch of verdicts, fetch the most recent evidence row per record and
 * decide whether the row should be skipped (deterministic checker) or scanned.
 *
 * Returns a map keyed by `recordKey(rt, rid)` with either `{ skip: 'deterministic' }`
 * or `{ sourceUrl }`. Records with no evidence at all end up absent from the
 * map and are treated as "skip: no-source" by the caller.
 */
export async function classifyEvidence(
  verdicts: VerdictListEntry[],
): Promise<Map<string, { skip: 'deterministic' } | { sourceUrl: string }>> {
  const out = new Map<string, { skip: 'deterministic' } | { sourceUrl: string }>();
  if (verdicts.length === 0) return out;

  // Chunk the lookup to respect the server's MAX_EVIDENCE_BY_RECORDS cap.
  // Without this, any scan of >1000 rows fails with 400 validation error
  // from the /evidence/by-records endpoint.
  const allEvidence: Record<string, Array<{ sourceUrl: string | null; checkerModel: string | null }>> = {};
  for (let i = 0; i < verdicts.length; i += MAX_EVIDENCE_BY_RECORDS) {
    const chunk = verdicts.slice(i, i + MAX_EVIDENCE_BY_RECORDS);
    const response = await getEvidenceByRecords(
      chunk.map((v) => ({ recordType: v.recordType, recordId: v.recordId })),
      { limitPerRecord: 5 },
    );
    if (!response.ok) {
      throw new Error(`Batch evidence fetch failed: ${response.message ?? 'unknown error'}`);
    }
    Object.assign(allEvidence, response.data.evidenceByKey);
  }

  for (const [key, rows] of Object.entries(allEvidence)) {
    // Classify by the *latest* evidence row that has a sourceUrl. If that
    // row is from a deterministic checker (exact-ID match), the verdict is
    // immune to the subject-identity defect — skip. Previously we picked
    // the latest *non-deterministic* row, which let stale LLM evidence
    // downgrade verdicts that were since re-confirmed by a deterministic
    // checker. (CodeRabbit review on PR #4539.)
    const withUrl = rows.filter((r) => r.sourceUrl);
    if (withUrl.length === 0) continue;

    const latestWithUrl = withUrl[0];
    if (
      latestWithUrl.checkerModel &&
      DETERMINISTIC_CHECKER_MODELS.has(latestWithUrl.checkerModel)
    ) {
      out.set(key, { skip: 'deterministic' });
      continue;
    }
    const sourceUrl = latestWithUrl.sourceUrl;
    if (sourceUrl) out.set(key, { sourceUrl });
  }
  return out;
}

// ── Persisting a downgrade ───────────────────────────────────────────

/**
 * Apply the `confirmed → partial` + `needsRecheck=true` downgrade for a single
 * verdict, and write an audit evidence row documenting the retro-scan finding.
 *
 * Preserves entityId / displayName / entityDisplayName / sourcesChecked from
 * the prior verdict so the row doesn't lose its context. The new reasoning is
 * prefixed with `[retro-scan QUA-650: subject-mismatch — ...]` so future
 * operators can trace the downgrade without re-reading the JSONL report.
 */
export async function applyDowngrade(
  verdict: VerdictListEntry,
  check: SubjectCheckResult,
  claimSubjectLabel: string,
  sourceUrl: string,
): Promise<void> {
  const originalReasoning = verdict.reasoning ?? '';
  // Collapse whitespace and cap both labels before interpolating into the
  // reasoning prefix — without this a newline or "quote in the LLM's
  // `source_subject` would break any regex that later tries to extract the
  // retro-scan marker from the reasoning field.
  const sanitize = (s: string) => s.replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, MAX_PREFIX_LABEL_CHARS);
  const sourceSubject = sanitize(check.source_subject.trim() || '(unnamed)');
  const claimSubject = sanitize(claimSubjectLabel);
  const mismatchPrefix = `[retro-scan QUA-650: subject-mismatch — source is about "${sourceSubject}", claim is about "${claimSubject}"]`;
  const newReasoning = `${mismatchPrefix} ${originalReasoning}`.slice(0, MAX_REASONING_CHARS);

  const body: Record<string, unknown> = {
    recordType: verdict.recordType,
    recordId: verdict.recordId,
    verdict: 'partial',
    confidence: check.confidence,
    reasoning: newReasoning,
    sourcesChecked: verdict.sourcesChecked,
    needsRecheck: true,
  };
  if (verdict.fieldName != null) body.fieldName = verdict.fieldName;
  if (verdict.entityId != null) body.entityId = verdict.entityId;
  if (verdict.displayName != null) body.displayName = verdict.displayName;
  if (verdict.entityDisplayName != null) body.entityDisplayName = verdict.entityDisplayName;

  const response = await storeVerdict(body);
  if (!response.ok) {
    throw new Error(
      `Failed to persist downgrade for ${verdict.recordType}/${verdict.recordId}: ${response.error}`,
    );
  }

  // Write a best-effort audit evidence row. Don't fail the downgrade if the
  // evidence write fails — the verdict change is the important part.
  try {
    await storeSourcingEvidence(
      {
        recordType: verdict.recordType as RecordType | 'fact',
        recordId: verdict.recordId,
        sourceUrl,
        verdict: 'partial' as SourcingVerdict,
        confidence: check.confidence,
        extractedValue: `Source subject: ${sourceSubject}`,
        reasoning: `QUA-650 retro-scan: ${check.reasoning}`.slice(0, MAX_REASONING_CHARS),
        entityId: verdict.entityId,
        checkerModel: 'qua650-retro-scan-subject-identity',
        fieldName: verdict.fieldName,
      },
      LOG_PREFIX,
    );
  } catch (e: unknown) {
    console.warn(
      `${LOG_PREFIX} Evidence write failed for ${verdict.recordType}/${verdict.recordId}: ${e instanceof Error ? e.message : String(e)} (verdict downgrade persisted)`,
    );
  }
}

// ── Per-row processing ───────────────────────────────────────────────

/**
 * Run the full scan on one verdict row:
 *   - resolve sourceUrl via pre-fetched map
 *   - fetch source content
 *   - build + run the subject-identity prompt
 *   - if `apply` and mismatch, persist the downgrade
 *
 * Always returns an outcome — never throws, so the caller's concurrency pool
 * can continue. Errors are captured in `outcome.status` / `outcome.errorMessage`.
 */
async function processVerdictRow(params: {
  verdict: VerdictListEntry;
  classification: { skip: 'deterministic' } | { sourceUrl: string } | undefined;
  client: ReturnType<typeof createLlmClient>;
  maxContentChars: number;
  apply: boolean;
}): Promise<ScanRowOutcome> {
  const { verdict, classification, client, maxContentChars, apply } = params;
  const base: ScanRowOutcome = {
    recordType: verdict.recordType,
    recordId: verdict.recordId,
    fieldName: verdict.fieldName,
    entityId: verdict.entityId,
    sourceUrl: null,
    status: '',
  };

  if (!classification) {
    return { ...base, status: 'skip:no-source-url' };
  }
  if ('skip' in classification) {
    return { ...base, status: `skip:${classification.skip}` };
  }

  const sourceUrl = classification.sourceUrl;
  base.sourceUrl = sourceUrl;

  const claimSubjectLabel =
    verdict.entityDisplayName ??
    verdict.displayName ??
    verdict.entityId ??
    `${verdict.recordType}/${verdict.recordId}`;

  // Safety guard: if the only "subject" we have is a raw stableId (sid_...),
  // we cannot meaningfully ask the LLM "does the source subject match X?" —
  // the LLM will always say "no, X is an opaque id". That would falsely
  // downgrade verdicts whose only defect is a stale `*_display_name` cache
  // (tracked by validate-sid-display / QUA-407). Skip such rows BEFORE
  // fetching the source so we don't burn cache lookups either.
  if (SID_RE.test(claimSubjectLabel)) {
    return { ...base, status: 'skip:sid-display-name' };
  }

  const fetchResult = await fetchSourceContent(sourceUrl);
  if (!fetchResult.content) {
    return {
      ...base,
      status: `error:fetch:${fetchResult.errorType ?? 'unknown'}`,
      errorMessage: fetchResult.errorMessage ?? 'Source content not cached',
    };
  }

  const prompt = buildSubjectIdentityPrompt({
    claimSubjectLabel,
    recordType: verdict.recordType,
    fieldName: verdict.fieldName,
    recordLabel: verdict.displayName ?? verdict.recordId,
    sourceUrl,
    sourceContent: fetchResult.content,
    previousReasoning: verdict.reasoning,
    maxContentChars,
  });

  const checkResult = await callSubjectIdentityCheck(
    client,
    prompt,
    `retro-scan-${verdict.recordType}-${verdict.recordId}`,
  );
  if (!checkResult.ok) {
    return { ...base, status: 'error:llm', errorMessage: checkResult.error };
  }

  const check = checkResult.data;
  const outcome: ScanRowOutcome = {
    ...base,
    status: check.subjects_match ? 'match' : 'mismatch',
    sourceSubject: check.source_subject,
    claimSubject: claimSubjectLabel,
    confidence: check.confidence,
    reasoning: check.reasoning,
  };

  if (!check.subjects_match && apply) {
    try {
      await applyDowngrade(verdict, check, claimSubjectLabel, sourceUrl);
      outcome.applied = true;
    } catch (e: unknown) {
      outcome.status = 'error:downgrade';
      outcome.errorMessage = e instanceof Error ? e.message : String(e);
    }
  }

  return outcome;
}

// ── Pagination ───────────────────────────────────────────────────────

const PAGE_SIZE = 200;
const MAX_PAGES = 200; // Hard cap — (MAX_PAGES × PAGE_SIZE = 40,000 rows). If we
                       // hit this, the server is returning bad pagination metadata.

interface FetchOptions {
  recordType?: string;
  limit: number;
  offset: number;
}

async function fetchConfirmedVerdicts(opts: FetchOptions): Promise<{
  rows: VerdictListEntry[];
  total: number;
}> {
  const collected: VerdictListEntry[] = [];
  let serverTotal = 0;
  let cursor = opts.offset;
  let iterations = 0;
  while (collected.length < opts.limit) {
    if (iterations++ >= MAX_PAGES) {
      throw new Error(`Pagination exceeded ${MAX_PAGES} pages — server may be returning malformed pagination metadata.`);
    }
    const pageSize = Math.min(PAGE_SIZE, opts.limit - collected.length);
    const response = await listVerdicts({
      verdict: 'confirmed',
      recordType: opts.recordType,
      limit: pageSize,
      offset: cursor,
    });
    if (!response.ok) {
      throw new Error(`listVerdicts failed: ${response.message}`);
    }
    serverTotal = response.data.total;
    const rows = response.data.verdicts;
    if (rows.length === 0) break;
    collected.push(...rows);
    cursor += rows.length;
    if (cursor >= serverTotal) break;
  }
  return { rows: collected, total: serverTotal };
}

// ── Main command ─────────────────────────────────────────────────────

async function retroScanCommand(
  args: string[],
  options: RetroScanOptions,
): Promise<CommandResult> {
  const scanOnly = options['scan-only'] === true || options.scanOnly === true;
  const dryRun = options['dry-run'] === true || options.dryRun === true;

  // --dry-run is documented as preview-only; reject combinations that would
  // otherwise silently bypass it (e.g., `--dry-run --apply` would have
  // persisted writes). CodeRabbit review on PR #4539.
  if (dryRun && (scanOnly || options.apply === true)) {
    return {
      exitCode: 1,
      output: 'Invalid mode: --dry-run cannot be combined with --scan-only or --apply.',
    };
  }

  const apply = options.apply === true && !scanOnly && !dryRun;
  // Four modes (mutually exclusive):
  //   default (no flags):     fast preview; no LLM, no writes.
  //   --dry-run:               same as default — explicit preview.
  //   --scan-only:             full LLM scan; no writes (pilot mode).
  //   --apply:                 full LLM scan + persists downgrades.
  const isPreview = dryRun || (!apply && !scanOnly);
  const itemLimit = options.limit ? parseInt(String(options.limit), 10) : 50;
  const offset = options.offset ? parseInt(String(options.offset), 10) : 0;
  const budgetLimit = options.budget ? parseFloat(String(options.budget)) : 35.0;
  const recordTypeFilter = (options['record-type'] ?? options.recordType) as string | undefined;
  const maxContentChars = options['max-content'] || options.maxContent
    ? parseInt(String(options['max-content'] ?? options.maxContent), 10)
    : DEFAULT_MAX_CONTENT_CHARS;
  const concurrency = clampSourcingConcurrency(options.concurrency ?? DEFAULT_SOURCING_CONCURRENCY);
  const reportPath =
    (options.report as string | undefined) ??
    `/tmp/qua650-retro-scan-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;

  if (!Number.isFinite(itemLimit) || itemLimit < 1) {
    return { exitCode: 1, output: 'Invalid --limit: must be a positive integer.' };
  }
  if (!Number.isFinite(offset) || offset < 0) {
    return { exitCode: 1, output: 'Invalid --offset: must be a non-negative integer.' };
  }
  if (!Number.isFinite(budgetLimit) || budgetLimit <= 0) {
    return { exitCode: 1, output: 'Invalid --budget: must be a positive number.' };
  }
  if (!Number.isFinite(maxContentChars) || maxContentChars < 500) {
    return { exitCode: 1, output: 'Invalid --max-content: must be an integer >= 500.' };
  }

  // Budget cap — apply after itemLimit
  const maxByBudget = Math.floor(budgetLimit / ESTIMATED_COST_PER_CHECK);
  const effectiveLimit = Math.min(itemLimit, maxByBudget);

  const modeLabel = apply
    ? '\x1b[31mAPPLY (will write)\x1b[0m'
    : scanOnly
    ? 'scan-only (LLM, no writes)'
    : 'preview (no LLM, no writes)';
  console.log('\x1b[1mSource-Check Retro-Scan: Subject-Identity (QUA-650)\x1b[0m');
  console.log(`  Mode:        ${modeLabel}`);
  console.log(`  Limit:       ${effectiveLimit}${maxByBudget < itemLimit ? ` (capped by --budget=$${budgetLimit})` : ''}`);
  console.log(`  Offset:      ${offset}`);
  console.log(`  Budget:      $${budgetLimit.toFixed(2)}`);
  console.log(`  Concurrency: ${concurrency}`);
  console.log(`  Content cap: ${maxContentChars} chars/row`);
  if (recordTypeFilter) console.log(`  Type filter: ${recordTypeFilter}`);
  console.log('');

  // Step 1: fetch confirmed verdicts
  let fetched: { rows: VerdictListEntry[]; total: number };
  try {
    fetched = await fetchConfirmedVerdicts({
      recordType: recordTypeFilter,
      limit: effectiveLimit,
      offset,
    });
  } catch (e: unknown) {
    return { exitCode: 1, output: `${LOG_PREFIX} ${e instanceof Error ? e.message : String(e)}` };
  }
  const { rows: verdicts, total: totalMatching } = fetched;

  if (verdicts.length === 0) {
    return { exitCode: 0, output: 'No confirmed verdicts found for the given filters.' };
  }

  const estimatedCost = verdicts.length * ESTIMATED_COST_PER_CHECK;
  console.log(`Fetched ${verdicts.length} rows of ${totalMatching} confirmed (est. $${estimatedCost.toFixed(2)}).`);

  // Step 2: classify evidence up-front (skip deterministic checkers)
  let classifications: Map<string, { skip: 'deterministic' } | { sourceUrl: string }>;
  try {
    classifications = await classifyEvidence(verdicts);
  } catch (e: unknown) {
    return { exitCode: 1, output: `${LOG_PREFIX} ${e instanceof Error ? e.message : String(e)}` };
  }

  // Step 3: preview summary, or run the scan (scan-only or apply)
  if (isPreview) {
    return formatDryRunOutput(verdicts, classifications, totalMatching, estimatedCost, options);
  }

  // Prepare report file
  writeFileSync(
    reportPath,
    JSON.stringify({
      kind: 'qua650-retro-scan-header',
      startedAt: new Date().toISOString(),
      apply,
      totalMatching,
      fetched: verdicts.length,
      offset,
      recordTypeFilter: recordTypeFilter ?? null,
      maxContentChars,
      concurrency,
    }) + '\n',
  );

  const client = createLlmClient();
  const summary: ScanSummary = {
    totalConsidered: totalMatching,
    scanned: 0,
    mismatches: 0,
    matches: 0,
    skipped: 0,
    fetchMisses: 0,
    errors: 0,
    downgraded: 0,
    downgradeErrors: 0,
    budgetExhausted: false,
    estimatedCost: 0,
  };

  // The JSONL report is the source of truth; keep only small display buffers
  // in-memory so a 9,578-row scan doesn't accumulate ~5MB of outcome objects.
  const sampleOutcomes: ScanRowOutcome[] = []; // first 20, for --ci output
  const mismatchPreview: ScanRowOutcome[] = []; // first 10 mismatches, for stdout summary
  const SAMPLE_CAP = 20;
  const MISMATCH_PREVIEW_CAP = 10;

  // Append outcomes via a WriteStream. Node's WriteStream serializes writes
  // through its internal queue (FIFO on a single fd), so we don't need a
  // promise chain to guard against interleaving — just call `.write()` and
  // `.end(callback)` flushes pending writes before the callback fires.
  const reportStream: WriteStream = createWriteStream(reportPath, { flags: 'a' });
  const appendLine = (obj: unknown): void => {
    reportStream.write(JSON.stringify(obj) + '\n');
  };

  const processOne = async (v: VerdictListEntry): Promise<void> => {
    const key = evidenceRecordKey(v.recordType, v.recordId);
    const classification = classifications.get(key);

    const outcome = await processVerdictRow({
      verdict: v,
      classification,
      client,
      maxContentChars,
      apply,
    });

    appendLine(outcome);
    if (sampleOutcomes.length < SAMPLE_CAP) sampleOutcomes.push(outcome);
    if (outcome.status === 'mismatch' && mismatchPreview.length < MISMATCH_PREVIEW_CAP) {
      mismatchPreview.push(outcome);
    }

    if (outcome.status.startsWith('skip:')) {
      summary.skipped++;
    } else if (outcome.status === 'match') {
      summary.matches++;
      summary.scanned++;
      summary.estimatedCost += ESTIMATED_COST_PER_CHECK;
    } else if (outcome.status === 'mismatch') {
      summary.mismatches++;
      summary.scanned++;
      summary.estimatedCost += ESTIMATED_COST_PER_CHECK;
      if (outcome.applied) summary.downgraded++;
    } else if (outcome.status === 'error:downgrade') {
      summary.downgradeErrors++;
      summary.scanned++;
      summary.estimatedCost += ESTIMATED_COST_PER_CHECK;
    } else if (outcome.status.startsWith('error:fetch')) {
      // Cache miss is operational state, not a scan failure. Doesn't count
      // toward errors (exit code) and doesn't incur LLM cost.
      summary.fetchMisses++;
    } else {
      summary.errors++;
      if (outcome.status.startsWith('error:llm')) summary.estimatedCost += ESTIMATED_COST_PER_CHECK;
    }
  };

  console.log('');
  console.log(`\x1b[1mScanning ${verdicts.length} rows (concurrency=${concurrency})...\x1b[0m`);

  // Concurrency-limited pool (pattern borrowed from sourcing-orchestrate). The
  // serial case (concurrency=1) is just a pool of size 1, so one loop covers
  // both.
  //
  // NOTE: `budgetLimit` is a *soft* cap. The check runs before each dispatch,
  // so up to `concurrency` in-flight LLM calls can push cost past the limit
  // before the loop exits (the pre-dispatch check sees pre-increment cost,
  // and each inflight call adds its ESTIMATED_COST_PER_CHECK after resolving).
  // With concurrency=5 that's ~$0.015 overshoot worst-case at the
  // $0.003/check estimate — acceptable given we already over-estimate per call.
  const executing = new Set<Promise<void>>();
  for (const v of verdicts) {
    if (summary.estimatedCost >= budgetLimit) {
      summary.budgetExhausted = true;
      break;
    }
    const p = processOne(v).finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);

  // Trailer — `stream.end(callback)` flushes all pending writes before firing.
  appendLine({ kind: 'qua650-retro-scan-trailer', finishedAt: new Date().toISOString(), summary });
  await new Promise<void>((resolve) => reportStream.end(resolve));

  const exitCode = summary.errors > 0 || summary.downgradeErrors > 0 ? 1 : 0;

  if (options.ci) {
    return { exitCode, output: JSON.stringify({ summary, reportPath, sampleOutcomes }) };
  }
  return { exitCode, output: formatSummaryOutput(summary, reportPath, mismatchPreview) };
}

// ── Output formatting ────────────────────────────────────────────────

function formatDryRunOutput(
  verdicts: VerdictListEntry[],
  classifications: Map<string, { skip: 'deterministic' } | { sourceUrl: string }>,
  totalMatching: number,
  estimatedCost: number,
  options: RetroScanOptions,
): CommandResult {
  let withUrl = 0;
  let deterministic = 0;
  let noSource = 0;
  const typeCounts = new Map<string, number>();
  for (const v of verdicts) {
    typeCounts.set(v.recordType, (typeCounts.get(v.recordType) ?? 0) + 1);
    const c = classifications.get(evidenceRecordKey(v.recordType, v.recordId));
    if (!c) noSource++;
    else if ('skip' in c) deterministic++;
    else withUrl++;
  }

  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        totalMatching,
        fetched: verdicts.length,
        wouldCheck: withUrl,
        wouldSkipDeterministic: deterministic,
        wouldSkipNoSource: noSource,
        estimatedCostAtFullFetch: estimatedCost,
        byType: Object.fromEntries(typeCounts),
      }),
    };
  }

  const lines: string[] = [];
  lines.push(`\x1b[1mDry-run preview: ${verdicts.length} of ${totalMatching} confirmed verdicts\x1b[0m`);
  lines.push(`  Would check (LLM):       ${withUrl}`);
  lines.push(`  Would skip (deterministic): ${deterministic}`);
  lines.push(`  Would skip (no source URL): ${noSource}`);
  lines.push(`  Estimated cost (at ${verdicts.length} LLM calls): $${estimatedCost.toFixed(2)}`);
  lines.push('');
  lines.push('\x1b[1mBy record type:\x1b[0m');
  for (const [type, cnt] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${type.padEnd(22)} ${cnt}`);
  }
  lines.push('');
  lines.push('Re-run with --apply to persist downgrades. Use --limit / --offset / --budget to bound the run.');
  return { exitCode: 0, output: lines.join('\n') };
}

function formatSummaryOutput(
  summary: ScanSummary,
  reportPath: string,
  mismatchPreview: ScanRowOutcome[],
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('\x1b[1m=== Retro-Scan Summary ===\x1b[0m');
  lines.push(`Total confirmed matching: ${summary.totalConsidered}`);
  lines.push(`Scanned (LLM calls):      ${summary.scanned}`);
  lines.push(`Skipped:                  ${summary.skipped}`);
  lines.push(`Fetch cache misses:       ${summary.fetchMisses} (will re-run after ingest)`);
  lines.push(`  Matches:                ${summary.matches}`);
  lines.push(`  \x1b[33mMismatches:             ${summary.mismatches}\x1b[0m`);
  lines.push(`  Downgraded:             ${summary.downgraded}`);
  lines.push(`  Downgrade errors:       ${summary.downgradeErrors}`);
  lines.push(`Errors:                   ${summary.errors}`);
  lines.push(`Est. cost:                $${summary.estimatedCost.toFixed(2)}`);
  if (summary.budgetExhausted) {
    lines.push(`\x1b[33mBudget cap reached — re-run with --offset=N to resume.\x1b[0m`);
  }
  lines.push(`Report:                   ${reportPath}`);

  if (mismatchPreview.length > 0) {
    lines.push('');
    lines.push('\x1b[1mFirst mismatches:\x1b[0m');
    for (const o of mismatchPreview) {
      lines.push(`  \x1b[33m${o.recordType}/${o.recordId}\x1b[0m`);
      lines.push(`    claim:  "${o.claimSubject}"`);
      lines.push(`    source: "${o.sourceSubject}"`);
      if (o.reasoning) lines.push(`    reason: ${o.reasoning.slice(0, 160)}`);
    }
  }

  return lines.join('\n');
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: retroScanCommand,
};

export function getHelp(): string {
  return `
Source-Check Retro-Scan: Subject-Identity (QUA-650)

Re-examine existing 'confirmed' source_check_verdicts for subject-identity
mismatches and downgrade them to 'partial' + queue for full re-verification.
Follow-up to QUA-648.

Usage:
  crux sourcing-retro-scan-subjects [options]

Options:
  --limit=N             Max verdicts to process (default: 50)
  --offset=N            Skip the first N matching rows (for resume) (default: 0)
  --record-type=X       Only scan a specific record type (e.g. personnel, fact, grant)
  --budget=N            Max USD to spend (default: 35.00, ~$0.003/row)
  --concurrency=N       Parallel LLM calls (default: ${DEFAULT_SOURCING_CONCURRENCY}, max: 8)
  --max-content=N       Source content truncation (default: ${DEFAULT_MAX_CONTENT_CHARS} chars)
  --report=PATH         JSONL report path (default: /tmp/qua650-retro-scan-<ts>.jsonl)
  --dry-run             Preview selection without running the LLM (default; alias for the preview mode)
  --scan-only           Run the full LLM scan but do NOT persist downgrades (pilot mode)
  --apply               Run the full LLM scan AND persist downgrades (required to write)
  --ci                  JSON summary output for CI pipelines

A row is "skipped" when:
  - its most recent evidence is from a deterministic checker model (wikidata-api,
    deterministic-row-match, openalex-matcher, ...) — those are immune to the
    subject-identity defect by construction.
  - there is no evidence row with a sourceUrl — we can't check without a source.

A row is "downgraded" (with --apply) when the LLM reports subjects_match=false.
The downgrade writes verdict='partial', needsRecheck=true, prefixes the
reasoning with '[retro-scan QUA-650: subject-mismatch — ...]', and writes an
audit evidence row with checkerModel='qua650-retro-scan-subject-identity'.

Queue for full re-verification (after mismatches are flagged):
  crux sourcing-recheck --verdict=partial --limit=N --budget=X
`.trim();
}
