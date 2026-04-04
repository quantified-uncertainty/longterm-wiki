/**
 * TableBase Batch Source-Check
 *
 * Source-checks enriched records using the Batch API (50% cost discount).
 * Two-phase approach:
 *   1. Deterministic checks: source URL reachability, entity resolution, field presence
 *   2. LLM source-check via Batch API: cross-reference record claims against source content
 *
 * Usage:
 *   crux tb source-check-records --table=personnel           # Check all personnel records
 *   crux tb source-check-records --table=personnel --limit=50 # Check first 50
 *   crux tb source-check-records --source=batch               # LLM source-check via Batch API
 *   crux tb source-check-records --source=deterministic       # Structural checks only (no LLM)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { createLlmClient, MODELS } from '../lib/llm.ts';
import { submitBatch, pollBatch, getBatchResults, extractBatchResultText } from '../lib/anthropic-batch.ts';
import type { BatchRequest } from '../lib/anthropic-batch.ts';
import { getTableConfig } from './table-registry.ts';
import { calculateCost } from '../lib/pricing.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationIssue {
  recordId: string;
  table: string;
  entityName?: string;
  field: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Source of the finding: 'deterministic' or 'llm' */
  source: 'deterministic' | 'llm';
}

export interface VerificationResult {
  table: string;
  totalRecords: number;
  recordsChecked: number;
  issues: VerificationIssue[];
  /** Batch API cost (0 for deterministic-only) */
  batchCost: number;
  durationMs: number;
}

interface PersonnelRecord {
  id: string;
  personId: string;
  organizationId: string;
  role: string;
  roleType: string;
  startDate?: string | null;
  endDate?: string | null;
  isFounder?: boolean;
  source?: string | null;
  notes?: string | null;
  [key: string]: unknown;
}

interface FundingRoundRecord {
  id: string;
  companyId: string;
  name: string;
  date?: string | null;
  raised?: number | null;
  source?: string | null;
  [key: string]: unknown;
}

interface GenericRecord {
  id: string;
  source?: string | null;
  sourceUrl?: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Entity name resolution
// ---------------------------------------------------------------------------

/**
 * Load entity data from database.json and return it as parsed JSON.
 * Returns null if the file doesn't exist or can't be parsed.
 */
function loadDatabaseJson(): {
  typedEntities?: Array<{ id: string; stableId?: string; title?: string }>;
  idRegistry?: { stableIdBySlug?: Record<string, string> };
} | null {
  const dbPath = join(PROJECT_ROOT, 'apps/web/src/data/database.json');
  if (!existsSync(dbPath)) return null;

  try {
    return JSON.parse(readFileSync(dbPath, 'utf-8'));
  } catch {
    // Non-critical — callers handle null gracefully
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic checks
// ---------------------------------------------------------------------------

/**
 * Build a set of known stableIds from database.json for entity existence checks.
 * Unlike the entity matcher (which is keyed by name/slug), this indexes by stableId.
 */
function buildStableIdSet(): Set<string> {
  const ids = new Set<string>();
  const db = loadDatabaseJson();
  if (!db) return ids;

  // Index from typedEntities
  for (const e of (db.typedEntities || []) as Array<{ stableId?: string }>) {
    if (e.stableId) ids.add(e.stableId);
  }
  // Index from idRegistry
  const registry = db.idRegistry?.stableIdBySlug as Record<string, string> | undefined;
  if (registry) {
    for (const stableId of Object.values(registry)) {
      ids.add(stableId);
    }
  }
  return ids;
}

/**
 * Build a map of stableId -> human-readable entity name from database.json.
 * Used to resolve opaque internal IDs to names the LLM can verify.
 */
export function buildStableIdNameMap(): Map<string, string> {
  const nameMap = new Map<string, string>();
  const db = loadDatabaseJson();
  if (!db) return nameMap;

  // Build stableId -> slug map from idRegistry for fallback names
  const stableIdToSlug = new Map<string, string>();
  const slugToStableId = db.idRegistry?.stableIdBySlug;
  if (slugToStableId) {
    for (const [slug, stableId] of Object.entries(slugToStableId)) {
      stableIdToSlug.set(stableId, slug);
    }
  }

  // Index from typedEntities — prefer title, fall back to slug
  for (const e of (db.typedEntities || [])) {
    const stableId = e.stableId;
    if (!stableId) continue;
    const name = e.title || e.id || stableIdToSlug.get(stableId);
    if (name) nameMap.set(stableId, name);
  }

  // Also add entries from idRegistry that aren't already covered
  if (slugToStableId) {
    for (const [slug, stableId] of Object.entries(slugToStableId)) {
      if (!nameMap.has(stableId)) {
        // Use slug as a readable fallback (e.g. "anthropic")
        nameMap.set(stableId, slug);
      }
    }
  }

  return nameMap;
}

/**
 * Fields that contain entity stableIds (opaque 10-char internal identifiers).
 * These are resolved to human-readable names before sending to the LLM.
 */
const ENTITY_ID_FIELDS = [
  'personId', 'organizationId', 'investorId', 'companyId',
  'benchmarkId', 'modelId', 'granteeId',
];

/**
 * Fields that are internal-only and should be stripped from the LLM prompt
 * because they are redundant with resolved names or not useful for verification.
 */
const INTERNAL_ONLY_FIELDS = [
  'personEntityId', 'orgEntityId',
  'syncedAt', 'createdAt', 'updatedAt',
];

/**
 * Create a human-readable copy of a record for LLM verification.
 *
 * - Replaces stableId values in entity-reference fields with human-readable names
 * - Uses resolved name fields from the API response when available (e.g. personResolvedName)
 * - Strips internal-only fields that don't help verification
 * - Falls back to the original value if no name can be resolved
 */
export function humanizeRecord(
  record: GenericRecord,
  nameMap: Map<string, string>,
): GenericRecord {
  const humanized: GenericRecord = { ...record };

  // Strip internal-only fields
  for (const field of INTERNAL_ONLY_FIELDS) {
    delete humanized[field];
  }

  // Replace stableId fields with human-readable names
  for (const field of ENTITY_ID_FIELDS) {
    const val = humanized[field];
    if (typeof val !== 'string' || !val) continue;

    // Check for resolved name from the API response
    // e.g. personId -> personResolvedName, organizationId -> orgResolvedName
    const resolvedNameField = getResolvedNameField(field);
    const resolvedName = resolvedNameField ? (record[resolvedNameField] as string | undefined) : undefined;

    if (resolvedName) {
      humanized[field] = resolvedName;
    } else {
      // Fall back to name map lookup
      const name = nameMap.get(val);
      if (name) {
        humanized[field] = name;
      }
      // If no name found, leave the original value (better than nothing)
    }
  }

  // Also remove the redundant *ResolvedName fields since we've inlined the names
  delete humanized['personResolvedName'];
  delete humanized['orgResolvedName'];

  // Remove nested entity ref objects (person, organization) since we've inlined names
  // These are structured duplicates of the flat fields
  if (humanized['person'] && typeof humanized['person'] === 'object') {
    delete humanized['person'];
  }
  if (humanized['organization'] && typeof humanized['organization'] === 'object') {
    delete humanized['organization'];
  }

  return humanized;
}

/**
 * Map an entity ID field name to its corresponding resolved name field.
 * Returns null if no resolved name field exists for this field.
 */
function getResolvedNameField(idField: string): string | null {
  switch (idField) {
    case 'personId':
      return 'personResolvedName';
    case 'organizationId':
      return 'orgResolvedName';
    default:
      return null;
  }
}

/**
 * Run structural/deterministic checks on records. No LLM needed.
 */
export function runDeterministicChecks(
  table: string,
  records: GenericRecord[],
): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const knownIds = buildStableIdSet();

  for (const rec of records) {
    // Missing source URL
    const sourceUrl = rec.source || rec.sourceUrl;
    if (!sourceUrl) {
      issues.push({
        recordId: rec.id,
        table,
        field: 'source',
        severity: 'error',
        message: 'Missing source URL — cannot verify this record',
        source: 'deterministic',
      });
    }

    // Entity reference checks (personId, organizationId, etc.)
    const entityFields = ['personId', 'organizationId', 'investorId', 'companyId', 'benchmarkId', 'modelId', 'granteeId'];
    for (const field of entityFields) {
      const val = rec[field] as string | undefined;
      if (!val) continue;

      // StableIds are 10-char alphanumeric. If it has hyphens, it's probably a slug (bug).
      if (val.includes('-') && val.length > 12) {
        issues.push({
          recordId: rec.id,
          table,
          field,
          severity: 'warning',
          message: `Field "${field}" looks like a slug ("${val}") instead of a stableId`,
          source: 'deterministic',
        });
      }

      // Check if the entity stableId exists in database.json.
      // Note: entities created by ensure-entities/create-entity only exist in PG,
      // not in YAML. If knownIds is empty (no database.json), skip this check.
      if (knownIds.size > 0 && !knownIds.has(val)) {
        issues.push({
          recordId: rec.id,
          table,
          field,
          severity: 'info',
          message: `Entity "${val}" in field "${field}" not in local database.json (may exist in PG only)`,
          source: 'deterministic',
        });
      }
    }

    // Date plausibility checks
    for (const dateField of ['startDate', 'endDate', 'date']) {
      const dateVal = rec[dateField] as string | undefined;
      if (!dateVal) continue;
      const year = parseInt(dateVal.substring(0, 4), 10);
      if (isNaN(year) || year < 1900 || year > new Date().getFullYear() + 1) {
        issues.push({
          recordId: rec.id,
          table,
          field: dateField,
          severity: 'error',
          message: `Implausible date "${dateVal}" in field "${dateField}"`,
          source: 'deterministic',
        });
      }
    }

    // Personnel-specific checks
    if (table === 'personnel') {
      const prec = rec as PersonnelRecord;
      if (prec.roleType && !['key-person', 'board', 'career'].includes(prec.roleType)) {
        issues.push({
          recordId: rec.id,
          table,
          field: 'roleType',
          severity: 'error',
          message: `Invalid roleType "${prec.roleType}" — must be key-person, board, or career`,
          source: 'deterministic',
        });
      }
    }

    // Duplicate detection within the batch
    // (handled by dedup.ts on submission, but good to flag in verification too)
  }

  // Cross-record duplicate check
  const seen = new Map<string, string>();
  for (const rec of records) {
    let key: string;
    if (table === 'personnel') {
      const p = rec as PersonnelRecord;
      key = `${p.personId}|${p.organizationId}|${(p.role || '').toLowerCase().trim()}`;
    } else if (table === 'funding-rounds') {
      const f = rec as FundingRoundRecord;
      key = `${f.companyId}|${(f.name || '').toLowerCase().trim()}`;
    } else {
      key = JSON.stringify(rec);
    }

    if (seen.has(key)) {
      issues.push({
        recordId: rec.id,
        table,
        field: '_duplicate',
        severity: 'warning',
        message: `Duplicate of record ${seen.get(key)}`,
        source: 'deterministic',
      });
    } else {
      seen.set(key, rec.id);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// LLM batch verification
// ---------------------------------------------------------------------------

/** Build a verification prompt for a single record */
export function buildVerificationPrompt(
  table: string,
  record: GenericRecord,
  nameMap: Map<string, string>,
): string {
  const sourceUrl = record.source || record.sourceUrl || '(none)';

  // Replace opaque stableIds with human-readable entity names
  const humanized = humanizeRecord(record, nameMap);
  const recordJson = JSON.stringify(humanized, null, 2);

  return `You are a data quality auditor. Verify this ${table} record for accuracy and completeness.

## Record
\`\`\`json
${recordJson}
\`\`\`

## Checks to perform
1. **Field completeness**: Are all important fields filled in? Are any values suspiciously generic (e.g., role="Employee")?
2. **Date plausibility**: Do start/end dates make sense? Is a startDate in the future? Is an endDate before a startDate?
3. **Role plausibility**: Does the role title sound real for this type of organization?
4. **Source quality**: Source URL is "${sourceUrl}". Does it look like a legitimate source (team page, news article, Wikipedia)?
5. **Internal consistency**: Do the fields agree with each other? (e.g., isFounder=true but role is "Intern" would be suspicious)

Note: Entity reference fields (personId, organizationId, etc.) have been resolved to human-readable names. The "id" field is an internal record identifier — do not flag it as unverifiable.

## Response format
Respond with a JSON object:
\`\`\`json
{
  "verdict": "pass" | "warning" | "fail",
  "issues": [
    {
      "field": "<field name>",
      "severity": "error" | "warning",
      "message": "<what's wrong>"
    }
  ],
  "confidence": 0.0-1.0,
  "notes": "<optional brief explanation>"
}
\`\`\`

If the record looks reasonable, return \`{"verdict":"pass","issues":[],"confidence":0.9}\`.
Only flag issues you are confident about based on the record data alone.`;
}

/** Parse the LLM verification response */
function parseVerificationResponse(
  text: string,
  recordId: string,
  table: string,
): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  try {
    // Extract JSON from possible markdown code blocks
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return issues;

    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsed = JSON.parse(jsonStr) as {
      verdict: string;
      issues?: Array<{ field: string; severity: string; message: string }>;
      confidence?: number;
      notes?: string;
    };

    if (parsed.issues && Array.isArray(parsed.issues)) {
      for (const issue of parsed.issues) {
        issues.push({
          recordId,
          table,
          field: issue.field || 'unknown',
          severity: issue.severity === 'error' ? 'error' : 'warning',
          message: issue.message,
          source: 'llm',
        });
      }
    }
  } catch {
    // Unparseable response — log as warning
    issues.push({
      recordId,
      table,
      field: '_parse',
      severity: 'info',
      message: `Could not parse LLM verification response`,
      source: 'llm',
    });
  }

  return issues;
}

/**
 * Run LLM verification on records via the Batch API.
 * Uses Haiku for cost efficiency (50% batch discount on top of cheap model).
 */
export async function runBatchVerification(
  table: string,
  records: GenericRecord[],
  options: { model?: string } = {},
): Promise<{ issues: VerificationIssue[]; cost: number }> {
  const model = options.model || MODELS.haiku;
  const client = createLlmClient();
  const issues: VerificationIssue[] = [];

  // Build name map once for the entire batch
  const nameMap = buildStableIdNameMap();

  // Build batch requests
  const batchRequests: BatchRequest[] = records.map((rec) => ({
    customId: `verify-${table}-${rec.id}`,
    params: {
      model,
      max_tokens: 1024,
      messages: [
        { role: 'user' as const, content: buildVerificationPrompt(table, rec, nameMap) },
      ],
    },
  }));

  if (batchRequests.length === 0) {
    return { issues: [], cost: 0 };
  }

  console.log(`[verify] Submitting batch of ${batchRequests.length} verification requests (model: ${model})...`);

  const results = await runBatchWithProgress(client, batchRequests);

  // Parse results
  let totalCost = 0;
  for (const [customId, result] of results) {
    const recordId = customId.replace(`verify-${table}-`, '');
    const text = extractBatchResultText(result);

    if (result.result.type === 'succeeded') {
      const usage = result.result.message.usage;
      totalCost += calculateCost(model, {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      }, { batchDiscount: true });
    }

    if (text) {
      const recordIssues = parseVerificationResponse(text, recordId, table);
      issues.push(...recordIssues);
    }
  }

  console.log(`[verify] Batch complete: ${results.size} results, ${issues.length} issues, $${totalCost.toFixed(4)}`);

  return { issues, cost: totalCost };
}

/** Submit batch and poll with progress logging */
async function runBatchWithProgress(
  client: ReturnType<typeof createLlmClient>,
  requests: BatchRequest[],
) {
  const batch = await submitBatch(client, requests);
  console.log(`[verify] Batch submitted: ${batch.id} (${requests.length} requests)`);

  const completed = await pollBatch(client, batch.id, {
    intervalMs: 15_000,
    timeoutMs: 3_600_000,
    onPoll: (b) => {
      const counts = b.request_counts;
      console.log(`[verify] Polling... processing=${counts.processing} succeeded=${counts.succeeded} errored=${counts.errored}`);
    },
  });

  console.log(`[verify] Batch ended: ${JSON.stringify(completed.request_counts)}`);
  return getBatchResults(client, batch.id);
}

// ---------------------------------------------------------------------------
// Fetch records for verification
// ---------------------------------------------------------------------------

async function fetchAllRecords(table: string, limit?: number): Promise<GenericRecord[]> {
  const config = getTableConfig(table);
  if (!config) throw new Error(`Unknown table: ${table}`);

  // Use the /all endpoint pattern
  const allPath = `/api/${table}/all`;
  const records: GenericRecord[] = [];
  let offset = 0;
  const pageSize = 200;

  while (true) {
    const result = await apiRequest<Record<string, unknown>>(
      'GET',
      `${allPath}?limit=${pageSize}&offset=${offset}`,
    );
    if (!result.ok) {
      console.warn(`[verify] Failed to fetch from ${allPath}: ${result.message}`);
      break;
    }

    const page = (result.data[config.resultKey] as GenericRecord[]) || [];
    records.push(...page);

    const total = result.data.total as number | undefined;
    if (limit && records.length >= limit) {
      return records.slice(0, limit);
    }
    if (total && records.length >= total) break;
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return limit ? records.slice(0, limit) : records;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface VerifyOptions {
  table: string;
  limit?: number;
  /** 'deterministic' = structural only, 'batch' = LLM via Batch API, 'all' = both */
  source?: 'deterministic' | 'batch' | 'all';
  /** LLM model for batch verification (default: haiku) */
  model?: string;
  /** Max records per batch request (Batch API limit is 10,000) */
  batchSize?: number;
}

export async function verifyRecords(options: VerifyOptions): Promise<VerificationResult> {
  const startTime = Date.now();
  const { table, limit, source = 'all', model, batchSize = 500 } = options;

  console.log(`[verify] Fetching ${table} records${limit ? ` (limit: ${limit})` : ''}...`);
  const records = await fetchAllRecords(table, limit);
  console.log(`[verify] Fetched ${records.length} records`);

  const allIssues: VerificationIssue[] = [];
  let batchCost = 0;

  // Phase 1: Deterministic checks
  if (source === 'deterministic' || source === 'all') {
    console.log(`[verify] Running deterministic checks...`);
    const deterministicIssues = runDeterministicChecks(table, records);
    allIssues.push(...deterministicIssues);
    console.log(`[verify] Deterministic: ${deterministicIssues.length} issues found`);
  }

  // Phase 2: LLM batch verification
  if (source === 'batch' || source === 'all') {
    // Process in chunks to stay within Batch API limits
    for (let i = 0; i < records.length; i += batchSize) {
      const chunk = records.slice(i, i + batchSize);
      console.log(`[verify] LLM batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(records.length / batchSize)}: ${chunk.length} records`);
      const { issues: batchIssues, cost } = await runBatchVerification(table, chunk, { model });
      allIssues.push(...batchIssues);
      batchCost += cost;
    }
  }

  return {
    table,
    totalRecords: records.length,
    recordsChecked: records.length,
    issues: allIssues,
    batchCost,
    durationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

export function formatVerificationReport(result: VerificationResult): string {
  const lines: string[] = [];

  lines.push(`\x1b[1mVerification Report: ${result.table}\x1b[0m`);
  lines.push(`Records checked: ${result.recordsChecked}/${result.totalRecords}`);
  lines.push(`Duration: ${Math.round(result.durationMs / 1000)}s`);
  if (result.batchCost > 0) {
    lines.push(`Batch API cost: $${result.batchCost.toFixed(4)}`);
  }
  lines.push('');

  const errors = result.issues.filter(i => i.severity === 'error');
  const warnings = result.issues.filter(i => i.severity === 'warning');
  const infos = result.issues.filter(i => i.severity === 'info');

  lines.push(`Issues: ${errors.length} errors, ${warnings.length} warnings, ${infos.length} info`);
  lines.push('');

  if (errors.length > 0) {
    lines.push('\x1b[31m── Errors ──\x1b[0m');
    for (const issue of errors) {
      lines.push(`  \x1b[31m✗\x1b[0m [${issue.source}] ${issue.recordId}: ${issue.field} — ${issue.message}`);
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('\x1b[33m── Warnings ──\x1b[0m');
    for (const issue of warnings.slice(0, 50)) {
      lines.push(`  \x1b[33m!\x1b[0m [${issue.source}] ${issue.recordId}: ${issue.field} — ${issue.message}`);
    }
    if (warnings.length > 50) {
      lines.push(`  ... and ${warnings.length - 50} more warnings`);
    }
    lines.push('');
  }

  // Summary by field
  const byField = new Map<string, number>();
  for (const issue of result.issues) {
    const key = `${issue.field} (${issue.severity})`;
    byField.set(key, (byField.get(key) || 0) + 1);
  }
  if (byField.size > 0) {
    lines.push('── Issue breakdown by field ──');
    const sorted = [...byField.entries()].sort((a, b) => b[1] - a[1]);
    for (const [field, count] of sorted) {
      lines.push(`  ${field}: ${count}`);
    }
  }

  return lines.join('\n');
}
