/**
 * Flagship Curate — Unattended per-org curation runner.
 *
 * Automates the manual curation loop that takes an org's personnel tab from
 * partial verification to high coverage. The process for each entity:
 *
 *   1. Query unverified/partial/unchecked records
 *   2. Research better source URLs for records missing good sources
 *   3. Register new URLs via POST /api/resources/suggest and wait for ingest
 *   4. Reset stale verdicts to unchecked
 *   5. Run sourcing verification for the entity
 *   6. Report results
 *
 * Usage:
 *   crux flagship-curate --entity=anthropic              Curate one org
 *   crux flagship-curate --entity=anthropic --dry-run    Preview what would happen
 *   crux flagship-curate --all --budget=10               Batch mode: all orgs
 *   crux flagship-curate --all --limit=5 --budget=5      Top 5 worst orgs
 *
 * Linear: QUA-220
 */

import { z } from 'zod';
import type { CommandResult } from '../lib/command-types.ts';
import { CostTracker } from '../lib/cost-tracker.ts';
import { createLlmClient, callLlm, MODELS } from '../lib/llm.ts';
import { CreditExhaustedError, isCreditExhaustedError } from '../lib/resilience.ts';
import { withPipelineRun } from '../lib/pipeline-runs/lifecycle.ts';
import { parseAndValidateArray } from '../lib/json-parsing.ts';
import { getEntity, searchEntities } from '../lib/wiki-server/entities.ts';
import { getPersonnelByEntity, syncPersonnel } from '../lib/wiki-server/personnel.ts';
import { getVerdictsByEntity, type ByEntityResponse } from '../lib/wiki-server/sourcing.ts';
import { storeVerdict } from '../lib/wiki-server/sourcing-client.ts';
import { suggestResources } from '../lib/search/suggest-resources.ts';
import { escapeXml } from '../lib/prompt-utils.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { commentOnIssue } from '../lib/linear/issues.ts';
import { parseLinearId } from '../lib/linear/parse-id.ts';

// ── Constants ──────────────────────────────────────────────────────────

const LOG_PREFIX = '[flagship-curate]';
const DEFAULT_BUDGET = 5;
const DEFAULT_LIMIT = 10; // max orgs in --all mode
const DEFAULT_RECORD_LIMIT = 50; // max records per entity
const INGEST_POLL_INTERVAL_MS = 5_000;
const INGEST_TIMEOUT_MS = 120_000; // 2 minutes per batch
const ESTIMATED_RESEARCH_COST_PER_RECORD = 0.01; // ~$0.01 Haiku call for URL research
const ESTIMATED_VERIFY_COST_PER_RECORD = 0.005; // ~$0.005 Haiku call for verification

/** Verdict states that indicate a record needs curation. */
const NEEDS_CURATION_VERDICTS = new Set([
  'unchecked',
  'unverifiable',
  'partial',
  'outdated',
  'contradicted',
]);

/**
 * Schema for a single URL-research result item. The outer response is an
 * array; `parseAndValidateArray` validates each item individually so a
 * single malformed entry doesn't drop the entire batch.
 */
const ResearchUrlItemSchema = z.object({
  index: z.number().int().nonnegative(),
  urls: z.array(z.string()),
  reasoning: z.string().optional().default(''),
}).passthrough();

// ── Types ──────────────────────────────────────────────────────────────

interface CurateOptions {
  entity?: string;
  all?: boolean;
  budget?: string | number;
  limit?: string | number;
  'record-limit'?: string | number;
  recordLimit?: string | number;
  table?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  ci?: boolean;
  /** Number of max curation iterations per entity (default: 2) */
  iterations?: string | number;
  /** Skip the source research phase (just re-verify with existing sources) */
  'skip-research'?: boolean;
  skipResearch?: boolean;
  /** Linear issue identifier to post a run summary to (e.g. "QUA-124") */
  'linear-comment'?: string;
  linearComment?: string;
}

interface RunMeta {
  budget: number;
  totalCost: number;
  mode: 'batch' | 'single';
  limit: number;
  dryRun: boolean;
  startedAt: Date;
}

interface ResolvedEntity {
  id: string;
  stableId: string;
  title: string;
  entityType: string;
}

interface RecordNeedingCuration {
  recordType: string;
  recordId: string;
  displayName: string;
  verdict: string;
  entityId: string;
  source?: string;
}

interface CurationResult {
  entity: ResolvedEntity;
  recordsTotal: number;
  recordsCurated: number;
  recordsImproved: number;
  recordsSkipped: number;
  researchCost: number;
  verifyCost: number;
  totalCost: number;
  duration: number;
  beforeVerdicts: Record<string, number>;
  afterVerdicts: Record<string, number>;
}

// ── ANSI helpers ───────────────────────────────────────────────────────

const c = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};

// ── Entity Resolution ──────────────────────────────────────────────────

async function resolveEntity(identifier: string): Promise<ResolvedEntity | null> {
  const result = await getEntity(identifier);
  if (!result.ok) {
    return null;
  }
  const e = result.data;
  return {
    id: (e as Record<string, unknown>).id as string,
    stableId: ((e as Record<string, unknown>).stableId ?? (e as Record<string, unknown>).stable_id ?? (e as Record<string, unknown>).id) as string,
    title: ((e as Record<string, unknown>).title ?? (e as Record<string, unknown>).name ?? identifier) as string,
    entityType: ((e as Record<string, unknown>).entityType ?? (e as Record<string, unknown>).entity_type ?? 'unknown') as string,
  };
}

/**
 * Find organizations with the worst sourcing coverage.
 * Returns entities sorted by number of non-confirmed verdicts (worst first).
 *
 * QUA-452: distinguishes "server unreachable" from "no entities found".
 * Prior behavior silently returned `[]` on wiki-server error, which the
 * caller reported as "No entities found needing curation." — a classic
 * silent-success bug (same shape as QUA-352, QUA-396). Now returns a
 * discriminated result so the caller fails loudly when the server is
 * unavailable.
 */
type FindEntitiesResult =
  | { ok: true; entities: ResolvedEntity[] }
  | { ok: false; error: string };

async function findEntitiesNeedingCuration(limit: number): Promise<FindEntitiesResult> {
  // Fetch organizations with verdict summary
  // typed-client-ok: QUA-770 baseline — CLI command, follow-up migration to typed client tracked
  const result = await apiRequest<{
    entities: Array<{
      id: string;
      stableId?: string;
      stable_id?: string;
      title?: string;
      name?: string;
      entityType?: string;
      entity_type?: string;
    }>;
    total: number;
  }>('GET', `/api/entities?entityType=organization&limit=200`);

  if (!result.ok) {
    // Preserve both error code and human-readable message for CI logs.
    return { ok: false, error: `${result.error}: ${result.message}` };
  }

  // For each entity, check how many non-confirmed verdicts exist.
  //
  // QUA-460: track consecutive sourcing-endpoint failures. A single hiccup
  // is tolerated (the entity is silently skipped and counted toward a
  // threshold), but N consecutive failures abort the whole sweep — same
  // pattern as the groundskeeper health-check tracker
  // (`.claude/rules/error-handling.md`). Without this, a down sourcing
  // endpoint would make every entity report `needsCuration: 0`, producing
  // an empty "nothing to curate" list that the outer command can't
  // distinguish from a legitimate "all clean" state.
  const MAX_CONSECUTIVE_SOURCING_FAILURES = 5;
  const scored: Array<{ entity: ResolvedEntity; needsCuration: number }> = [];
  let consecutiveSourcingFailures = 0;
  let lastSourcingError = '';

  for (const e of result.data.entities) {
    const stableId = (e.stableId ?? e.stable_id ?? e.id) as string;
    const verdicts = await getVerdictsByEntity(stableId, { limit: 200 });
    if (!verdicts.ok) {
      consecutiveSourcingFailures++;
      lastSourcingError = `${verdicts.error}: ${verdicts.message}`;
      if (consecutiveSourcingFailures > MAX_CONSECUTIVE_SOURCING_FAILURES) {
        return {
          ok: false,
          error:
            `Sourcing endpoint (getVerdictsByEntity) failed for ` +
            `${consecutiveSourcingFailures} consecutive entities — aborting ` +
            `instead of reporting "no entities found needing curation" with ` +
            `incomplete data. Last error: ${lastSourcingError}`,
        };
      }
      continue;
    }
    consecutiveSourcingFailures = 0;

    const needsCuration = (verdicts.data.verdicts ?? []).filter(
      (v) => NEEDS_CURATION_VERDICTS.has(v.verdict),
    ).length;

    if (needsCuration > 0) {
      scored.push({
        entity: {
          id: e.id,
          stableId,
          title: (e.title ?? e.name ?? e.id) as string,
          entityType: (e.entityType ?? e.entity_type ?? 'organization') as string,
        },
        needsCuration,
      });
    }
  }

  // Sort: most non-confirmed verdicts first
  scored.sort((a, b) => b.needsCuration - a.needsCuration);
  return { ok: true, entities: scored.slice(0, limit).map((s) => s.entity) };
}

// ── Record Discovery ───────────────────────────────────────────────────

async function discoverRecordsNeedingCuration(
  entity: ResolvedEntity,
  recordLimit: number,
  tableFilter?: string,
): Promise<RecordNeedingCuration[]> {
  const verdicts = await getVerdictsByEntity(entity.stableId, { limit: 500 });
  if (!verdicts.ok) {
    console.warn(`${LOG_PREFIX} Failed to fetch verdicts for ${entity.title}: ${verdicts.error}`);
    return [];
  }

  const records: RecordNeedingCuration[] = [];
  for (const v of verdicts.data.verdicts ?? []) {
    if (!NEEDS_CURATION_VERDICTS.has(v.verdict)) continue;
    if (tableFilter && v.recordType !== tableFilter) continue;

    records.push({
      recordType: v.recordType,
      recordId: v.recordId,
      displayName: v.displayName ?? v.recordId,
      verdict: v.verdict,
      entityId: entity.stableId,
      source: undefined, // Will be populated by personnel lookup
    });
  }

  // Enrich personnel records with current source URLs
  if (!tableFilter || tableFilter === 'personnel') {
    const personnel = await getPersonnelByEntity(entity.stableId, { limit: 500 });
    if (personnel.ok) {
      const sourceMap = new Map<string, string>();
      for (const p of personnel.data.personnel ?? []) {
        if (p.source) {
          sourceMap.set(p.id, p.source);
        }
      }
      for (const record of records) {
        if (record.recordType === 'personnel' && sourceMap.has(record.recordId)) {
          record.source = sourceMap.get(record.recordId);
        }
      }
    }
  }

  // verdict-priority-ok: curation order (unchecked first, needs review most),
  // intentionally distinct from canonical severity rollup.
  const priority: Record<string, number> = {
    unchecked: 0,
    unverifiable: 1,
    partial: 2,
    outdated: 3,
    contradicted: 4,
  };
  records.sort((a, b) => (priority[a.verdict] ?? 5) - (priority[b.verdict] ?? 5));

  return records.slice(0, recordLimit);
}

// ── Source Research ─────────────────────────────────────────────────────

interface ResearchedSource {
  recordId: string;
  urls: string[];
  reasoning: string;
}

/**
 * Use Haiku to research better source URLs for a batch of records.
 * Groups records by entity to amortize context.
 */
async function researchSourcesForRecords(
  entity: ResolvedEntity,
  records: RecordNeedingCuration[],
  tracker: CostTracker,
  budgetRemaining: number,
): Promise<ResearchedSource[]> {
  const client = createLlmClient();
  const results: ResearchedSource[] = [];

  // Build a batch prompt: describe all records and ask for URLs
  const recordDescriptions = records
    .map((r, i) => `  <record index="${i}" id="${escapeXml(r.recordId).replace(/"/g, "&quot;")}" type="${escapeXml(r.recordType).replace(/"/g, "&quot;")}">
    <name>${escapeXml(r.displayName)}</name>
    <current_verdict>${escapeXml(r.verdict)}</current_verdict>
    <current_source>${escapeXml(r.source ?? 'none')}</current_source>
  </record>`)
    .join('\n');

  const prompt = `You are a research assistant finding authoritative source URLs for structured data about ${escapeXml(entity.title)}.

For each record below, suggest 1-2 URLs that would verify the information. Prefer:
- Official company/organization websites (e.g., about pages, team pages, press releases)
- LinkedIn profiles (for personnel)
- Crunchbase profiles (for funding data)
- News articles from reputable outlets
- SEC filings, government databases

Do NOT suggest URLs you are uncertain about. Only suggest URLs you are confident exist.

<entity>
  <name>${escapeXml(entity.title)}</name>
  <type>${escapeXml(entity.entityType)}</type>
</entity>

<records>
${recordDescriptions}
</records>

Respond with ONLY a JSON array. Each element must have:
- "index": the record index (number)
- "urls": array of 1-2 URL strings
- "reasoning": brief explanation of why these URLs would help

Example:
[
  {"index": 0, "urls": ["https://www.example.com/team"], "reasoning": "Official team page lists current personnel"}
]

If you cannot find a good URL for a record, omit it from the array.`;

  // Estimate cost and check budget
  const estimatedCost = records.length * ESTIMATED_RESEARCH_COST_PER_RECORD;
  if (estimatedCost > budgetRemaining) {
    console.log(`  ${c.yellow}Skipping research: estimated cost $${estimatedCost.toFixed(3)} exceeds remaining budget $${budgetRemaining.toFixed(3)}${c.reset}`);
    return [];
  }

  try {
    const result = await callLlm(client, prompt, {
      model: MODELS.haiku,
      maxTokens: 2000,
      temperature: 0,
      tracker,
      label: 'flagship-curate-research',
    });

    const items = parseAndValidateArray(result.text, ResearchUrlItemSchema, 'flagship-curate-research');
    if (items.length === 0) {
      console.warn(`${LOG_PREFIX} Failed to parse research response`);
      return [];
    }

    for (const item of items) {
      const record = records[item.index];
      if (!record) continue;

      // Filter to only valid-looking URLs
      const validUrls = item.urls.filter(
        (u) => typeof u === 'string' && u.startsWith('https://'),
      );

      if (validUrls.length > 0) {
        results.push({
          recordId: record.recordId,
          urls: validUrls,
          reasoning: item.reasoning ?? '',
        });
      }
    }
  } catch (e: unknown) {
    // Credit exhaustion must propagate so the batch loop can abort — any
    // other error is a per-batch anomaly that shouldn't kill the rest of
    // Step 2. Check both the typed error (expected) and the raw substring
    // (defense-in-depth, in case a caller upstream forgot to wrap). See
    // QUA-378.
    if (isCreditExhaustedError(e)) {
      throw e instanceof CreditExhaustedError
        ? e
        : new CreditExhaustedError(
            e instanceof Error ? e.message : String(e),
            e,
          );
    }
    console.warn(
      `${LOG_PREFIX} Research failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return results;
}

// ── Source Registration & Ingest ────────────────────────────────────────

interface IngestResult {
  registered: number;
  ingested: number;
  errors: number;
  /**
   * Record IDs that had at least one URL come back with status='ok' from
   * suggestResources — i.e. freshly fetched OR fresh-cache hits (the cached
   * path in suggest-resources.ts coerces to status 'ok' with contentLength
   * null). Only these records are safe to reset in Step 4.
   *
   * Intentionally excluded: 'error' | 'paywall' | 'dead'. Content is missing
   * or unusable for those — resetting would let the verifier re-run against
   * nothing and strand the record at 'unchecked' (the original QUA-382 bug).
   * If paywall-detected records ever become safe to re-verify, revisit.
   */
  successfulRecordIds: Set<string>;
}

/**
 * Register discovered URLs as resources and wait for content ingestion.
 */
async function registerAndIngestSources(
  researched: ResearchedSource[],
  entityId: string,
): Promise<IngestResult> {
  const allUrls = researched.flatMap((r) => r.urls);
  if (allUrls.length === 0) {
    return { registered: 0, ingested: 0, errors: 0, successfulRecordIds: new Set() };
  }

  // Deduplicate
  const uniqueUrls = [...new Set(allUrls)];

  console.log(`  Registering ${uniqueUrls.length} source URLs...`);

  try {
    const result = await suggestResources({
      urls: uniqueUrls,
      entityId,
      concurrency: 5,
    });

    const registered = result.resources.length;
    const ingested = result.fetchedCount + result.cachedCount;
    const errors = result.errorCount;

    // Map URL -> suggest-resources status so we can tell which records got
    // *something* usable back.
    const urlStatus = new Map<string, string>();
    for (const r of result.resources) {
      urlStatus.set(r.url, r.status);
    }

    const successfulRecordIds = new Set<string>();
    for (const r of researched) {
      const anyOk = r.urls.some((u) => urlStatus.get(u) === 'ok');
      if (anyOk) successfulRecordIds.add(r.recordId);
    }

    console.log(
      `  Registered: ${registered} | Ingested: ${ingested} | Cached: ${result.cachedCount} | Errors: ${errors} | Records with new sources: ${successfulRecordIds.size}`,
    );

    return { registered, ingested, errors, successfulRecordIds };
  } catch (e: unknown) {
    console.warn(
      `${LOG_PREFIX} Source registration failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { registered: 0, ingested: 0, errors: uniqueUrls.length, successfulRecordIds: new Set() };
  }
}

// ── Personnel Source Update ────────────────────────────────────────────

/**
 * Update personnel records with newly discovered source URLs.
 * Uses forceSkipSourcing since we're about to verify right after.
 */
async function updatePersonnelSources(
  entity: ResolvedEntity,
  researched: ResearchedSource[],
  records: RecordNeedingCuration[],
): Promise<number> {
  const personnelUpdates: Array<Record<string, unknown>> = [];

  for (const res of researched) {
    const record = records.find((r) => r.recordId === res.recordId);
    if (!record || record.recordType !== 'personnel') continue;
    if (res.urls.length === 0) continue;

    personnelUpdates.push({
      id: record.recordId,
      source: res.urls[0], // Use first URL as primary source
    });
  }

  if (personnelUpdates.length === 0) return 0;

  console.log(`  Updating ${personnelUpdates.length} personnel records with new source URLs...`);

  try {
    const result = await syncPersonnel(personnelUpdates, {
      forceSkipSourcing: true,
      forceSkipSourcingReason: 'flagship-curate: updating source URLs before re-verification',
    });

    if (!result.ok) {
      console.warn(`${LOG_PREFIX} Personnel sync failed: ${result.error}`);
      return 0;
    }

    return personnelUpdates.length;
  } catch (e: unknown) {
    console.warn(
      `${LOG_PREFIX} Personnel update failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 0;
  }
}

// ── Verdict Reset ──────────────────────────────────────────────────────

/**
 * Reset stale verdicts (unverifiable/partial/outdated) to unchecked
 * so the verification pass rechecks them with the new sources.
 *
 * If `allowedRecordIds` is provided, only records whose IDs are in that set
 * will be reset. Pass `null` to allow all records (used in `--skip-research`
 * mode where the user explicitly opted in to re-verify existing sources).
 */
async function resetStaleVerdicts(
  records: RecordNeedingCuration[],
  allowedRecordIds: Set<string> | null,
): Promise<number> {
  let resetCount = 0;
  const resettable = new Set(['unverifiable', 'partial', 'outdated']);

  for (const record of records) {
    if (!resettable.has(record.verdict)) continue;
    if (allowedRecordIds !== null && !allowedRecordIds.has(record.recordId)) continue;

    try {
      // QUA-723: set needsRecheck=true and nextCheckDue=NOW() so the weekly
      // sourcing-recheck cron picks these up if the in-process verify step
      // fails or is cut off by budget/timeout. Without this, reset verdicts
      // become permanent orphans (`getDueForRecheck()` only matches rows
      // with needs_recheck=true OR next_check_due <= NOW()).
      await storeVerdict({
        recordType: record.recordType,
        recordId: record.recordId,
        verdict: 'unchecked',
        confidence: 0,
        // Migration 0213 (QUA-723) matches this exact literal to backfill
        // historical orphans — do not change without a follow-up migration.
        reasoning: 'Reset by flagship-curate before re-verification',
        sourcesChecked: 0,
        needsRecheck: true,
        nextCheckDue: new Date().toISOString(),
        ...(record.entityId ? { entityId: record.entityId } : {}),
      });
      resetCount++;
    } catch (e: unknown) {
      console.warn(
        `${LOG_PREFIX} Verdict reset failed for ${record.recordType}/${record.recordId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return resetCount;
}

// ── Verification Pass ──────────────────────────────────────────────────

/**
 * Run verify-entity for the given entity.
 * Delegates to the existing verify-entity command.
 */
async function runVerification(
  entity: ResolvedEntity,
  budget: number,
  recordLimit: number,
  tableFilter?: string,
): Promise<{ cost: number; results: Record<string, number> }> {
  // Import verify-entity dynamically to avoid circular deps
  const { orchestrateCommand } = await import('./sourcing-orchestrate.ts');

  const options: Record<string, unknown> = {
    entity: entity.stableId,
    type: 'record',
    budget: String(budget),
    limit: String(recordLimit),
    concurrency: 5,
  };
  if (tableFilter) {
    options.table = tableFilter;
  }

  const result = await orchestrateCommand([], options);

  // Orchestrate-sourcing catches per-item LLM errors and writes them into
  // result.output as "ERROR: LLM call failed: ...". If credits have run out,
  // every record fails this way and the batch would otherwise march on. Scan
  // the output for the credit-exhaustion fingerprint and surface it as a
  // typed error so the batch loop can abort. See QUA-378.
  if (isCreditExhaustedError(result.output)) {
    throw new CreditExhaustedError(
      'Anthropic credit balance too low (detected in verification output)',
      null,
    );
  }

  // Parse verdict counts from output (best-effort)
  const verdictCounts: Record<string, number> = {};
  const verdictRegex = /(\w+)\s+(\d+)/g;
  let match;
  while ((match = verdictRegex.exec(result.output)) !== null) {
    const verdict = match[1].toLowerCase();
    if (['confirmed', 'contradicted', 'unverifiable', 'outdated', 'partial', 'unchecked'].includes(verdict)) {
      verdictCounts[verdict] = parseInt(match[2], 10);
    }
  }

  // Extract cost from tracker (approximation based on output)
  const costMatch = result.output.match(/\$(\d+\.\d+)/);
  const cost = costMatch ? parseFloat(costMatch[1]) : 0;

  return { cost, results: verdictCounts };
}

// ── Snapshot Verdicts ──────────────────────────────────────────────────

async function snapshotVerdicts(entity: ResolvedEntity): Promise<Record<string, number>> {
  const verdicts = await getVerdictsByEntity(entity.stableId, { limit: 500 });
  if (!verdicts.ok) return {};

  const counts: Record<string, number> = {};
  for (const v of verdicts.data.verdicts ?? []) {
    counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
  }
  return counts;
}

// ── Single Entity Curation ─────────────────────────────────────────────

async function curateEntity(
  entity: ResolvedEntity,
  options: {
    budget: number;
    recordLimit: number;
    tableFilter?: string;
    dryRun: boolean;
    skipResearch: boolean;
    iterations: number;
    tracker: CostTracker;
  },
): Promise<CurationResult> {
  const startTime = Date.now();
  const { budget, recordLimit, tableFilter, dryRun, skipResearch, iterations, tracker } = options;

  console.log(`\n${c.bold}${c.cyan}=== Curating: ${entity.title} (${entity.entityType}) ===${c.reset}`);
  console.log(`  Budget: $${budget.toFixed(2)} | Record limit: ${recordLimit} | Iterations: ${iterations}`);

  // Snapshot before
  const beforeVerdicts = await snapshotVerdicts(entity);
  console.log(`  Before: ${formatVerdictCounts(beforeVerdicts)}`);

  let totalRecordsCurated = 0;
  let totalRecordsImproved = 0;
  let totalRecordsSkipped = 0;

  for (let iter = 0; iter < iterations; iter++) {
    if (iterations > 1) {
      console.log(`\n  ${c.bold}--- Iteration ${iter + 1}/${iterations} ---${c.reset}`);
    }

    // Check budget
    const budgetRemaining = budget - tracker.totalCost;
    if (budgetRemaining <= 0) {
      console.log(`  ${c.yellow}Budget exhausted ($${tracker.totalCost.toFixed(3)} / $${budget.toFixed(2)})${c.reset}`);
      break;
    }

    // Step 1: Discover records needing curation
    console.log(`\n  ${c.bold}Step 1: Discovering records needing curation...${c.reset}`);
    const records = await discoverRecordsNeedingCuration(entity, recordLimit, tableFilter);

    if (records.length === 0) {
      console.log(`  ${c.green}All records verified — nothing to curate.${c.reset}`);
      break;
    }

    console.log(`  Found ${records.length} records needing curation:`);
    const verdictBreakdown = new Map<string, number>();
    for (const r of records) {
      verdictBreakdown.set(r.verdict, (verdictBreakdown.get(r.verdict) ?? 0) + 1);
    }
    for (const [verdict, count] of verdictBreakdown) {
      console.log(`    ${verdict}: ${count}`);
    }

    if (dryRun) {
      console.log(`\n  ${c.yellow}DRY RUN — would curate:${c.reset}`);
      for (const r of records.slice(0, 20)) {
        console.log(`    [${r.recordType}] ${r.displayName} (${r.verdict})${r.source ? ` — ${r.source}` : ''}`);
      }
      if (records.length > 20) {
        console.log(`    ${c.dim}...and ${records.length - 20} more${c.reset}`);
      }
      totalRecordsSkipped = records.length;
      break;
    }

    // Step 2: Research better sources (unless --skip-research)
    let researched: ResearchedSource[] = [];
    if (!skipResearch) {
      console.log(`\n  ${c.bold}Step 2: Researching better source URLs...${c.reset}`);

      // Process in batches of 10 to stay within prompt limits
      const batchSize = 10;
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        // Recompute remaining budget at each batch — research calls accumulate
        // cost in the tracker, so a stale captured value underestimates what's left.
        const remaining = budget - tracker.totalCost;
        if (remaining <= 0) {
          console.log(`  ${c.yellow}Budget exhausted during research${c.reset}`);
          break;
        }
        const batchResults = await researchSourcesForRecords(
          entity,
          batch,
          tracker,
          remaining,
        );
        researched.push(...batchResults);

        if (tracker.totalCost > budget) {
          console.log(`  ${c.yellow}Budget limit reached during research${c.reset}`);
          break;
        }
      }

      console.log(`  Found new sources for ${researched.length}/${records.length} records`);
    } else {
      console.log(`\n  ${c.bold}Step 2: Skipping research (--skip-research)${c.reset}`);
    }

    // Step 3: Register new sources and wait for ingest
    let ingestResult: IngestResult | null = null;
    if (researched.length > 0) {
      console.log(`\n  ${c.bold}Step 3: Registering and ingesting sources...${c.reset}`);
      ingestResult = await registerAndIngestSources(researched, entity.stableId);

      // Step 3b: Update personnel records with new source URLs
      const updatedCount = await updatePersonnelSources(entity, researched, records);
      if (updatedCount > 0) {
        console.log(`  Updated ${updatedCount} personnel records with new sources`);
      }
    } else {
      console.log(`\n  ${c.bold}Step 3: No new sources to register${c.reset}`);
    }

    // Step 5 budget — computed before Step 4 so we don't reset records we
    // have no budget to re-verify.
    const verifyBudget = Math.min(budget - tracker.totalCost, 2.0); // Cap per-entity verify at $2

    // Step 4: Reset stale verdicts — atomically guarded on Step 3 success and
    // Step 5 budget availability. See QUA-382.
    //
    // Eligibility rules:
    //   * `--skip-research`: reset everything (user opted in to re-verify
    //     existing sources)
    //   * Otherwise: only reset records whose URLs were successfully ingested
    //     by Step 3. If no record got new sources, skip the reset entirely.
    //   * In either case: if Step 5 has no budget, skip the reset — a reset
    //     without re-verification strictly degrades the entity.
    if (verifyBudget <= 0) {
      console.log(`\n  ${c.bold}Step 4: Skipping reset (no verify budget — would strand records at unchecked)${c.reset}`);
    } else if (skipResearch) {
      console.log(`\n  ${c.bold}Step 4: Resetting stale verdicts (--skip-research mode)...${c.reset}`);
      const resetCount = await resetStaleVerdicts(records, null);
      console.log(`  Reset ${resetCount} verdicts to unchecked`);
    } else {
      const allowed = ingestResult?.successfulRecordIds ?? new Set<string>();
      if (allowed.size === 0) {
        console.log(`\n  ${c.bold}Step 4: Skipping reset (no records got new sources from Step 3)${c.reset}`);
      } else {
        console.log(`\n  ${c.bold}Step 4: Resetting stale verdicts for ${allowed.size} records with new sources...${c.reset}`);
        const resetCount = await resetStaleVerdicts(records, allowed);
        console.log(`  Reset ${resetCount} verdicts to unchecked`);
      }
    }

    // Step 5: Run verification
    if (verifyBudget > 0) {
      console.log(`\n  ${c.bold}Step 5: Running sourcing verification ($${verifyBudget.toFixed(2)} budget)...${c.reset}`);
      const verifyResult = await runVerification(entity, verifyBudget, recordLimit, tableFilter);
      console.log(`  Verification complete. Cost: $${verifyResult.cost.toFixed(3)}`);
    } else {
      console.log(`\n  ${c.bold}Step 5: Skipping verification (budget exhausted)${c.reset}`);
    }

    totalRecordsCurated += records.length;

    // Check if we improved vs. the previous iteration. Early-stop if the
    // confirmed count didn't advance — but don't double-count across iterations
    // (totalRecordsImproved is derived from the net before/after delta below).
    const midVerdicts = await snapshotVerdicts(entity);
    const confirmedStart = beforeVerdicts['confirmed'] ?? 0;
    const confirmedNow = midVerdicts['confirmed'] ?? 0;

    if (confirmedNow === confirmedStart && iter > 0) {
      console.log(`  ${c.yellow}No improvement in iteration ${iter + 1} — stopping early${c.reset}`);
      break;
    }
  }

  // Snapshot after
  const afterVerdicts = await snapshotVerdicts(entity);
  // Net improvement from the whole entity run, not a sum of per-iteration
  // deltas measured against the fixed start snapshot (which would overcount).
  totalRecordsImproved = Math.max(
    0,
    (afterVerdicts['confirmed'] ?? 0) - (beforeVerdicts['confirmed'] ?? 0),
  );
  const duration = Date.now() - startTime;

  return {
    entity,
    recordsTotal: (beforeVerdicts['confirmed'] ?? 0) +
      Object.entries(beforeVerdicts)
        .filter(([k]) => NEEDS_CURATION_VERDICTS.has(k))
        .reduce((s, [, v]) => s + v, 0),
    recordsCurated: totalRecordsCurated,
    recordsImproved: totalRecordsImproved,
    recordsSkipped: totalRecordsSkipped,
    researchCost: tracker.breakdown()['flagship-curate-research'] ?? 0,
    verifyCost: tracker.totalCost - (tracker.breakdown()['flagship-curate-research'] ?? 0),
    totalCost: tracker.totalCost,
    duration,
    beforeVerdicts,
    afterVerdicts,
  };
}

// ── Formatting ─────────────────────────────────────────────────────────

function formatVerdictCounts(counts: Record<string, number>): string {
  const parts: string[] = [];
  const order = ['confirmed', 'contradicted', 'outdated', 'partial', 'unverifiable', 'unchecked'];
  for (const verdict of order) {
    const count = counts[verdict];
    if (!count) continue;
    const color = verdict === 'confirmed' ? c.green
      : verdict === 'contradicted' ? c.red
      : c.yellow;
    parts.push(`${color}${verdict}: ${count}${c.reset}`);
  }
  return parts.join(' | ') || 'no verdicts';
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Render a per-org delta label with distinct, color-coded states for
 * improvement / regression / no-change. Previously this was a two-way
 * branch (`improved` OR `no change`), which silently hid regressions
 * where confirmed-record counts dropped during a run. See QUA-379 for
 * the incident evidence (Anthropic 37→33, CEA 96→94, etc.) that led to
 * operators missing multi-percentage-point quality drops.
 */
export function formatConfirmedDelta(confirmedBefore: number, confirmedAfter: number): string {
  const delta = confirmedAfter - confirmedBefore;
  if (delta > 0) return `${c.green}+${delta}${c.reset}`;
  if (delta < 0) return `${c.red}${delta}${c.reset}`;
  return `${c.dim}no change${c.reset}`;
}

export function formatSummary(results: CurationResult[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${c.bold}=== Flagship Curate Summary ===${c.reset}`);
  lines.push('');

  let totalCost = 0;
  let totalRecords = 0;
  // Signed net delta in confirmed records across all entities — distinct
  // from totalRecordsImproved which is clamped to ≥0 per-entity. The Markdown
  // summary has used this signed formulation since day 1; the console
  // summary was lagging behind until QUA-379.
  let totalConfirmedDelta = 0;
  let totalDuration = 0;

  for (const r of results) {
    totalCost += r.totalCost;
    totalRecords += r.recordsCurated;
    totalDuration += r.duration;

    const confirmedBefore = r.beforeVerdicts['confirmed'] ?? 0;
    const confirmedAfter = r.afterVerdicts['confirmed'] ?? 0;
    totalConfirmedDelta += confirmedAfter - confirmedBefore;
    const totalBefore = Object.values(r.beforeVerdicts).reduce((s, v) => s + v, 0);
    const totalAfter = Object.values(r.afterVerdicts).reduce((s, v) => s + v, 0);
    const pctBefore = totalBefore > 0 ? ((confirmedBefore / totalBefore) * 100).toFixed(0) : '0';
    const pctAfter = totalAfter > 0 ? ((confirmedAfter / totalAfter) * 100).toFixed(0) : '0';

    const arrow = formatConfirmedDelta(confirmedBefore, confirmedAfter);

    lines.push(
      `  ${c.bold}${r.entity.title}${c.reset}: ${pctBefore}% → ${pctAfter}% confirmed (${arrow}) — ` +
      `$${r.totalCost.toFixed(3)}, ${formatDuration(r.duration)}`,
    );
  }

  // Color the net-delta total so a red "−2" is as visible as the individual
  // regressions, not lost in a green total that happens to be zero or
  // positive due to other orgs.
  const totalDeltaColor = totalConfirmedDelta > 0
    ? c.green
    : totalConfirmedDelta < 0
      ? c.red
      : c.dim;
  const totalDeltaStr = totalConfirmedDelta > 0
    ? `+${totalConfirmedDelta}`
    : totalConfirmedDelta < 0
      ? `${totalConfirmedDelta}`  // already has minus sign
      : '0';

  lines.push('');
  lines.push(`${c.bold}Totals:${c.reset}`);
  lines.push(`  Entities processed: ${results.length}`);
  lines.push(`  Records curated: ${totalRecords}`);
  lines.push(`  Confirmed delta: ${totalDeltaColor}${totalDeltaStr}${c.reset}`);
  lines.push(`  Total cost: $${totalCost.toFixed(3)}`);
  lines.push(`  Total duration: ${formatDuration(totalDuration)}`);

  return lines.join('\n');
}

/**
 * Markdown summary suitable for posting as a Linear comment or other report
 * surface. Pure function — no ANSI codes, no console writes.
 */
export function formatSummaryMarkdown(
  results: CurationResult[],
  meta: RunMeta,
): string {
  const lines: string[] = [];
  const dryRunTag = meta.dryRun ? ' [DRY RUN]' : '';
  const timestamp = meta.startedAt.toISOString().replace('T', ' ').slice(0, 16);

  lines.push(`## Flagship Curate Run — ${timestamp} UTC${dryRunTag}`);
  lines.push('');

  const modeStr = meta.mode === 'batch'
    ? `batch (limit=${meta.limit}, budget=$${meta.budget.toFixed(2)})`
    : `single entity (budget=$${meta.budget.toFixed(2)})`;
  lines.push(`**Mode**: ${modeStr}`);

  let totalRecordsCurated = 0;
  let totalRecordsImproved = 0;
  let totalDuration = 0;
  let totalConfirmedDelta = 0;
  for (const r of results) {
    totalRecordsCurated += r.recordsCurated;
    totalRecordsImproved += r.recordsImproved;
    totalDuration += r.duration;
    totalConfirmedDelta +=
      (r.afterVerdicts['confirmed'] ?? 0) - (r.beforeVerdicts['confirmed'] ?? 0);
  }

  const budgetUsedPct = meta.budget > 0
    ? Math.round((meta.totalCost / meta.budget) * 100)
    : 0;
  lines.push(
    `**Result**: ${results.length} entit${results.length === 1 ? 'y' : 'ies'} processed | ` +
    `$${meta.totalCost.toFixed(3)} / $${meta.budget.toFixed(2)} (${budgetUsedPct}%) | ` +
    `${formatDuration(totalDuration)}`,
  );
  lines.push('');

  if (results.length === 0) {
    lines.push('_No entities were processed._');
    return lines.join('\n');
  }

  lines.push('| Entity | Before → After confirmed | Δ | Records curated | Cost | Time |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results) {
    const confirmedBefore = r.beforeVerdicts['confirmed'] ?? 0;
    const confirmedAfter = r.afterVerdicts['confirmed'] ?? 0;
    const totalBefore = Object.values(r.beforeVerdicts).reduce((s, v) => s + v, 0);
    const totalAfter = Object.values(r.afterVerdicts).reduce((s, v) => s + v, 0);
    const pctBefore = totalBefore > 0 ? `${Math.round((confirmedBefore / totalBefore) * 100)}%` : '—';
    const pctAfter = totalAfter > 0 ? `${Math.round((confirmedAfter / totalAfter) * 100)}%` : '—';
    const delta = confirmedAfter - confirmedBefore;
    const deltaStr = delta > 0 ? `**+${delta}**` : delta < 0 ? `${delta}` : '0';
    // Sanitize entity titles before embedding in a markdown table cell:
    //   - replace newlines/tabs with spaces (would break the row otherwise)
    //   - escape pipes (would break the column count)
    //   - escape `[` so we can't accidentally render a markdown link from a
    //     hostile-looking title; bracket-only escape is enough since `]` and
    //     `()` are inert without a leading `[`
    //   - replace backticks so an unbalanced backtick can't open inline code
    const safeTitle = r.entity.title
      .replace(/[\r\n\t]+/g, ' ')
      // Escape backslashes first so an existing `\` can't combine with the
      // escapes we add below for `|` and `[`.
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\[/g, '\\[')
      .replace(/`/g, "'");
    lines.push(
      `| ${safeTitle} | ${pctBefore} → ${pctAfter} | ${deltaStr} | ` +
      `${r.recordsCurated} | $${r.totalCost.toFixed(3)} | ${formatDuration(r.duration)} |`,
    );
  }
  lines.push('');

  lines.push(
    `**Totals**: ${totalRecordsCurated} records curated, ${totalRecordsImproved} improved, ` +
    `${totalConfirmedDelta >= 0 ? '+' : ''}${totalConfirmedDelta} confirmed verdicts.`,
  );

  if (meta.dryRun) {
    lines.push('');
    lines.push('_Dry run — no changes were written._');
  }

  return lines.join('\n');
}

// ── Main Command ───────────────────────────────────────────────────────

async function flagshipCurateCommand(
  args: string[],
  options: CurateOptions,
): Promise<CommandResult> {
  const entityId = options.entity as string | undefined;
  const isAll = options.all ?? false;
  const budget = options.budget ? parseFloat(String(options.budget)) : DEFAULT_BUDGET;
  const limit = options.limit ? parseInt(String(options.limit), 10) : DEFAULT_LIMIT;
  const recordLimit = (options['record-limit'] ?? options.recordLimit)
    ? parseInt(String(options['record-limit'] ?? options.recordLimit), 10)
    : DEFAULT_RECORD_LIMIT;
  const tableFilter = options.table as string | undefined;
  const dryRun = !!(options['dry-run'] ?? options.dryRun);
  const skipResearch = !!(options['skip-research'] ?? options.skipResearch);
  const iterations = options.iterations ? parseInt(String(options.iterations), 10) : 2;
  const linearIssueRaw = (options['linear-comment'] ?? options.linearComment) as string | undefined;
  // Normalise to canonical form via the shared parser so we don't drift from
  // the QUA-team allowlist in `crux/lib/linear/parse-id.ts`.
  const linearIssue = linearIssueRaw ? parseLinearId(linearIssueRaw) : null;
  const startedAt = new Date();

  if (!entityId && !isAll) {
    return {
      exitCode: 1,
      output: `${c.bold}flagship-curate${c.reset}: specify --entity=<slug> or --all

Usage:
  crux flagship-curate --entity=anthropic              Curate one organization
  crux flagship-curate --entity=anthropic --dry-run    Preview what would happen
  crux flagship-curate --all --budget=10               Batch mode: all orgs, $10 cap
  crux flagship-curate --all --limit=5 --budget=5      Top 5 worst-covered orgs

Options:
  --entity=<slug|stableId>   Target entity
  --all                       Process all orgs (sorted by worst coverage)
  --budget=N                  Max dollars to spend (default: $5)
  --limit=N                   Max entities in --all mode (default: 10)
  --record-limit=N            Max records per entity (default: 50)
  --table=<type>              Filter record type (personnel, grant, division, ...)
  --iterations=N              Max curation iterations per entity (default: 2)
  --skip-research             Skip LLM source research (re-verify existing sources)
  --linear-comment=<QUA-NNN>  Post a markdown run summary to a Linear issue (best-effort)
  --dry-run                   Preview without making changes
  --ci                        JSON output`,
    };
  }

  // Validate budget
  if (!isFinite(budget) || budget <= 0) {
    return { exitCode: 1, output: `Invalid budget: ${options.budget}. Must be a positive number.` };
  }

  // Validate Linear issue identifier shape if provided. Existence is checked
  // at post time — fail fast on obviously malformed input now. `parseLinearId`
  // returns `null` for anything that doesn't match the QUA team allowlist.
  if (linearIssueRaw && !linearIssue) {
    return {
      exitCode: 1,
      output: `Invalid --linear-comment value: "${linearIssueRaw}". Expected format: "QUA-NNN".`,
    };
  }

  console.log(`${c.bold}Flagship Curate${c.reset}`);
  console.log(`Budget: $${budget.toFixed(2)} | Mode: ${isAll ? `batch (limit: ${limit})` : `single entity`}`);
  if (dryRun) console.log(`${c.yellow}DRY RUN${c.reset}`);
  console.log('');

  // Resolve entities BEFORE opening the pipeline_run — these checks
  // can fail with no LLM work done, so wasting a /start + /end round-trip
  // on them is pointless.
  let entities: ResolvedEntity[] = [];

  if (entityId) {
    const entity = await resolveEntity(entityId);
    if (!entity) {
      return { exitCode: 1, output: `Entity not found: ${entityId}` };
    }
    entities = [entity];
  } else {
    console.log('Finding entities needing curation...');
    const findResult = await findEntitiesNeedingCuration(limit);
    if (!findResult.ok) {
      // QUA-452: fail loudly instead of reporting "no entities found".
      return {
        exitCode: 1,
        output: `${LOG_PREFIX} Failed to fetch entities from wiki-server: ${findResult.error}. Not treating as "no entities found" — see QUA-452.`,
      };
    }
    entities = findResult.entities;
    if (entities.length === 0) {
      return { exitCode: 0, output: 'No entities found needing curation.' };
    }
    console.log(`Found ${entities.length} entities needing curation:`);
    for (const e of entities) {
      console.log(`  ${e.title} (${e.entityType})`);
    }
  }

  const tracker = new CostTracker();

  async function flagshipCurateBody(): Promise<CommandResult> {
  const results: CurationResult[] = [];

  // Process each entity. A CreditExhaustedError bubbling out of any call
  // path below aborts the whole batch — billing errors aren't transient and
  // continuing would just accumulate wasted no-op "runs" that look successful
  // in the summary. See QUA-378.
  let creditExhausted = false;
  let skippedDueToCredits = 0;
  for (const entity of entities) {
    if (creditExhausted) {
      skippedDueToCredits++;
      continue;
    }

    // Check budget before starting a new entity
    if (tracker.totalCost >= budget) {
      console.log(`\n${c.yellow}Budget limit reached ($${tracker.totalCost.toFixed(3)} / $${budget.toFixed(2)}) — stopping.${c.reset}`);
      break;
    }

    const entityBudget = isAll
      ? Math.min((budget - tracker.totalCost) / Math.max(1, entities.length - results.length), budget - tracker.totalCost)
      : budget;

    // Snapshot the tracker totals before and after this entity so per-entity
    // cost reflects actual incremental spend rather than the cumulative
    // CostTracker total (which would double-count earlier entities in batch
    // mode and miss verification cost that lands after curateEntity returns).
    const costBefore = tracker.totalCost;
    const researchBefore = tracker.breakdown()['flagship-curate-research'] ?? 0;

    try {
      const result = await curateEntity(entity, {
        budget: entityBudget,
        recordLimit,
        tableFilter,
        dryRun,
        skipResearch,
        iterations,
        tracker,
      });

      const researchAfter = tracker.breakdown()['flagship-curate-research'] ?? 0;
      result.totalCost = tracker.totalCost - costBefore;
      result.researchCost = researchAfter - researchBefore;
      result.verifyCost = result.totalCost - result.researchCost;

      results.push(result);
    } catch (e: unknown) {
      if (e instanceof CreditExhaustedError || isCreditExhaustedError(e)) {
        // The current entity counts as "skipped" too — its work was
        // abandoned mid-flight, not completed.
        skippedDueToCredits++;
        const remainingAfterThis = entities.length - results.length - skippedDueToCredits;
        console.error(
          `\n${c.bold}${c.red}✖ ABORTED: Anthropic credit balance is too low.${c.reset}\n` +
          `  Halting batch during '${entity.title}'. ` +
          `${remainingAfterThis} org${remainingAfterThis === 1 ? '' : 's'} will be skipped.\n` +
          `  Top up credits and re-run. ${c.dim}(QUA-378)${c.reset}`,
        );
        creditExhausted = true;
        continue;
      }
      throw e;
    }
  }

  // Format output
  const output = formatSummary(results);

  // Best-effort: post a markdown summary to the target Linear issue. Failures
  // here never change the exit code — the run already happened, the comment
  // is just notification.
  if (linearIssue) {
    const meta: RunMeta = {
      budget,
      totalCost: tracker.totalCost,
      mode: isAll ? 'batch' : 'single',
      limit,
      dryRun,
      startedAt,
    };
    const markdown = formatSummaryMarkdown(results, meta);
    if (!process.env['LINEAR_API_KEY']) {
      console.warn(
        `${LOG_PREFIX} ${c.yellow}LINEAR_API_KEY not set — skipping Linear comment to ${linearIssue}.${c.reset}`,
      );
    } else {
      try {
        await commentOnIssue(linearIssue, markdown);
        console.log(`${LOG_PREFIX} ${c.green}Posted run summary to ${linearIssue}.${c.reset}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `${LOG_PREFIX} ${c.yellow}Failed to post Linear comment to ${linearIssue}: ${msg}${c.reset}`,
        );
      }
    }
  }

  // Exit non-zero when credit exhaustion halted the run. The summary and
  // any partial results still go out on stdout, but CI / wrapper scripts
  // can now distinguish "nothing to curate" (0) from "billing broken" (2).
  const exitCode = creditExhausted ? 2 : 0;

  if (options.ci) {
    return {
      exitCode,
      output: JSON.stringify({
        results: results.map((r) => ({
          entity: r.entity.title,
          entityId: r.entity.stableId,
          recordsCurated: r.recordsCurated,
          recordsImproved: r.recordsImproved,
          cost: r.totalCost,
          duration: r.duration,
          beforeVerdicts: r.beforeVerdicts,
          afterVerdicts: r.afterVerdicts,
        })),
        totalCost: tracker.totalCost,
        breakdown: tracker.breakdown(),
        aborted: creditExhausted ? 'credit_exhausted' : undefined,
        skippedDueToCredits,
      }, null, 2),
    };
  }

  return { exitCode, output };
  }

  return withPipelineRun(
    {
      pipelineName: 'flagship-curate',
      entityId: entityId ?? null,
      shape: isAll ? 'batch' : 'single',
      allowOffline: true,
      tracker,
    },
    flagshipCurateBody,
  );
}

// ── Exports ────────────────────────────────────────────────────────────

export const commands = {
  default: flagshipCurateCommand,
};

export function getHelp(): string {
  return `
Flagship Curate — Unattended per-org curation runner (QUA-220)

Automates the manual curation loop: discover unverified records → research
better source URLs → register and ingest sources → reset verdicts → verify.

Usage:
  crux flagship-curate --entity=anthropic              Curate one organization
  crux flagship-curate --entity=anthropic --dry-run    Preview what would happen
  crux flagship-curate --all --budget=10               Batch mode: all orgs
  crux flagship-curate --all --limit=5 --budget=5      Top 5 worst-covered orgs

Options:
  --entity=<slug|stableId>   Target entity (slug, stableId, or wikiId)
  --all                       Batch mode: process orgs sorted by worst coverage
  --budget=N                  Max dollars to spend across all entities (default: $5)
  --limit=N                   Max entities to process in --all mode (default: 10)
  --record-limit=N            Max records to curate per entity (default: 50)
  --table=<type>              Filter to a specific record type (personnel, grant, ...)
  --iterations=N              Max curation iterations per entity (default: 2)
  --skip-research             Skip LLM source research (only re-verify existing sources)
  --linear-comment=<QUA-NNN>  Post a markdown run summary to a Linear issue (best-effort).
                              Requires LINEAR_API_KEY. Failures never affect exit code.
  --dry-run                   Preview what would be curated without making changes
  --ci                        JSON output for CI pipelines

Pipeline per entity:
  1. Discover records with unverified/partial/unchecked verdicts
  2. Research better source URLs via LLM (unless --skip-research)
  3. Register new URLs via /api/resources/suggest + ingest content
  4. Update personnel records with new source URLs
  5. Reset stale verdicts to unchecked
  6. Run sourcing verification
  7. Report before/after comparison

Cost estimate:
  ~$0.01 per record for source research (Haiku)
  ~$0.005 per record for verification (Haiku)
  A typical org with 40 personnel records: ~$0.60

Examples:
  crux flagship-curate --entity=anthropic --dry-run
  crux flagship-curate --entity=anthropic --table=personnel --budget=1
  crux flagship-curate --all --budget=10 --limit=5
  crux flagship-curate --entity=anthropic --skip-research --iterations=1
  crux flagship-curate --all --budget=10 --limit=5 --linear-comment=QUA-124
`;
}
