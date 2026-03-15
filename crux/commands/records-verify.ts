/**
 * Record Verification Command
 *
 * Verifies structured data records (grants, personnel, divisions, etc.)
 * against their source URLs using an LLM. For each record with a source
 * URL, fetches the source content and checks whether the source confirms
 * the record's data.
 *
 * Usage:
 *   crux verify grants                       Verify all grants with source URLs
 *   crux verify personnel --entity=anthropic  Verify personnel for one org
 *   crux verify stats                        Show verification coverage report
 *   crux verify --type=grant --limit=10       Verify 10 grants
 *   crux verify --dry-run                     Show what would be checked
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { createLlmClient, callLlm, MODELS } from '../lib/llm.ts';
import { parseJsonResponse } from '../lib/anthropic.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import {
  detectPaywall,
  isUnverifiableDomain,
  classifyFetchError,
  type SourceFetchErrorType,
} from '../lib/search/paywall-detection.ts';
import { getCitationContentByUrl } from '../lib/wiki-server/citations.ts';
import {
  VALID_RECORD_TYPES,
  VALID_VERIFICATION_VERDICTS,
  type RecordType,
  type VerificationVerdict,
} from '../../apps/wiki-server/src/api-types.ts';

// ── Constants ────────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 8000;
const FETCH_TIMEOUT_MS = 15_000;

// ── Types ────────────────────────────────────────────────────────────

interface VerifyCommandOptions extends BaseOptions {
  type?: string;
  entity?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  limit?: string;
  ci?: boolean;
}

interface RecordToVerify {
  recordType: RecordType;
  recordId: string;
  description: string; // human-readable summary of the record
  sourceUrl: string;
  fields: Record<string, string | number | null>; // key fields to verify
}

interface VerificationResult {
  recordType: RecordType;
  recordId: string;
  description: string;
  sourceUrl: string;
  verdict: VerificationVerdict;
  confidence: number;
  extractedValue: string;
  reasoning: string;
  errorType?: SourceFetchErrorType;
}

interface VerificationError {
  recordType: RecordType;
  recordId: string;
  sourceUrl: string;
  error: string;
  errorType?: SourceFetchErrorType;
}

// ── API helpers ──────────────────────────────────────────────────────

/** Safe field access from untyped API response objects */
function str(item: Record<string, unknown>, key: string): string {
  const v = item[key];
  return typeof v === 'string' ? v : String(v ?? '');
}

function strOrNull(item: Record<string, unknown>, key: string): string | null {
  const v = item[key];
  return v == null ? null : String(v);
}

function numOrNull(item: Record<string, unknown>, key: string): number | null {
  const v = item[key];
  return typeof v === 'number' ? v : null;
}

/** API response wrapper for paginated results */
interface PaginatedResponse {
  items?: Record<string, unknown>[];
  grants?: Record<string, unknown>[];
  personnel?: Record<string, unknown>[];
  divisions?: Record<string, unknown>[];
  programs?: Record<string, unknown>[];
  rounds?: Record<string, unknown>[];
  investments?: Record<string, unknown>[];
  positions?: Record<string, unknown>[];
  total?: number;
}

async function fetchRecords(recordType: RecordType, entityFilter?: string): Promise<RecordToVerify[]> {
  const records: RecordToVerify[] = [];

  const apiPath = getApiPath(recordType, entityFilter);
  if (!apiPath) return records;

  const response = await apiRequest<PaginatedResponse>('GET', apiPath);
  if (!response.ok || !response.data) {
    console.warn(`[verify] Failed to fetch ${recordType} records: ${response.error ?? 'unknown error'}`);
    return records;
  }

  const items = extractItems(response.data, recordType);

  for (const item of items) {
    const source = strOrNull(item, 'source');
    if (!source) continue;

    const record = buildRecordToVerify(recordType, item);
    if (record) records.push(record);
  }

  return records;
}

function getApiPath(recordType: RecordType, entityFilter?: string): string | null {
  if (entityFilter) {
    switch (recordType) {
      case 'grant':
        return `/api/grants/by-entity/${entityFilter}`;
      case 'personnel':
        return `/api/personnel/by-entity/${entityFilter}`;
      case 'division':
        return `/api/divisions/by-org/${entityFilter}`;
      case 'funding-program':
        return `/api/funding-programs/by-org/${entityFilter}`;
      default:
        return `/api/${getApiSegment(recordType)}/all`;
    }
  }
  return `/api/${getApiSegment(recordType)}/all`;
}

function getApiSegment(recordType: RecordType): string {
  switch (recordType) {
    case 'grant': return 'grants';
    case 'personnel': return 'personnel';
    case 'division': return 'divisions';
    case 'funding-program': return 'funding-programs';
    case 'funding-round': return 'funding-rounds';
    case 'investment': return 'investments';
    case 'equity-position': return 'equity-positions';
  }
}

function extractItems(data: PaginatedResponse, recordType: RecordType): Record<string, unknown>[] {
  // API responses use different key names for the items array
  if (data.items) return data.items;
  if (data.grants) return data.grants;
  if (data.personnel) return data.personnel;
  if (data.divisions) return data.divisions;
  if (data.programs) return data.programs;
  if (data.rounds) return data.rounds;
  if (data.investments) return data.investments;
  if (data.positions) return data.positions;

  // Some endpoints return arrays directly
  if (Array.isArray(data)) return data;

  // Try common patterns
  const segment = getApiSegment(recordType);
  const segmentData = (data as Record<string, unknown>)[segment];
  if (Array.isArray(segmentData)) return segmentData as Record<string, unknown>[];

  return [];
}

function buildRecordToVerify(recordType: RecordType, item: Record<string, unknown>): RecordToVerify | null {
  const source = strOrNull(item, 'source');
  if (!source) return null;

  const id = str(item, 'id');

  switch (recordType) {
    case 'grant':
      return {
        recordType,
        recordId: id,
        description: `Grant: ${str(item, 'name')} (${str(item, 'organizationId')} → ${strOrNull(item, 'granteeId') ?? 'unknown'})`,
        sourceUrl: source,
        fields: { name: str(item, 'name'), amount: numOrNull(item, 'amount'), date: strOrNull(item, 'date'), grantee: strOrNull(item, 'granteeId'), funder: str(item, 'organizationId') },
      };
    case 'personnel':
      return {
        recordType,
        recordId: id,
        description: `Personnel: ${str(item, 'personId')} at ${str(item, 'organizationId')} (${str(item, 'role')})`,
        sourceUrl: source,
        fields: { person: str(item, 'personId'), org: str(item, 'organizationId'), role: str(item, 'role'), roleType: str(item, 'roleType'), startDate: strOrNull(item, 'startDate'), endDate: strOrNull(item, 'endDate') },
      };
    case 'division':
      return {
        recordType,
        recordId: id,
        description: `Division: ${str(item, 'name')} (${str(item, 'parentOrgId')})`,
        sourceUrl: source,
        fields: { name: str(item, 'name'), parent: str(item, 'parentOrgId'), type: str(item, 'divisionType'), status: str(item, 'status'), lead: strOrNull(item, 'lead') },
      };
    case 'funding-program':
      return {
        recordType,
        recordId: id,
        description: `Funding Program: ${str(item, 'name')} (${str(item, 'orgId')})`,
        sourceUrl: source,
        fields: { name: str(item, 'name'), org: str(item, 'orgId'), type: str(item, 'programType'), budget: numOrNull(item, 'totalBudget'), deadline: strOrNull(item, 'deadline'), status: strOrNull(item, 'status') },
      };
    case 'funding-round':
      return {
        recordType,
        recordId: id,
        description: `Funding Round: ${str(item, 'name')} (${str(item, 'companyId')})`,
        sourceUrl: source,
        fields: { name: str(item, 'name'), company: str(item, 'companyId'), raised: numOrNull(item, 'raised'), valuation: numOrNull(item, 'valuation'), date: strOrNull(item, 'date') },
      };
    case 'investment':
      return {
        recordType,
        recordId: id,
        description: `Investment: ${str(item, 'investorId')} → ${str(item, 'companyId')}`,
        sourceUrl: source,
        fields: { investor: str(item, 'investorId'), company: str(item, 'companyId'), amount: numOrNull(item, 'amount'), round: strOrNull(item, 'roundName'), role: strOrNull(item, 'role') },
      };
    case 'equity-position':
      return {
        recordType,
        recordId: id,
        description: `Equity: ${str(item, 'holderId')} in ${str(item, 'companyId')} (${strOrNull(item, 'stake') ?? '?'}%)`,
        sourceUrl: source,
        fields: { holder: str(item, 'holderId'), company: str(item, 'companyId'), stake: strOrNull(item, 'stake'), asOf: strOrNull(item, 'asOf') },
      };
  }
}

// ── Source fetching ──────────────────────────────────────────────────

interface FetchSourceResult {
  content: string | null;
  errorType?: SourceFetchErrorType;
  errorMessage?: string;
}

async function fetchSourceContent(url: string): Promise<FetchSourceResult> {
  if (!url.startsWith('https://')) {
    return { content: null, errorType: 'fetch_error', errorMessage: 'Non-HTTPS URL' };
  }

  // SSRF protection
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
      host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal') ||
      /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^192\.168\./.test(host) || /^169\.254\./.test(host)
    ) {
      return { content: null, errorType: 'access_denied', errorMessage: 'Private host blocked' };
    }
  } catch {
    return { content: null, errorType: 'fetch_error', errorMessage: 'Invalid URL' };
  }

  if (isUnverifiableDomain(url)) {
    return { content: null, errorType: 'unverifiable_domain', errorMessage: 'Domain blocks automated access' };
  }

  // Try wiki-server citation_content cache
  try {
    const result = await getCitationContentByUrl(url);
    if (result.ok && result.data) {
      const cached = result.data as Record<string, unknown>;
      const content = cached.fullText as string | null;
      if (content && content.length > 0) {
        if (detectPaywall(content)) {
          return { content: content.slice(0, MAX_CONTENT_LENGTH), errorType: 'paywall', errorMessage: 'Cached content appears paywalled' };
        }
        return { content: content.slice(0, MAX_CONTENT_LENGTH) };
      }
    }
  } catch {
    // Fall through to direct fetch
  }

  // Direct fetch
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'LongtermWiki-RecordVerifier/1.0',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errorType = classifyFetchError(response.status, null, null, url);
      return { content: null, errorType: errorType ?? 'fetch_error', errorMessage: `HTTP ${response.status}` };
    }

    const html = await response.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_CONTENT_LENGTH);

    if (detectPaywall(text)) {
      return { content: text, errorType: 'paywall', errorMessage: 'Content appears paywalled' };
    }

    return { content: text };
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { content: null, errorType: 'timeout', errorMessage: 'Request timed out' };
    }
    return { content: null, errorType: 'fetch_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }
}

// ── LLM verification ────────────────────────────────────────────────

function buildPrompt(record: RecordToVerify, sourceText: string): string {
  const fieldsStr = Object.entries(record.fields)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  return `You are a fact-checker. Given the source text below, verify this structured data record.

Record type: ${record.recordType}
Record: ${record.description}
Key fields:
${fieldsStr}

Source URL: ${record.sourceUrl}

Source text (excerpt):
---
${sourceText.slice(0, 4000)}
---

Does the source text confirm, contradict, or not address the claims in this record?

Consider:
- Numbers may be expressed differently (e.g., "1 billion" vs "1e9" vs "$1B")
- Names may differ slightly (abbreviations, legal names vs common names)
- Dates may be approximate
- If the source discusses the topic but doesn't contain the specific data, that's "unverifiable"
- If the source has newer data that supersedes the record, that's "outdated"
- If the source partially confirms (e.g., confirms role but not dates), that's "partial"

Respond with ONLY a JSON object (no markdown code fences):
{
  "verdict": "confirmed|contradicted|unverifiable|outdated|partial",
  "confidence": 0.0 to 1.0,
  "extracted_value": "What the source actually says about this record (quote or paraphrase)",
  "reasoning": "Brief explanation of your verdict"
}`;
}

async function verifySingleRecord(
  record: RecordToVerify,
  client: ReturnType<typeof createLlmClient>,
): Promise<VerificationResult | VerificationError> {
  const fetchResult = await fetchSourceContent(record.sourceUrl);
  if (!fetchResult.content) {
    return {
      recordType: record.recordType,
      recordId: record.recordId,
      sourceUrl: record.sourceUrl,
      error: fetchResult.errorMessage ?? 'Could not fetch source content',
      errorType: fetchResult.errorType,
    };
  }

  const prompt = buildPrompt(record, fetchResult.content);

  try {
    const result = await callLlm(client, prompt, {
      model: MODELS.haiku,
      maxTokens: 500,
      temperature: 0,
      retryLabel: `verify-record-${record.recordId}`,
    });

    const parsed = parseJsonResponse(result.text) as {
      verdict: string;
      confidence: number;
      extracted_value: string;
      reasoning: string;
    };

    const verdict = (VALID_VERIFICATION_VERDICTS as readonly string[]).includes(parsed.verdict)
      ? (parsed.verdict as VerificationVerdict)
      : 'unverifiable';

    return {
      recordType: record.recordType,
      recordId: record.recordId,
      description: record.description,
      sourceUrl: record.sourceUrl,
      verdict,
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      extractedValue: parsed.extracted_value ?? '',
      reasoning: parsed.reasoning ?? '',
      ...(fetchResult.errorType && { errorType: fetchResult.errorType }),
    };
  } catch (e: unknown) {
    return {
      recordType: record.recordType,
      recordId: record.recordId,
      sourceUrl: record.sourceUrl,
      error: `LLM call failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── Store results ────────────────────────────────────────────────────

async function storeVerificationResult(result: VerificationResult): Promise<void> {
  const body = {
    recordType: result.recordType,
    recordId: result.recordId,
    sourceUrl: result.sourceUrl,
    verdict: result.verdict,
    confidence: result.confidence,
    extractedValue: result.extractedValue,
    checkerModel: MODELS.haiku,
    notes: result.reasoning,
  };

  const response = await apiRequest<{ id: number; verdictFlagged: boolean }>(
    'POST',
    '/api/record-verifications/verifications',
    body,
  );

  if (!response.ok) {
    console.warn(`[verify] Failed to store verification for ${result.recordType}/${result.recordId}: ${response.error}`);
  }
}

/** Maps record type to things source_table name */
const RECORD_TYPE_TO_SOURCE_TABLE: Record<string, string> = {
  grant: 'grants',
  personnel: 'personnel',
  division: 'divisions',
  'funding-program': 'funding_programs',
  'funding-round': 'funding_rounds',
  investment: 'investments',
  'equity-position': 'equity_positions',
};

/** Cache of (sourceTable, sourceId) → thingId for verdict sync */
const thingIdCache = new Map<string, string | null>();

async function lookupThingId(recordType: RecordType, recordId: string): Promise<string | null> {
  const cacheKey = `${recordType}:${recordId}`;
  if (thingIdCache.has(cacheKey)) return thingIdCache.get(cacheKey) ?? null;

  const sourceTable = RECORD_TYPE_TO_SOURCE_TABLE[recordType];
  if (!sourceTable) return null;

  // Use the things list API with type filter, then find by source match
  const response = await apiRequest<{ things: Array<{ id: string; sourceTable: string; sourceId: string }> }>(
    'GET',
    `/api/things?thing_type=${encodeURIComponent(recordType)}&limit=1000&sort=title&order=asc`,
  );

  if (!response.ok || !response.data) {
    thingIdCache.set(cacheKey, null);
    return null;
  }

  // Warn if we hit the limit — results may be incomplete
  if (response.data.things.length >= 1000) {
    console.warn(
      `[lookupThingId] Fetched 1000 items for ${recordType} — results may be truncated. ` +
      `Consider implementing pagination if this entity type grows further.`,
    );
  }

  // Cache all results for future lookups
  for (const thing of response.data.things) {
    const key = `${recordType}:${thing.sourceId}`;
    thingIdCache.set(key, thing.id);
  }

  return thingIdCache.get(cacheKey) ?? null;
}

async function syncVerdictToThings(
  recordType: RecordType,
  recordId: string,
  verdict: VerificationVerdict,
  confidence: number,
  reasoning: string,
  sourcesChecked: number,
): Promise<void> {
  const thingId = await lookupThingId(recordType, recordId);
  if (!thingId) return;

  const response = await apiRequest<{ thingId: string }>(
    'POST',
    '/api/things/verdicts',
    {
      thingId,
      verdict,
      confidence,
      reasoning,
      sourcesChecked,
    },
  );

  if (!response.ok) {
    console.warn(`[verify] Failed to sync verdict to things for ${recordType}/${recordId}: ${response.error}`);
  }
}

async function storeAggregateVerdict(
  recordType: RecordType,
  recordId: string,
  verdict: VerificationVerdict,
  confidence: number,
  reasoning: string,
  sourcesChecked: number,
): Promise<void> {
  const body = {
    recordType,
    recordId,
    verdict,
    confidence,
    reasoning,
    sourcesChecked,
  };

  const response = await apiRequest<{ ok: boolean }>(
    'POST',
    '/api/record-verifications/verdicts',
    body,
  );

  if (!response.ok) {
    console.warn(`[verify] Failed to store verdict for ${recordType}/${recordId}: ${response.error}`);
  }

  // Also sync to the things table so verdicts appear on the Things dashboard
  await syncVerdictToThings(recordType, recordId, verdict, confidence, reasoning, sourcesChecked)
    .catch((e: unknown) => {
      console.warn(`[verify] Things sync failed: ${e instanceof Error ? e.message : String(e)}`);
    });
}

// ── Stats command ────────────────────────────────────────────────────

async function statsCommand(): Promise<CommandResult> {
  const response = await apiRequest<{
    total_records: number;
    by_verdict: Record<string, number>;
    by_type: Record<string, number>;
    needs_recheck: number;
    avg_confidence: number;
  }>('GET', '/api/record-verifications/stats');

  if (!response.ok) {
    return { exitCode: 1, output: `Failed to fetch stats: ${response.error}` };
  }

  const stats = response.data;
  const lines: string[] = [];
  lines.push('\x1b[1m═══ Record Verification Stats ═══\x1b[0m');
  lines.push(`Total records with verdicts: ${stats.total_records}`);
  lines.push(`Average confidence: ${(stats.avg_confidence * 100).toFixed(0)}%`);
  lines.push(`Needs recheck: ${stats.needs_recheck}`);
  lines.push('');

  lines.push('\x1b[1mBy verdict:\x1b[0m');
  for (const [verdict, cnt] of Object.entries(stats.by_verdict)) {
    const color = verdict === 'confirmed' ? '\x1b[32m' : verdict === 'contradicted' ? '\x1b[31m' : '\x1b[33m';
    lines.push(`  ${color}${verdict.padEnd(15)}\x1b[0m ${cnt}`);
  }
  lines.push('');

  lines.push('\x1b[1mBy record type:\x1b[0m');
  for (const [type, cnt] of Object.entries(stats.by_type)) {
    lines.push(`  ${type.padEnd(20)} ${cnt}`);
  }

  // Also show how many records have source URLs (potential for verification)
  lines.push('');
  lines.push('\x1b[1mVerification coverage:\x1b[0m');
  for (const recordType of VALID_RECORD_TYPES) {
    try {
      const records = await fetchRecords(recordType);
      const withSource = records.length;
      const verified = stats.by_type[recordType] ?? 0;
      const pct = withSource > 0 ? Math.round((verified / withSource) * 100) : 0;
      lines.push(`  ${recordType.padEnd(20)} ${verified}/${withSource} (${pct}%)`);
    } catch {
      lines.push(`  ${recordType.padEnd(20)} (fetch failed)`);
    }
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Sync-things command ──────────────────────────────────────────────

async function syncThingsCommand(): Promise<CommandResult> {
  // Fetch all existing record verdicts with pagination
  const allVerdicts: Array<{
    recordType: string;
    recordId: string;
    verdict: string;
    confidence: number | null;
    reasoning: string | null;
    sourcesChecked: number | null;
  }> = [];

  const PAGE_SIZE = 200;
  let offset = 0;

  while (true) {
    const response = await apiRequest<{
      verdicts: Array<{
        recordType: string;
        recordId: string;
        verdict: string;
        confidence: number | null;
        reasoning: string | null;
        sourcesChecked: number | null;
      }>;
      total: number;
    }>('GET', `/api/record-verifications/verdicts?limit=${PAGE_SIZE}&offset=${offset}`);

    if (!response.ok || !response.data) {
      return { exitCode: 1, output: `Failed to fetch verdicts: ${response.error}` };
    }

    allVerdicts.push(...response.data.verdicts);

    if (response.data.verdicts.length < PAGE_SIZE || allVerdicts.length >= response.data.total) {
      break;
    }
    offset += PAGE_SIZE;
  }

  const verdicts = allVerdicts;
  if (verdicts.length === 0) {
    return { exitCode: 0, output: 'No record verdicts to sync.' };
  }

  console.log(`Syncing ${verdicts.length} verdict(s) to things table...`);

  let synced = 0;
  let failed = 0;

  for (const v of verdicts) {
    const recordType = v.recordType as RecordType;
    const thingId = await lookupThingId(recordType, v.recordId);
    if (!thingId) {
      failed++;
      continue;
    }

    const result = await apiRequest<{ thingId: string }>(
      'POST',
      '/api/things/verdicts',
      {
        thingId,
        verdict: v.verdict,
        confidence: v.confidence ?? undefined,
        reasoning: v.reasoning ?? undefined,
        sourcesChecked: v.sourcesChecked ?? 0,
      },
    );

    if (result.ok) {
      synced++;
      console.log(`  synced ${v.recordType}/${v.recordId} → ${thingId} (${v.verdict})`);
    } else {
      failed++;
      console.warn(`  failed ${v.recordType}/${v.recordId}: ${result.error}`);
    }
  }

  return {
    exitCode: 0,
    output: `\nSynced ${synced} verdict(s) to things table. ${failed} failed/skipped.`,
  };
}

// ── Main command ─────────────────────────────────────────────────────

export async function recordsVerifyCommand(
  args: string[],
  options: VerifyCommandOptions,
): Promise<CommandResult> {
  const subcommand = args.find(a => !a.startsWith('--'));

  // Stats subcommand
  if (subcommand === 'stats') {
    return statsCommand();
  }

  // Sync-things subcommand
  if (subcommand === 'sync-things') {
    return syncThingsCommand();
  }

  const isDryRun = options['dry-run'] || options.dryRun;

  // Determine which record types to verify
  let typesToVerify: RecordType[];
  if (options.type) {
    if (!VALID_RECORD_TYPES.includes(options.type as RecordType)) {
      return {
        exitCode: 1,
        output: `Invalid record type: ${options.type}\nValid types: ${VALID_RECORD_TYPES.join(', ')}`,
      };
    }
    typesToVerify = [options.type as RecordType];
  } else if (subcommand && subcommand !== 'stats') {
    // Allow plural or singular form: "grants" → "grant", "personnel" → "personnel"
    const typeMap: Record<string, RecordType> = {
      grant: 'grant',
      grants: 'grant',
      personnel: 'personnel',
      division: 'division',
      divisions: 'division',
      'funding-program': 'funding-program',
      'funding-programs': 'funding-program',
      'funding-round': 'funding-round',
      'funding-rounds': 'funding-round',
      investment: 'investment',
      investments: 'investment',
      'equity-position': 'equity-position',
      'equity-positions': 'equity-position',
    };
    const mapped = typeMap[subcommand];
    if (!mapped) {
      return {
        exitCode: 1,
        output: `Unknown subcommand: ${subcommand}\nUsage: crux verify <type|stats> [options]\nTypes: ${VALID_RECORD_TYPES.join(', ')}`,
      };
    }
    typesToVerify = [mapped];
  } else {
    typesToVerify = [...VALID_RECORD_TYPES];
  }

  // Collect records to verify
  const allRecords: RecordToVerify[] = [];
  for (const recordType of typesToVerify) {
    console.log(`Fetching ${recordType} records...`);
    const records = await fetchRecords(recordType, options.entity);
    allRecords.push(...records);
  }

  const limit = options.limit ? parseInt(String(options.limit), 10) : undefined;
  const recordsToVerify = limit && limit > 0 ? allRecords.slice(0, limit) : allRecords;

  if (recordsToVerify.length === 0) {
    return { exitCode: 0, output: 'No records with source URLs found to verify.' };
  }

  // Dry run
  if (isDryRun) {
    const lines: string[] = [];
    lines.push(`\x1b[1mDry run: ${recordsToVerify.length} record(s) would be verified\x1b[0m`);
    lines.push('');

    const header = `${'Type'.padEnd(18)} ${'ID'.padEnd(12)} ${'Description'.padEnd(50)} Source`;
    lines.push(`\x1b[1m${header}\x1b[0m`);
    lines.push('-'.repeat(120));

    for (const record of recordsToVerify) {
      const desc = record.description.length > 48 ? record.description.slice(0, 47) + '…' : record.description;
      const src = record.sourceUrl.length > 50 ? record.sourceUrl.slice(0, 49) + '…' : record.sourceUrl;
      lines.push(`${record.recordType.padEnd(18)} ${record.recordId.padEnd(12)} ${desc.padEnd(50)} ${src}`);
    }

    lines.push('');

    // Summary by type
    const typeCounts = new Map<string, number>();
    for (const r of recordsToVerify) {
      typeCounts.set(r.recordType, (typeCounts.get(r.recordType) ?? 0) + 1);
    }
    lines.push('By type:');
    for (const [type, cnt] of typeCounts) {
      lines.push(`  ${type}: ${cnt}`);
    }

    lines.push('');
    lines.push('Use without --dry-run to run verification with LLM.');

    if (options.ci) {
      return { exitCode: 0, output: JSON.stringify(recordsToVerify) };
    }

    return { exitCode: 0, output: lines.join('\n') };
  }

  // Live run
  const client = createLlmClient();
  const summary = {
    total: recordsToVerify.length,
    confirmed: 0,
    contradicted: 0,
    unverifiable: 0,
    outdated: 0,
    partial: 0,
    errors: 0,
    results: [] as VerificationResult[],
    failures: [] as VerificationError[],
  };

  console.log(`\x1b[1mVerifying ${recordsToVerify.length} record(s)...\x1b[0m`);

  for (let i = 0; i < recordsToVerify.length; i++) {
    const record = recordsToVerify[i];
    console.log(`  [${i + 1}/${recordsToVerify.length}] ${record.description}`);

    const result = await verifySingleRecord(record, client);

    if ('error' in result) {
      summary.errors++;
      summary.failures.push(result);
      const typeTag = result.errorType ? ` [${result.errorType}]` : '';
      console.log(`    \x1b[31m✗ Error${typeTag}: ${result.error}\x1b[0m`);
    } else {
      summary[result.verdict]++;
      summary.results.push(result);
      const color = result.verdict === 'confirmed'
        ? '\x1b[32m'
        : result.verdict === 'contradicted'
          ? '\x1b[31m'
          : '\x1b[33m';
      console.log(`    ${color}${result.verdict}\x1b[0m (confidence: ${(result.confidence * 100).toFixed(0)}%)`);
      if (result.verdict === 'contradicted' || result.verdict === 'outdated') {
        console.log(`    Source says: ${result.extractedValue.slice(0, 100)}`);
      }

      // Store result — await to avoid data loss on process exit
      await storeVerificationResult(result).catch((e: unknown) => {
        console.warn(`[verify] Failed to store: ${e instanceof Error ? e.message : String(e)}`);
      });

      // Store aggregate verdict
      await storeAggregateVerdict(
        result.recordType,
        result.recordId,
        result.verdict,
        result.confidence,
        result.reasoning,
        1,
      ).catch((e: unknown) => {
        console.warn(`[verify] Failed to store verdict: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }

  // Build output
  if (options.ci) {
    return {
      exitCode: summary.contradicted > 0 ? 1 : 0,
      output: JSON.stringify(summary),
    };
  }

  const lines: string[] = [];
  lines.push('');
  lines.push('\x1b[1m═══ Record Verification Summary ═══\x1b[0m');
  lines.push(`Total checked:  ${summary.total}`);
  lines.push(`\x1b[32mConfirmed:      ${summary.confirmed}\x1b[0m`);
  lines.push(`\x1b[31mContradicted:   ${summary.contradicted}\x1b[0m`);
  lines.push(`\x1b[33mUnverifiable:   ${summary.unverifiable}\x1b[0m`);
  lines.push(`\x1b[33mOutdated:       ${summary.outdated}\x1b[0m`);
  lines.push(`\x1b[33mPartial:        ${summary.partial}\x1b[0m`);
  lines.push(`\x1b[31mErrors:         ${summary.errors}\x1b[0m`);

  // Contradictions detail
  const contradictions = summary.results.filter((r) => r.verdict === 'contradicted');
  if (contradictions.length > 0) {
    lines.push('');
    lines.push('\x1b[31m\x1b[1mContradictions:\x1b[0m');
    for (const c of contradictions) {
      lines.push(`  ${c.description} (${c.recordId})`);
      lines.push(`    Source says: ${c.extractedValue.slice(0, 200)}`);
      lines.push(`    Reason: ${c.reasoning}`);
      lines.push(`    URL: ${c.sourceUrl}`);
      lines.push('');
    }
  }

  // Outdated detail
  const outdated = summary.results.filter((r) => r.verdict === 'outdated');
  if (outdated.length > 0) {
    lines.push('');
    lines.push('\x1b[33m\x1b[1mOutdated:\x1b[0m');
    for (const o of outdated) {
      lines.push(`  ${o.description} (${o.recordId})`);
      lines.push(`    Source says: ${o.extractedValue.slice(0, 200)}`);
      lines.push('');
    }
  }

  // Error breakdown
  if (summary.failures.length > 0) {
    lines.push('');
    lines.push('\x1b[31m\x1b[1mErrors:\x1b[0m');
    for (const f of summary.failures) {
      const typeTag = f.errorType ? ` [${f.errorType}]` : '';
      lines.push(`  ${f.recordType}/${f.recordId}:${typeTag} ${f.error}`);
    }

    const typeCounts = new Map<string, number>();
    for (const f of summary.failures) {
      const type = f.errorType ?? 'unknown';
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }
    if (typeCounts.size > 1) {
      lines.push('');
      lines.push('  Error breakdown:');
      for (const [type, cnt] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`    ${type}: ${cnt}`);
      }
    }
  }

  return {
    exitCode: summary.contradicted > 0 ? 1 : 0,
    output: lines.join('\n'),
  };
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: recordsVerifyCommand,
  stats: statsCommand,
};

export function getHelp(): string {
  return `
Record Verification — verify structured data against source URLs

Usage:
  crux verify <type>              Verify all records of a type with source URLs
  crux verify stats               Show verification coverage report
  crux verify sync-things         Sync existing verdicts to the Things dashboard
  crux verify grants              Verify all grants
  crux verify personnel           Verify all personnel records
  crux verify divisions           Verify all divisions
  crux verify funding-programs    Verify funding programs
  crux verify funding-rounds      Verify funding rounds
  crux verify investments         Verify investments
  crux verify equity-positions    Verify equity positions

Options:
  --type=X            Filter by record type
  --entity=X          Filter by entity (org or person stableId)
  --limit=N           Limit number of records to verify
  --dry-run           Show what would be checked without calling LLM
  --ci                JSON output

Examples:
  crux verify grants --dry-run             Preview which grants would be checked
  crux verify personnel --entity=anthropic Verify Anthropic personnel records
  crux verify stats                        Show verification coverage
  crux verify grants --limit=5             Verify 5 grants
  crux verify --dry-run                    Preview all record types
  crux verify sync-things                  Push all verdicts to Things dashboard
`;
}
