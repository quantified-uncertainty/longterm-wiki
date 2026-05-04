/**
 * FactBase Source-Check Command
 *
 * Checks KB facts against their source URLs using an LLM.
 * For each fact with a source URL, reads cached content from citation_content
 * (populated by the resource-ingest worker), builds an LLM prompt, and parses
 * the response to determine whether the source confirms, contradicts, or
 * doesn't address the claim.
 *
 * Usage:
 *   crux fb sourcing --entity=anthropic         Check all facts for Anthropic
 *   crux fb sourcing --fact=f_dW5cR9mJ8q        Check a single fact
 *   crux fb sourcing --dry-run                   Show what would be checked
 *   crux fb sourcing --limit=10                  Check at most 10 facts
 *   crux fb sourcing --where-no-verdict --limit=50
 *                                                 (QUA-851) Skip facts that
 *                                                 already have a row-level verdict.
 *                                                 Used by the multi-week backfill
 *                                                 to target only the ~1,353 facts
 *                                                 with no verdict at all.
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import type { SourcingVerdict } from '../../apps/wiki-server/src/api-types.ts';
import { formatFactValue } from '../../packages/factbase/src/format.ts';
import type { Graph } from '../../packages/factbase/src/graph.ts';
import type { Entity, Fact, Property } from '../../packages/factbase/src/types.ts';
import { createLlmClient, callLlm, MODELS } from '../lib/llm.ts';
import { parseJsonResponse } from '../lib/anthropic.ts';
import { storeSourcingEvidence, storeAggregateVerdict } from '../lib/sourcing/verdict-handler.ts';
import { fetchVerdictRecordIds } from '../lib/wiki-server/sourcing-client.ts';
import type { SourceFetchErrorType } from '../lib/search/paywall-detection.ts';
import { truncate } from '../lib/text-utils.ts';
import { fetchSourceContent } from '../lib/sourcing/source-fetcher.ts';
import {
  SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES,
  SOURCE_CHECK_ADDITIONAL_CONSIDERATIONS,
  SOURCE_CHECK_RESPONSE_FORMAT,
} from '../lib/sourcing/prompt-guidelines.ts';
import { SOURCE_CHECK_CONSTANTS } from '../lib/sourcing/types.ts';
import { loadGraphFull, resolveEntity } from '../lib/factbase-loader.ts';
import type { LoadedKB } from '../lib/factbase-loader.ts';

// ── Constants ─────────────────────────────────────────────────────────

/** Max characters of source content to retain after fetching */
const MAX_CONTENT_LENGTH = 500_000;
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
  /**
   * QUA-851: skip facts that already have a row-level verdict in
   * source_check_verdicts. Used by the multi-week backfill to avoid
   * re-checking the ~1,400 facts that are already verified and target
   * only the ~1,353 with no verdict at all.
   */
  'where-no-verdict'?: boolean;
  whereNoVerdict?: boolean;
}

interface SourcingResult {
  factId: string;
  entityId: string;
  entityName: string;
  propertyId: string;
  propertyName: string;
  formattedValue: string;
  sourceUrl: string;
  asOf?: string;
  verdict: SourcingVerdict;
  confidence: number;
  extractedValue: string;
  reasoning: string;
  /** Structured error type when source had issues (e.g., paywall) but content was still usable */
  errorType?: SourceFetchErrorType;
}

interface SourcingError {
  factId: string;
  entityId: string;
  propertyId: string;
  sourceUrl: string;
  error: string;
  /** Structured error type for machine-readable classification */
  errorType?: SourceFetchErrorType;
}

interface SourcingSummary {
  total: number;
  confirmed: number;
  contradicted: number;
  unverifiable: number;
  outdated: number;
  partial: number;
  /**
   * QUA-426: present for completeness so `summary[verdict]++` type-checks
   * over the full SourcingVerdict union. The factbase-sourcing path does
   * NOT run the relevance gate (gate only fires for record-kind items in
   * item-verifier.ts), so this counter should stay at 0 in practice.
   */
  not_applicable: number;
  errors: number;
  /**
   * Number of times the storage call (storeSourcingResult) failed for an
   * otherwise-successful verdict. Issue #4017. Drives a non-zero exit code.
   */
  storageErrors: number;
  results: SourcingResult[];
  failures: SourcingError[];
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Build the LLM sourcing prompt for a single fact.
 */
function buildSourcingPrompt(
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

${SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES}

${SOURCE_CHECK_ADDITIONAL_CONSIDERATIONS}

${SOURCE_CHECK_RESPONSE_FORMAT}`;
}

/**
 * Verify a single fact against its source URL.
 */
async function verifySingleFact(
  entity: Entity,
  fact: Fact,
  graph: Graph,
  client: ReturnType<typeof createLlmClient>,
): Promise<SourcingResult | SourcingError> {
  const property = graph.getProperty(fact.propertyId);
  const formattedValue = formatFactValue(fact, property, graph);
  const sourceUrl = fact.source!;

  // Fetch source content from citation_content cache (populated by resource-ingest worker)
  const fetchResult = await fetchSourceContent(sourceUrl, undefined, '[fb-sourcing]');
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
  // sourcing with the partial content — the LLM may still extract useful info.
  const sourceText = fetchResult.content;

  const truncatedSource = sourceText.slice(0, SOURCE_CHECK_CONSTANTS.PROMPT_CONTENT_LENGTH);

  const prompt = buildSourcingPrompt(entity, fact, property, formattedValue, truncatedSource);

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

    const validVerdicts: SourcingVerdict[] = ['confirmed', 'contradicted', 'unverifiable', 'outdated', 'partial'];
    const verdict = validVerdicts.includes(parsed.verdict as SourcingVerdict)
      ? (parsed.verdict as SourcingVerdict)
      : 'unverifiable';

    // Add archive provenance note to reasoning if verified via Wayback Machine
    let reasoning = parsed.reasoning ?? '';
    if (fetchResult.sourceOrigin === 'archive') {
      const dateNote = fetchResult.archiveDate ? ` (archived ${fetchResult.archiveDate})` : '';
      reasoning = `[archive${dateNote}] ${reasoning}`;
    }

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
      reasoning,
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
 * Store a sourcing result in the wiki-server database.
 *
 * Uses {@link storeSourcingEvidence} (not the raw `storeEvidence` RPC) so the
 * resourceId is auto-resolved from the source URL via lookupResourceByUrl().
 * Issue #4017 — the previous direct RPC call left resourceId blank.
 *
 * Throws on storage failure so the caller can track and surface losses.
 *
 * Exported for unit testing — not part of the command's public API.
 */
export async function storeSourcingResult(result: SourcingResult): Promise<void> {
  await storeSourcingEvidence({
    recordType: 'fact',
    recordId: result.factId,
    entityId: result.entityId,
    sourceUrl: result.sourceUrl,
    verdict: result.verdict,
    confidence: result.confidence,
    extractedValue: result.extractedValue,
    reasoning: result.reasoning,
    isPrimarySource: true,
    // PR #4020 review M1: was 'claude-3-haiku' (a non-existent model string)
    // — must match MODELS.haiku used in verifySingleFact above.
    checkerModel: MODELS.haiku,
  }, '[fb-sourcing]');

  // Also store aggregate verdict so re-runs update the displayed verdict.
  // Without this, stale contradictions persist even after re-checks confirm data.
  await storeAggregateVerdict({
    recordType: 'fact',
    recordId: result.factId,
    entityId: result.entityId,
    verdict: result.verdict,
    confidence: result.confidence,
    reasoning: result.reasoning,
    sourcesChecked: 1,
  }, '[fb-sourcing]');
}

/**
 * Collect facts to sourcing based on the command options.
 */
/** Check if a fact's property is marked as not verifiable in the property registry. */
function isNonVerifiable(graph: Graph, fact: Fact): boolean {
  const property = graph.getProperty(fact.propertyId);
  return property?.verifiable === false;
}

function collectFacts(
  kb: LoadedKB,
  options: VerifyCommandOptions,
  alreadyVerifiedFactIds?: ReadonlySet<string>,
): Array<{ entity: Entity; fact: Fact }> {
  const graph = kb.graph;
  const factsToVerify: Array<{ entity: Entity; fact: Fact }> = [];
  // Only filter by verified-set when caller has provided a populated set AND
  // we're in batch mode (entity-scoped or all-entities). For an explicit
  // --fact=X lookup the user is asking for that specific fact; respect it.
  const verified =
    !options.fact && alreadyVerifiedFactIds && alreadyVerifiedFactIds.size > 0
      ? alreadyVerifiedFactIds
      : null;

  if (options.fact) {
    // Find a specific fact by ID
    for (const entity of graph.getAllEntities()) {
      const facts = graph.getFacts(entity.id);
      const match = facts.find((f: Fact) => f.id === options.fact);
      if (match) {
        if (match.source && !isNonVerifiable(graph, match)) {
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
        if (fact.source && !fact.id.startsWith('inv_') && !isNonVerifiable(graph, fact)) {
          if (!verified || !verified.has(fact.id)) {
            factsToVerify.push({ entity, fact });
          }
        }
      }
    }
  } else {
    // All facts across all entities
    for (const entity of graph.getAllEntities()) {
      const facts = graph.getFacts(entity.id);
      for (const fact of facts) {
        if (fact.source && !fact.id.startsWith('inv_') && !isNonVerifiable(graph, fact)) {
          if (!verified || !verified.has(fact.id)) {
            factsToVerify.push({ entity, fact });
          }
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

export async function sourcingCommand(
  args: string[],
  options: VerifyCommandOptions,
): Promise<CommandResult> {
  const isDryRun = options['dry-run'] || options.dryRun;

  const kb = await loadGraphFull();
  const graph = kb.graph;

  // QUA-851: when --where-no-verdict is set, fetch the set of fact IDs that
  // already have a row-level verdict from the wiki-server and skip them.
  // Targets the ~1,353 unverified facts directly instead of re-checking all
  // 2,744. Fail-closed: if we can't fetch verdicts, abort rather than silently
  // re-verify everything.
  const whereNoVerdict = options['where-no-verdict'] || options.whereNoVerdict;
  let alreadyVerifiedFactIds: Set<string> | undefined;
  if (whereNoVerdict && !options.fact) {
    const res = await fetchVerdictRecordIds('fact');
    if (!res.ok) {
      const detail = res.message || res.error;
      return {
        exitCode: 1,
        output: `Failed to fetch existing fact verdicts (--where-no-verdict): ${detail}`,
      };
    }
    alreadyVerifiedFactIds = res.data;
    // Log to stderr so --ci JSON output stays parseable.
    console.error(
      `[where-no-verdict] ${alreadyVerifiedFactIds.size} fact(s) already have a verdict; will skip them.`,
    );
  }

  const factsToVerify = collectFacts(kb, options, alreadyVerifiedFactIds);

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
      const valStr = truncate(val, 18);
      const srcStr = truncate(source, 50);
      lines.push(
        `${entity.name.slice(0, 23).padEnd(24)} ${(property?.name ?? fact.propertyId).slice(0, 23).padEnd(24)} ${valStr.padEnd(20)} ${asOf.padEnd(12)} ${srcStr}`,
      );
    }

    lines.push('');
    lines.push(`Use without --dry-run to run sourcing with LLM.`);

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
  const summary: SourcingSummary = {
    total: factsToVerify.length,
    confirmed: 0,
    contradicted: 0,
    unverifiable: 0,
    outdated: 0,
    partial: 0,
    not_applicable: 0,
    errors: 0,
    storageErrors: 0,
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

      // Store result in wiki-server. Issue #4017 — this used to be silent
      // fire-and-forget; now it tracks failures so the exit code reflects them.
      try {
        await storeSourcingResult(result);
      } catch (e: unknown) {
        summary.storageErrors++;
        console.warn(`[fb-sourcing] Failed to store result for ${result.factId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Storage errors mean primary-data writes were lost — non-zero exit even if
  // no contradictions were found. Issue #4017.
  const exitCode = summary.contradicted > 0 || summary.storageErrors > 0 ? 1 : 0;

  // Build output
  if (options.ci) {
    return {
      exitCode,
      output: JSON.stringify(summary),
    };
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(`\x1b[1m═══ Source-Check Summary ═══\x1b[0m`);
  lines.push(`Total checked:  ${summary.total}`);
  lines.push(`\x1b[32mConfirmed:      ${summary.confirmed}\x1b[0m`);
  lines.push(`\x1b[31mContradicted:   ${summary.contradicted}\x1b[0m`);
  lines.push(`\x1b[33mUnverifiable:   ${summary.unverifiable}\x1b[0m`);
  lines.push(`\x1b[33mOutdated:       ${summary.outdated}\x1b[0m`);
  lines.push(`\x1b[33mPartial:        ${summary.partial}\x1b[0m`);
  lines.push(`\x1b[31mErrors:         ${summary.errors}\x1b[0m`);

  // Show archive fallback stats
  const archiveCount = summary.results.filter((r) => r.reasoning.startsWith('[archive')).length;
  if (archiveCount > 0) {
    lines.push(`\x1b[36mArchive fallback: ${archiveCount} (verified via Wayback Machine)\x1b[0m`);
  }

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

  if (summary.storageErrors > 0) {
    lines.push('');
    lines.push(`\x1b[31mStorage errors: ${summary.storageErrors} verdict(s) failed to persist to wiki-server. Re-run after the underlying issue is fixed.\x1b[0m`);
  }

  return {
    exitCode,
    output: lines.join('\n'),
  };
}
