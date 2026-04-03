/**
 * Per-Entity Verification Command
 *
 * Discovers all verifiable claims about a specific entity (FactBase facts +
 * TableBase records), verifies each against its source, stores evidence,
 * and computes aggregate verdicts.
 *
 * Usage:
 *   crux verify <entity>                           Verify all claims for an entity
 *   crux verify <entity> --dry-run                 Preview what would be verified
 *   crux verify <entity> --budget=5                Limit spending to ~$5
 *   crux verify <entity> --type=fact               Only verify FactBase facts
 *   crux verify <entity> --type=record             Only verify TableBase records
 *   crux verify stats                              Show verification stats
 *   crux verify all --budget=10 --limit=100        Verify across all entities
 */

import type { CommandResult } from '../lib/command-types.ts';
import { loadDatabase } from '../lib/content-types.ts';
import { loadGraphFull } from '../lib/factbase-loader.ts';
// Graph.getFacts() returns typed Fact objects with propertyId, subjectId, etc.
import { formatFactValue } from '../../packages/factbase/src/format.ts';
import { createLlmClient, callLlm, MODELS } from '../lib/llm.ts';
import { CostTracker } from '../lib/cost-tracker.ts';
import { parseJsonResponse } from '../lib/anthropic.ts';
import { storeEvidence as storeEvidenceApi, storeVerdict as storeVerdictApi, getVerificationStats } from '../lib/wiki-server/verifications.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { fetchSourceContent as fetchCachedContent } from '../lib/source-check/source-fetcher.ts';
import type { VerificationVerdict } from '../../apps/wiki-server/src/api-types.ts';

// ── Constants ────────────────────────────────────────────────────────

const PROMPT_CONTENT_LENGTH = 4000;
const DEFAULT_BUDGET = 5;
const DEFAULT_LIMIT = 50;

// ── Types ────────────────────────────────────────────────────────────

interface VerifiableClaim {
  recordType: string;      // 'fact', 'grant', 'personnel', 'division', etc.
  recordId: string;        // PK in the source table
  fieldName?: string;      // specific field for cell-level verification
  entityId: string;        // entity this claim is about
  description: string;     // human-readable claim text
  sourceUrl: string;       // URL to verify against
  expectedValue?: string;  // what the record says
}

interface VerificationResult {
  claim: VerifiableClaim;
  verdict: VerificationVerdict;
  confidence: number;
  extractedValue: string;
  reasoning: string;
}

interface VerificationError {
  claim: VerifiableClaim;
  error: string;
  errorType?: string;
}

// ── Source fetching ──────────────────────────────────────────────────

/**
 * Thin wrapper around the shared cache-only fetchSourceContent.
 * Adapts the FetchSourceResult type to the { text } | { error, errorType } union
 * expected by the verify-entity pipeline.
 */
async function fetchSourceContent(url: string): Promise<{ text: string } | { error: string; errorType: string }> {
  const result = await fetchCachedContent(url, undefined, '[verify]');
  if (result.content) {
    return { text: result.content };
  }
  return { error: result.errorMessage ?? 'Source content not available', errorType: result.errorType ?? 'fetch_error' };
}

// ── Claim discovery ─────────────────────────────────────────────────

async function discoverFactClaims(entityId: string): Promise<VerifiableClaim[]> {
  const claims: VerifiableClaim[] = [];

  try {
    const { graph, idByFilename } = await loadGraphFull();
    // Try direct lookup by stableId first
    let fbEntity = graph.getEntity(entityId);
    if (!fbEntity) {
      // Try by filename/slug (e.g. "anthropic" → stableId from anthropic.yaml)
      const stableIdFromSlug = idByFilename.get(entityId);
      if (stableIdFromSlug) {
        fbEntity = graph.getEntity(stableIdFromSlug);
      }
    }
    if (!fbEntity) {
      // Scan by name as last resort
      for (const e of graph.getAllEntities()) {
        if (e.name?.toLowerCase() === entityId.toLowerCase()) {
          fbEntity = e;
          break;
        }
      }
    }
    if (!fbEntity) return claims;

    const facts = graph.getFacts(fbEntity.id);
    for (const fact of facts) {
      if (!fact.source) continue;
      const property = graph.getProperty(fact.propertyId);
      const value = formatFactValue(fact, property, graph);
      claims.push({
        recordType: 'fact',
        recordId: fact.id,
        entityId: fbEntity.id,
        description: `${fbEntity.name ?? 'unknown'} — ${fact.propertyId}: ${value}`,
        sourceUrl: fact.source,
        expectedValue: value,
      });
    }
  } catch (e) {
    console.warn(`[verify] Could not load FactBase: ${e instanceof Error ? e.message : String(e)}`);
  }

  return claims;
}

async function discoverRecordClaims(entityId: string): Promise<VerifiableClaim[]> {
  const claims: VerifiableClaim[] = [];

  // Resolve entity identifier to stableId for API calls
  const db = loadDatabase();
  const entities = db.typedEntities ?? db.entities ?? [];
  const entity = entities.find(
    (e) =>
      e.id === entityId ||
      'stableId' in e && (e as { stableId?: string }).stableId === entityId ||
      e.wikiId === entityId
  );
  if (!entity) return claims;

  const stableId = ('stableId' in entity ? (entity as { stableId?: string }).stableId : undefined) ?? entityId;

  // Fetch records from various TableBase endpoints
  const endpoints: Array<{ type: string; path: string; descFn: (r: Record<string, unknown>) => string; sourceField?: string }> = [
    {
      type: 'personnel',
      path: `/api/personnel/by-entity/${encodeURIComponent(stableId)}`,
      descFn: (r) => `${r.displayName ?? r.personName} — ${r.role} at ${r.organizationName ?? entity.title}`,
    },
    {
      type: 'grant',
      path: `/api/grants/by-entity/${encodeURIComponent(stableId)}`,
      descFn: (r) => `Grant: ${r.funderName} → ${r.recipientName}: $${r.amount}`,
    },
    {
      type: 'division',
      path: `/api/divisions/by-org/${encodeURIComponent(stableId)}`,
      descFn: (r) => `Division: ${r.name} (${r.divisionType})`,
    },
  ];

  for (const ep of endpoints) {
    try {
      const result = await apiRequest<Record<string, unknown>[]>('GET', ep.path);
      if (!result.ok || !result.data) continue;

      const records = Array.isArray(result.data) ? result.data : [];
      for (const record of records) {
        const source = (record.source ?? record.sourceUrl) as string | undefined;
        if (!source) continue;

        claims.push({
          recordType: ep.type,
          recordId: record.id as string,
          entityId: stableId,
          description: ep.descFn(record),
          sourceUrl: source,
          expectedValue: JSON.stringify(record).slice(0, 500),
        });
      }
    } catch (e) {
      console.warn(`[verify] Could not fetch ${ep.type} records: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return claims;
}

// ── LLM verification ────────────────────────────────────────────────

async function verifyClaim(
  claim: VerifiableClaim,
  sourceText: string,
  client: ReturnType<typeof createLlmClient>,
  tracker: CostTracker,
): Promise<VerificationResult | VerificationError> {
  const prompt = `You are a fact-checker. Given the source text below, verify this claim.

Claim: ${claim.description}
${claim.expectedValue ? `Expected value: ${claim.expectedValue}` : ''}

Source URL: ${claim.sourceUrl}
Source text (excerpt):
${sourceText.slice(0, PROMPT_CONTENT_LENGTH)}

Does the source confirm, contradict, not address, show outdated info, or partially confirm this claim?

Respond with ONLY a JSON object:
{
  "verdict": "confirmed" | "contradicted" | "unverifiable" | "outdated" | "partial",
  "confidence": 0.0 to 1.0,
  "extracted_value": "What the source actually says (brief)",
  "reasoning": "Brief explanation of your assessment"
}`;

  try {
    const result = await callLlm(client, prompt, {
      model: MODELS.haiku,
      maxTokens: 500,
      temperature: 0,
      tracker,
      label: 'verify-claim',
    });

    const parsed = parseJsonResponse(result.text) as {
      verdict?: VerificationVerdict;
      confidence?: number;
      extracted_value?: string;
      reasoning?: string;
    } | null;

    if (!parsed || !parsed.verdict) {
      return { claim, error: 'Failed to parse LLM response', errorType: 'parse_error' };
    }

    return {
      claim,
      verdict: parsed.verdict,
      confidence: parsed.confidence ?? 0.5,
      extractedValue: parsed.extracted_value ?? '',
      reasoning: parsed.reasoning ?? '',
    };
  } catch (e) {
    return {
      claim,
      error: e instanceof Error ? e.message : String(e),
      errorType: 'llm_error',
    };
  }
}

// ── Storage ─────────────────────────────────────────────────────────

async function storeEvidence(result: VerificationResult): Promise<void> {
  await storeEvidenceApi({
      recordType: result.claim.recordType,
      recordId: result.claim.recordId,
      fieldName: result.claim.fieldName ?? null,
      entityId: result.claim.entityId,
      expectedValue: result.claim.expectedValue,
      sourceUrl: result.claim.sourceUrl,
      verdict: result.verdict,
      confidence: result.confidence,
      extractedValue: result.extractedValue,
      checkerModel: MODELS.haiku,
      isPrimarySource: true,
      notes: result.reasoning,
    },
  ).then(
    (res) => { if (!res.ok) console.warn(`[verify] Evidence storage failed: ${res.error}`); },
    (e: unknown) => console.warn(`[verify] Evidence storage error: ${e instanceof Error ? e.message : String(e)}`),
  );
}

async function storeAggregateVerdict(
  recordType: string,
  recordId: string,
  entityId: string,
  verdict: VerificationVerdict,
  confidence: number,
  reasoning: string,
): Promise<void> {
  await storeVerdictApi({
      recordType,
      recordId,
      entityId,
      verdict,
      confidence,
      reasoning,
      sourcesChecked: 1,
    },
  ).then(
    (res) => { if (!res.ok) console.warn(`[verify] Verdict storage failed: ${res.error}`); },
    (e: unknown) => console.warn(`[verify] Verdict storage error: ${e instanceof Error ? e.message : String(e)}`),
  );
}

// ── Main command ────────────────────────────────────────────────────

const c = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m',
};

async function statsCommand(): Promise<CommandResult> {
  const response = await getVerificationStats();

  if (!response.ok) {
    return { exitCode: 1, output: `Failed to fetch stats: ${response.error}` };
  }

  const stats = response.data;
  const lines: string[] = [];
  lines.push(`${c.bold}Verification Stats${c.reset}`);
  lines.push(`Total verdicts: ${stats.total}`);
  lines.push(`Average confidence: ${(stats.avg_confidence * 100).toFixed(0)}%`);
  lines.push(`Needs recheck: ${stats.needs_recheck}`);
  lines.push('');
  lines.push(`${c.bold}By verdict:${c.reset}`);
  for (const [verdict, cnt] of Object.entries(stats.by_verdict)) {
    const color = verdict === 'confirmed' ? c.green : verdict === 'contradicted' ? c.red : c.yellow;
    lines.push(`  ${color}${verdict.padEnd(15)}${c.reset} ${cnt}`);
  }
  lines.push('');
  lines.push(`${c.bold}By record type:${c.reset}`);
  for (const [type, cnt] of Object.entries(stats.by_type)) {
    lines.push(`  ${type.padEnd(20)} ${cnt}`);
  }

  return { exitCode: 0, output: lines.join('\n') };
}

async function verifyEntityCommand(
  entityId: string,
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const isDryRun = Boolean(options['dry-run'] || options.dryRun);
  const budgetLimit = options.budget ? parseFloat(String(options.budget)) : DEFAULT_BUDGET;
  const itemLimit = options.limit ? parseInt(String(options.limit), 10) : DEFAULT_LIMIT;
  const typeFilter = options.type as string | undefined;

  console.log(`${c.bold}Verifying entity: ${entityId}${c.reset}`);
  console.log(`Budget: $${budgetLimit.toFixed(2)} | Limit: ${itemLimit} items | Type: ${typeFilter ?? 'all'}`);
  console.log('');

  // Discover claims
  console.log('Discovering verifiable claims...');
  const claims: VerifiableClaim[] = [];

  if (!typeFilter || typeFilter === 'fact' || typeFilter === 'all') {
    const factClaims = await discoverFactClaims(entityId);
    claims.push(...factClaims);
    console.log(`  FactBase facts: ${factClaims.length}`);
  }

  if (!typeFilter || typeFilter === 'record' || typeFilter === 'all') {
    const recordClaims = await discoverRecordClaims(entityId);
    claims.push(...recordClaims);
    console.log(`  TableBase records: ${recordClaims.length}`);
  }

  if (claims.length === 0) {
    return { exitCode: 0, output: 'No verifiable claims found for this entity.' };
  }

  // Apply limits
  const estimatedCostPerItem = 0.005; // ~$0.005 per Haiku call
  const maxByBudget = Math.floor(budgetLimit / estimatedCostPerItem);
  const effectiveLimit = Math.min(claims.length, itemLimit, maxByBudget);
  const toVerify = claims.slice(0, effectiveLimit);

  console.log(`\nTotal claims: ${claims.length} | Verifying: ${toVerify.length} (est. $${(toVerify.length * estimatedCostPerItem).toFixed(2)})`);

  if (isDryRun) {
    const lines = [`\n${c.bold}DRY RUN — Claims that would be verified:${c.reset}\n`];
    for (const claim of toVerify) {
      lines.push(`  [${claim.recordType}] ${claim.description}`);
      lines.push(`    ${c.dim}Source: ${claim.sourceUrl}${c.reset}`);
    }
    lines.push(`\nSkipped: ${claims.length - toVerify.length} (over limit/budget)`);
    return { exitCode: 0, output: lines.join('\n') };
  }

  // Execute verification
  const client = createLlmClient();
  const tracker = new CostTracker();
  const results: VerificationResult[] = [];
  const errors: VerificationError[] = [];

  for (let i = 0; i < toVerify.length; i++) {
    const claim = toVerify[i];
    const progress = `[${i + 1}/${toVerify.length}]`;
    process.stdout.write(`  ${progress} ${claim.recordType.padEnd(10)} ${claim.description.slice(0, 70)}... `);

    // Check budget
    if (tracker.totalCost > budgetLimit) {
      console.log(`\n${c.yellow}Budget limit reached ($${tracker.totalCost.toFixed(3)} > $${budgetLimit})${c.reset}`);
      break;
    }

    // Fetch source
    const sourceResult = await fetchSourceContent(claim.sourceUrl);
    if ('error' in sourceResult) {
      errors.push({ claim, error: sourceResult.error, errorType: sourceResult.errorType });
      console.log(`${c.yellow}SKIP${c.reset} (${sourceResult.errorType})`);
      continue;
    }

    // Verify via LLM
    const result = await verifyClaim(claim, sourceResult.text, client, tracker);
    if ('error' in result) {
      errors.push(result);
      console.log(`${c.red}ERROR${c.reset}`);
      continue;
    }

    results.push(result);
    const verdictColor = result.verdict === 'confirmed' ? c.green
      : result.verdict === 'contradicted' ? c.red
      : c.yellow;
    console.log(`${verdictColor}${result.verdict}${c.reset} (${(result.confidence * 100).toFixed(0)}%)`);

    // Store evidence + aggregate verdict
    await storeEvidence(result);
    await storeAggregateVerdict(
      claim.recordType, claim.recordId, claim.entityId,
      result.verdict, result.confidence, result.reasoning,
    );
  }

  // Summary
  const lines: string[] = [];
  lines.push('');
  lines.push(`${c.bold}Verification Summary${c.reset}`);
  lines.push(`Entity: ${entityId}`);
  lines.push(`Verified: ${results.length} | Errors: ${errors.length} | Cost: $${tracker.totalCost.toFixed(3)}`);
  lines.push('');

  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);

  for (const [verdict, count] of [...counts.entries()].sort(([, a], [, b]) => b - a)) {
    const color = verdict === 'confirmed' ? c.green : verdict === 'contradicted' ? c.red : c.yellow;
    lines.push(`  ${color}${verdict.padEnd(15)}${c.reset} ${count}`);
  }

  if (errors.length > 0) {
    lines.push('');
    lines.push(`${c.bold}Errors:${c.reset}`);
    const errorCounts = new Map<string, number>();
    for (const e of errors) errorCounts.set(e.errorType ?? 'unknown', (errorCounts.get(e.errorType ?? 'unknown') ?? 0) + 1);
    for (const [type, count] of errorCounts) {
      lines.push(`  ${c.yellow}${type.padEnd(20)}${c.reset} ${count}`);
    }
  }

  const avgConfidence = results.length > 0
    ? results.reduce((s, r) => s + r.confidence, 0) / results.length
    : 0;
  lines.push('');
  lines.push(`Average confidence: ${(avgConfidence * 100).toFixed(0)}%`);

  const contradicted = counts.get('contradicted') ?? 0;
  return { exitCode: contradicted > 0 ? 1 : 0, output: lines.join('\n') };
}

// ── CLI entry point ─────────────────────────────────────────────────

export const commands = {
  default: async (args: string[], options: Record<string, unknown>): Promise<CommandResult> => {
    const subcommand = args[0];

    if (!subcommand || subcommand === '--help') {
      return {
        exitCode: 0,
        output: `${c.bold}Verification Pipeline${c.reset}

Verify claims about entities against their sources using LLMs.

${c.bold}Usage:${c.reset}
  crux verify <entity>                     Verify all claims for an entity
  crux verify <entity> --dry-run           Preview what would be verified
  crux verify <entity> --budget=5          Limit spending (default: $5)
  crux verify <entity> --limit=50          Max items to verify (default: 50)
  crux verify <entity> --type=fact         Only verify FactBase facts
  crux verify <entity> --type=record       Only verify TableBase records
  crux verify stats                        Show verification stats
  crux verify all --budget=10              Verify across all entities (uses orchestrator)

${c.bold}Examples:${c.reset}
  crux verify anthropic                    Verify Anthropic's facts and records
  crux verify anthropic --type=fact        Only verify Anthropic's FactBase facts
  crux verify anthropic --dry-run          See what would be verified
  crux verify page <page-id>               Verify wiki page prose (cited vs uncited claims)
  crux verify page <page-id> --quick       Just count cited vs uncited (no web search)
  crux verify page <page-id> --deep        Also verify uncited claims against web
  crux verify page <page-id> --fix         Add citations to uncited claims (surgical)
  crux verify page <page-id> --fix --dry-run  Preview what citations would be added
  crux verify page --all                   Fast citation density audit across all pages
  crux verify page --all --limit=100       Show top 100 worst-cited pages
  crux verify stats                        Show overall verification statistics`,
      };
    }

    if (subcommand === 'stats') {
      return statsCommand();
    }

    if (subcommand === 'page') {
      const pageId = args[1];
      if (options.all || pageId === '--all') {
        const { auditAllPagesCommand } = await import('./verify-page.ts');
        return auditAllPagesCommand(options);
      }
      if (!pageId) {
        return { exitCode: 1, output: 'Usage: crux verify page <page-id> [--quick|--deep|--fix]\n       crux verify page --all' };
      }
      if (options.fix) {
        const { addCitationsCommand } = await import('./add-citations.ts');
        return addCitationsCommand(pageId, options);
      }
      const { verifyPageCommand } = await import('./verify-page.ts');
      return verifyPageCommand(pageId, options);
    }

    if (subcommand === 'all') {
      // Delegate to the orchestrator for cross-entity verification
      const { orchestrateCommand } = await import('./source-check-orchestrate.ts');
      return orchestrateCommand(args.slice(1), options);
    }

    // Per-entity verification
    return verifyEntityCommand(subcommand, options);
  },

  stats: async (): Promise<CommandResult> => statsCommand(),
};
