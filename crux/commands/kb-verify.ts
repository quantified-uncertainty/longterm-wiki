/**
 * KB Fact Verification Command
 *
 * Checks KB facts against their source URLs using an LLM.
 * For each fact with a source URL, fetches the source content (from DB cache
 * or directly), builds an LLM prompt, and parses the response to determine
 * whether the source confirms, contradicts, or doesn't address the claim.
 *
 * Usage:
 *   crux kb verify --entity=anthropic         Verify all facts for Anthropic
 *   crux kb verify --fact=f_dW5cR9mJ8q        Verify a single fact
 *   crux kb verify --dry-run                   Show what would be checked
 *   crux kb verify --limit=10                  Check at most 10 facts
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { formatFactValue } from '../../packages/kb/src/format.ts';
import type { Graph } from '../../packages/kb/src/graph.ts';
import type { Entity, Fact, Property } from '../../packages/kb/src/types.ts';
import { createLlmClient, callLlm, MODELS } from '../lib/llm.ts';
import { parseJsonResponse } from '../lib/anthropic.ts';
import { getCitationContentByUrl } from '../lib/wiki-server/citations.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import {
  detectPaywall,
  isUnverifiableDomain,
  classifyFetchError,
  type SourceFetchErrorType,
} from '../lib/search/paywall-detection.ts';
import { loadGraphFull, resolveEntity } from '../lib/kb-loader.ts';
import type { LoadedKB } from '../lib/kb-loader.ts';

// ── Constants ─────────────────────────────────────────────────────────

/** Max characters of source content to send to the LLM */
const MAX_CONTENT_LENGTH = 8000;
/** HTTP fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 15_000;

// ── Types ──────────────────────────────────────────────────────────────

interface VerifyCommandOptions extends BaseOptions {
  entity?: string;
  fact?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  limit?: string;
  ci?: boolean;
}

type VerificationVerdict = 'confirmed' | 'contradicted' | 'unverifiable' | 'outdated' | 'partial';

interface VerificationResult {
  factId: string;
  entityId: string;
  entityName: string;
  propertyId: string;
  propertyName: string;
  formattedValue: string;
  sourceUrl: string;
  asOf?: string;
  verdict: VerificationVerdict;
  confidence: number;
  extractedValue: string;
  reasoning: string;
  /** Structured error type when source had issues (e.g., paywall) but content was still usable */
  errorType?: SourceFetchErrorType;
}

interface VerificationError {
  factId: string;
  entityId: string;
  propertyId: string;
  sourceUrl: string;
  error: string;
  /** Structured error type for machine-readable classification */
  errorType?: SourceFetchErrorType;
}

interface VerificationSummary {
  total: number;
  confirmed: number;
  contradicted: number;
  unverifiable: number;
  outdated: number;
  partial: number;
  errors: number;
  results: VerificationResult[];
  failures: VerificationError[];
}

// ── Helpers ────────────────────────────────────────────────────────────

// LoadedKB, loadGraphFull, resolveEntity imported from ../lib/kb-loader.ts

/** Result of fetching source content, with structured error info */
interface FetchSourceResult {
  content: string | null;
  errorType?: SourceFetchErrorType;
  errorMessage?: string;
}

/**
 * Fetch source content for a URL.
 *
 * Resolution order:
 *   1. Check for unverifiable domains (social media etc.)
 *   2. Try wiki-server citation_content cache (fullText field)
 *   3. Direct HTTP fetch with HTML tag stripping
 *   4. Detect paywall signals in fetched content
 *
 * Returns structured error types for machine-readable classification.
 */
async function fetchSourceContent(url: string): Promise<FetchSourceResult> {
  // SSRF protection: only allow https:// URLs (no http://, file://, ftp://, etc.)
  if (!url.startsWith('https://')) {
    console.warn(`[kb-verify] Skipping non-HTTPS URL: ${url}`);
    return { content: null, errorType: 'fetch_error', errorMessage: 'Non-HTTPS URL' };
  }

  // SSRF protection: block private/internal hosts
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host === '[::]' ||
      host === '::' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      // IPv4 private ranges
      /^10\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      // IPv6 private/reserved ranges
      /^fe80:/i.test(host) ||          // link-local
      /^f[cd][0-9a-f]{2}:/i.test(host) || // unique local (fc00::/7)
      /^::ffff:127\./i.test(host) ||   // IPv4-mapped loopback
      /^::ffff:10\./i.test(host) ||    // IPv4-mapped private
      /^::ffff:192\.168\./i.test(host) || // IPv4-mapped private
      /^::ffff:172\.(1[6-9]|2\d|3[01])\./i.test(host) || // IPv4-mapped private
      /^::ffff:169\.254\./i.test(host) // IPv4-mapped link-local
    ) {
      console.warn(`[kb-verify] Blocking private/internal URL: ${url}`);
      return { content: null, errorType: 'access_denied', errorMessage: 'Private/internal host blocked' };
    }
  } catch {
    return { content: null, errorType: 'fetch_error', errorMessage: 'Invalid URL' };
  }

  // Check for unverifiable domains (social media, etc.)
  if (isUnverifiableDomain(url)) {
    console.warn(`[kb-verify] Unverifiable domain: ${url}`);
    return { content: null, errorType: 'unverifiable_domain', errorMessage: 'Domain blocks automated access' };
  }

  // Try wiki-server citation_content cache first
  try {
    const result = await getCitationContentByUrl(url);
    if (result.ok && result.data) {
      // RPC type inference resolves to `never` because the route can return 400/404.
      // The actual shape includes fullText from the citation_content table row.
      const cached = result.data as Record<string, unknown>;
      const content = cached.fullText as string | null;
      if (content && content.length > 0) {
        // Check for paywall signals even in cached content
        if (detectPaywall(content)) {
          console.warn(`[kb-verify] Cached content for ${url} appears paywalled`);
          return { content: content.slice(0, MAX_CONTENT_LENGTH), errorType: 'paywall', errorMessage: 'Cached content appears paywalled' };
        }
        return { content: content.slice(0, MAX_CONTENT_LENGTH) };
      }
    }
  } catch (e: unknown) {
    // Wiki-server unavailable — fall back to direct fetch
    console.warn(`[kb-verify] Wiki-server cache miss for ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Direct fetch with timeout
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'LongtermWiki-FactChecker/1.0',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errorType = classifyFetchError(response.status, null, null, url);
      console.warn(`[kb-verify] HTTP ${response.status} for ${url}`);
      return { content: null, errorType: errorType ?? 'fetch_error', errorMessage: `HTTP ${response.status}` };
    }

    const html = await response.text();
    // Strip HTML tags for a basic text extraction
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
      .trim();

    const content = text.slice(0, MAX_CONTENT_LENGTH);

    // Detect paywall in fetched content
    if (detectPaywall(content)) {
      console.warn(`[kb-verify] Paywall detected for ${url}`);
      return { content, errorType: 'paywall', errorMessage: 'Content appears paywalled' };
    }

    return { content };
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      console.warn(`[kb-verify] Timeout fetching ${url}`);
      return { content: null, errorType: 'timeout', errorMessage: 'Request timed out' };
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[kb-verify] Failed to fetch ${url}: ${msg}`);
    return { content: null, errorType: 'fetch_error', errorMessage: msg };
  }
}

/**
 * Build the LLM verification prompt for a single fact.
 */
function buildVerificationPrompt(
  entity: Entity,
  fact: Fact,
  property: Property | undefined,
  formattedValue: string,
  sourceText: string,
): string {
  const propertyName = property?.name ?? fact.propertyId;
  const asOfStr = fact.asOf ? ` (as of ${fact.asOf})` : '';
  const notesStr = fact.notes ? `\nAdditional context: ${fact.notes}` : '';

  return `You are a fact-checker. Given the source text below, verify this claim.

Claim: ${entity.name}'s ${propertyName} = ${formattedValue}${asOfStr}${notesStr}

Source URL: ${fact.source}

Source text (excerpt):
---
${sourceText}
---

Does the source text confirm, contradict, or not address this claim?

Consider:
- Numbers may be expressed differently (e.g., "1 billion" vs "1e9" vs "$1B")
- Dates may be approximate
- The source may confirm the general fact but with a slightly different value
- If the source discusses the topic but the specific data point isn't mentioned, that's "unverifiable"
- If the source has a newer value that supersedes the claimed value, that's "outdated"
- If the source partially confirms (e.g., confirms the ballpark but not the exact figure), that's "partial"

Respond with ONLY a JSON object (no markdown code fences):
{
  "verdict": "confirmed|contradicted|unverifiable|outdated|partial",
  "confidence": 0.0 to 1.0,
  "extracted_value": "What the source actually says about this data point (quote or paraphrase)",
  "reasoning": "Brief explanation of your verdict"
}`;
}

/**
 * Verify a single fact against its source URL.
 */
async function verifySingleFact(
  entity: Entity,
  fact: Fact,
  graph: Graph,
  client: ReturnType<typeof createLlmClient>,
): Promise<VerificationResult | VerificationError> {
  const property = graph.getProperty(fact.propertyId);
  const formattedValue = formatFactValue(fact, property, graph);
  const sourceUrl = fact.source!;

  // Fetch source content
  const fetchResult = await fetchSourceContent(sourceUrl);
  if (!fetchResult.content) {
    return {
      factId: fact.id,
      entityId: entity.id,
      propertyId: fact.propertyId,
      sourceUrl,
      error: fetchResult.errorMessage ?? 'Could not fetch source content',
      errorType: fetchResult.errorType,
    };
  }

  // If content was fetched but has issues (e.g., paywall), still attempt
  // verification with the partial content — the LLM may still extract useful info.
  const sourceText = fetchResult.content;

  // Truncate source text for prompt
  const truncatedSource = sourceText.slice(0, 4000);

  const prompt = buildVerificationPrompt(entity, fact, property, formattedValue, truncatedSource);

  try {
    const result = await callLlm(client, prompt, {
      model: MODELS.haiku,
      maxTokens: 500,
      temperature: 0,
      retryLabel: `verify-fact-${fact.id}`,
    });

    const parsed = parseJsonResponse(result.text) as {
      verdict: string;
      confidence: number;
      extracted_value: string;
      reasoning: string;
    };

    const validVerdicts: VerificationVerdict[] = ['confirmed', 'contradicted', 'unverifiable', 'outdated', 'partial'];
    const verdict = validVerdicts.includes(parsed.verdict as VerificationVerdict)
      ? (parsed.verdict as VerificationVerdict)
      : 'unverifiable';

    return {
      factId: fact.id,
      entityId: entity.id,
      entityName: entity.name,
      propertyId: fact.propertyId,
      propertyName: property?.name ?? fact.propertyId,
      formattedValue,
      sourceUrl,
      asOf: fact.asOf,
      verdict,
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      extractedValue: parsed.extracted_value ?? '',
      reasoning: parsed.reasoning ?? '',
      ...(fetchResult.errorType && { errorType: fetchResult.errorType }),
    };
  } catch (e: unknown) {
    return {
      factId: fact.id,
      entityId: entity.id,
      propertyId: fact.propertyId,
      sourceUrl,
      error: `LLM call failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Store a verification result in the wiki-server database.
 * Best-effort: logs a warning on failure but does not block the pipeline.
 */
async function storeVerificationResult(result: VerificationResult): Promise<void> {
  const body = {
    factId: result.factId,
    verdict: result.verdict,
    confidence: result.confidence,
    extractedValue: result.extractedValue,
    checkerModel: 'claude-3-haiku', // matches MODELS.haiku used in verifySingleFact
    isPrimarySource: true,
    notes: result.reasoning,
    sourceUrl: result.sourceUrl,
  };

  const response = await apiRequest<{ id: number; verdictFlagged: boolean }>(
    'POST',
    '/api/kb-verifications/verifications',
    body,
  );

  if (!response.ok) {
    console.warn(`[kb-verify] Failed to store verification for ${result.factId}: ${response.error}`);
  }
}

/**
 * Collect facts to verify based on the command options.
 */
function collectFacts(
  kb: LoadedKB,
  options: VerifyCommandOptions,
): Array<{ entity: Entity; fact: Fact }> {
  const graph = kb.graph;
  const factsToVerify: Array<{ entity: Entity; fact: Fact }> = [];

  if (options.fact) {
    // Find a specific fact by ID
    for (const entity of graph.getAllEntities()) {
      const facts = graph.getFacts(entity.id);
      const match = facts.find((f: Fact) => f.id === options.fact);
      if (match) {
        if (match.source) {
          factsToVerify.push({ entity, fact: match });
        }
        break;
      }
    }
  } else if (options.entity) {
    // All facts for a specific entity (supports ID, filename, stableId, or name)
    const entity = resolveEntity(options.entity, kb);
    if (entity) {
      const facts = graph.getFacts(entity.id);
      for (const fact of facts) {
        if (fact.source && !fact.id.startsWith('inv_')) {
          factsToVerify.push({ entity, fact });
        }
      }
    }
  } else {
    // All facts across all entities
    for (const entity of graph.getAllEntities()) {
      const facts = graph.getFacts(entity.id);
      for (const fact of facts) {
        if (fact.source && !fact.id.startsWith('inv_')) {
          factsToVerify.push({ entity, fact });
        }
      }
    }
  }

  // Apply limit
  const limit = options.limit ? parseInt(String(options.limit), 10) : undefined;
  if (limit && limit > 0) {
    return factsToVerify.slice(0, limit);
  }

  return factsToVerify;
}

// ── Main command ───────────────────────────────────────────────────────

export async function verifyCommand(
  args: string[],
  options: VerifyCommandOptions,
): Promise<CommandResult> {
  const isDryRun = options['dry-run'] || options.dryRun;

  const kb = await loadGraphFull();
  const graph = kb.graph;
  const factsToVerify = collectFacts(kb, options);

  if (factsToVerify.length === 0) {
    const hint = options.entity
      ? `No facts with source URLs found for entity: ${options.entity}`
      : options.fact
        ? `Fact not found or has no source URL: ${options.fact}`
        : 'No facts with source URLs found in the KB.';
    return { exitCode: 0, output: hint };
  }

  // Dry run: just list what would be checked
  if (isDryRun) {
    const lines: string[] = [];
    lines.push(`\x1b[1mDry run: ${factsToVerify.length} fact(s) would be verified\x1b[0m`);
    lines.push('');

    const header = `${'Entity'.padEnd(24)} ${'Property'.padEnd(24)} ${'Value'.padEnd(20)} ${'As Of'.padEnd(12)} Source`;
    lines.push(`\x1b[1m${header}\x1b[0m`);
    lines.push('-'.repeat(100));

    for (const { entity, fact } of factsToVerify) {
      const property = graph.getProperty(fact.propertyId);
      const val = formatFactValue(fact, property, graph);
      const asOf = fact.asOf ?? '';
      const source = fact.source ?? '';
      // Truncate long values and URLs for display
      const valStr = val.length > 18 ? val.slice(0, 17) + '…' : val;
      const srcStr = source.length > 50 ? source.slice(0, 49) + '…' : source;
      lines.push(
        `${entity.name.slice(0, 23).padEnd(24)} ${(property?.name ?? fact.propertyId).slice(0, 23).padEnd(24)} ${valStr.padEnd(20)} ${asOf.padEnd(12)} ${srcStr}`,
      );
    }

    lines.push('');
    lines.push(`Use without --dry-run to run verification with LLM.`);

    if (options.ci) {
      const data = factsToVerify.map(({ entity, fact }) => ({
        factId: fact.id,
        entityId: entity.id,
        entityName: entity.name,
        propertyId: fact.propertyId,
        source: fact.source,
        asOf: fact.asOf,
      }));
      return { exitCode: 0, output: JSON.stringify(data) };
    }

    return { exitCode: 0, output: lines.join('\n') };
  }

  // Live run: verify facts with LLM
  const client = createLlmClient();
  const summary: VerificationSummary = {
    total: factsToVerify.length,
    confirmed: 0,
    contradicted: 0,
    unverifiable: 0,
    outdated: 0,
    partial: 0,
    errors: 0,
    results: [],
    failures: [],
  };

  console.log(`\x1b[1mVerifying ${factsToVerify.length} fact(s)...\x1b[0m`);

  for (let i = 0; i < factsToVerify.length; i++) {
    const { entity, fact } = factsToVerify[i];
    const property = graph.getProperty(fact.propertyId);
    const propName = property?.name ?? fact.propertyId;
    console.log(`  [${i + 1}/${factsToVerify.length}] ${entity.name} / ${propName} (${fact.id})`);

    const result = await verifySingleFact(entity, fact, graph, client);

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

      // Store result in wiki-server (best-effort, does not block pipeline)
      storeVerificationResult(result).catch((e: unknown) => {
        console.warn(`[kb-verify] Failed to store result for ${result.factId}: ${e instanceof Error ? e.message : String(e)}`);
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
  lines.push(`\x1b[1m═══ Verification Summary ═══\x1b[0m`);
  lines.push(`Total checked:  ${summary.total}`);
  lines.push(`\x1b[32mConfirmed:      ${summary.confirmed}\x1b[0m`);
  lines.push(`\x1b[31mContradicted:   ${summary.contradicted}\x1b[0m`);
  lines.push(`\x1b[33mUnverifiable:   ${summary.unverifiable}\x1b[0m`);
  lines.push(`\x1b[33mOutdated:       ${summary.outdated}\x1b[0m`);
  lines.push(`\x1b[33mPartial:        ${summary.partial}\x1b[0m`);
  lines.push(`\x1b[31mErrors:         ${summary.errors}\x1b[0m`);

  // Show contradictions in detail
  const contradictions = summary.results.filter((r) => r.verdict === 'contradicted');
  if (contradictions.length > 0) {
    lines.push('');
    lines.push(`\x1b[31m\x1b[1mContradictions:\x1b[0m`);
    for (const c of contradictions) {
      lines.push(`  ${c.entityName} / ${c.propertyName} (${c.factId})`);
      lines.push(`    Claimed: ${c.formattedValue}${c.asOf ? ` (as of ${c.asOf})` : ''}`);
      lines.push(`    Source:  ${c.extractedValue}`);
      lines.push(`    Reason:  ${c.reasoning}`);
      lines.push(`    URL:     ${c.sourceUrl}`);
      lines.push('');
    }
  }

  // Show outdated facts
  const outdated = summary.results.filter((r) => r.verdict === 'outdated');
  if (outdated.length > 0) {
    lines.push('');
    lines.push(`\x1b[33m\x1b[1mOutdated:\x1b[0m`);
    for (const o of outdated) {
      lines.push(`  ${o.entityName} / ${o.propertyName} (${o.factId})`);
      lines.push(`    Claimed: ${o.formattedValue}${o.asOf ? ` (as of ${o.asOf})` : ''}`);
      lines.push(`    Source:  ${o.extractedValue}`);
      lines.push('');
    }
  }

  // Show errors grouped by type
  if (summary.failures.length > 0) {
    lines.push('');
    lines.push(`\x1b[31m\x1b[1mErrors:\x1b[0m`);
    for (const f of summary.failures) {
      const typeTag = f.errorType ? ` [${f.errorType}]` : '';
      lines.push(`  ${f.factId} (${f.entityId} / ${f.propertyId}):${typeTag} ${f.error}`);
    }

    // Show error type breakdown
    const typeCounts = new Map<string, number>();
    for (const f of summary.failures) {
      const type = f.errorType ?? 'unknown';
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }
    if (typeCounts.size > 1) {
      lines.push('');
      lines.push('  Error breakdown:');
      for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`    ${type}: ${count}`);
      }
    }
  }

  return {
    exitCode: summary.contradicted > 0 ? 1 : 0,
    output: lines.join('\n'),
  };
}
