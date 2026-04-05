/**
 * Source-check orchestrator — main orchestration flow.
 * Handles prioritization, budget controls, batch/realtime execution, and output formatting.
 */

import type { CommandResult } from '../command-types.ts';
import { loadDatabase, loadPages } from '../content-types.ts';
import { loadGraphFull } from '../factbase-loader.ts';
import { createLlmClient } from '../llm.ts';
import { submitBatch, pollBatch, getBatchResults, extractBatchResultText } from '../anthropic-batch.ts';
import type { BatchRequest } from '../anthropic-batch.ts';
import { parseJsonResponse } from '../anthropic.ts';
import { SOURCE_CHECK_CONSTANTS, LlmResponseSchema, validateVerdict } from './index.ts';
import {
  fetchExistingKBVerdicts,
  fetchExistingRecordVerdicts,
  collectFactItems,
  collectRecordItems,
  collectEntityItems,
} from './item-collectors.ts';
import {
  tryDeterministicMatch,
  verifySingleItem,
  storeResult,
  buildFactVerificationPrompt,
  buildRecordVerificationPrompt,
  buildEntityVerificationPrompt,
  MODELS,
} from './item-verifier.ts';
import { fetchSourceContent } from './source-fetcher.ts';
import type {
  OrchestrateOptions,
  VerifyItem,
  VerifyResult,
  OrchestrationSummary,
  VerifiedFactInfo,
  VerifiedRecordInfo,
} from './orchestrator-types.ts';
import type { SourceCheckVerdict } from '../../../apps/wiki-server/src/api-types.ts';

const { ESTIMATED_COST_PER_VERIFICATION } = SOURCE_CHECK_CONSTANTS;

// ── Main orchestrator ────────────────────────────────────────────────

export async function orchestrateCommand(
  args: string[],
  options: OrchestrateOptions,
): Promise<CommandResult> {
  const isDryRun = options['dry-run'] || options.dryRun;
  const budgetLimit = options.budget ? parseFloat(String(options.budget)) : undefined;
  const rawItemLimit = options.limit ? parseInt(String(options.limit), 10) : undefined;
  const typeFilter = options.type as 'fact' | 'record' | 'entity' | 'all' | undefined;
  const tableFilter = options.table as string | undefined;
  const entityTypeFilter = (options['entity-type'] || options.entityType) as string | undefined;
  const entityFilter = options.entity as string | undefined;
  const sourceMode = (options.source as string) ?? 'existing';
  const useWebSearch = sourceMode === 'web-search' || sourceMode === 'all';

  // Validate --limit
  if (rawItemLimit !== undefined && (isNaN(rawItemLimit) || rawItemLimit <= 0)) {
    return { exitCode: 1, output: `Invalid --limit: ${options.limit}\nMust be a positive integer.` };
  }
  const itemLimit = rawItemLimit;

  // --table implies --type=record (filter to specific record type)
  const effectiveTypeFilter = tableFilter && !typeFilter ? 'record' as const : typeFilter;

  // Validate type filter
  const validTypes = ['fact', 'record', 'entity', 'all'];
  if (typeFilter && !validTypes.includes(typeFilter)) {
    return {
      exitCode: 1,
      output: `Invalid --type: ${typeFilter}\nValid values: ${validTypes.join(', ')}`,
    };
  }

  // Validate source mode
  const validSources = ['existing', 'web-search', 'all'];
  if (!validSources.includes(sourceMode)) {
    return {
      exitCode: 1,
      output: `Invalid --source: ${sourceMode}\nValid values: ${validSources.join(', ')}`,
    };
  }

  const shouldCollectFacts = !effectiveTypeFilter || effectiveTypeFilter === 'all' || effectiveTypeFilter === 'fact';
  const shouldCollectRecords = !effectiveTypeFilter || effectiveTypeFilter === 'all' || effectiveTypeFilter === 'record';
  const shouldCollectEntities = (!effectiveTypeFilter || effectiveTypeFilter === 'all' || effectiveTypeFilter === 'entity') && useWebSearch;

  console.log('\x1b[1mVerification Orchestrator\x1b[0m');
  console.log('');

  // ── Step 1: Load data and fetch existing verification status ──
  console.log('Loading data...');

  const [db, pages, existingKBVerdicts, existingRecordVerdicts] = await Promise.all([
    Promise.resolve(loadDatabase()),
    Promise.resolve(loadPages()),
    shouldCollectFacts ? fetchExistingKBVerdicts() : Promise.resolve(new Map<string, VerifiedFactInfo>()),
    shouldCollectRecords ? fetchExistingRecordVerdicts() : Promise.resolve(new Map<string, VerifiedRecordInfo>()),
  ]);

  const entities = db.typedEntities ?? db.entities ?? [];

  // ── Step 2: Collect verification items ──
  console.log('Collecting verification items...');

  const allItems: VerifyItem[] = [];

  if (shouldCollectFacts) {
    try {
      const kb = await loadGraphFull();
      const factItems = collectFactItems(kb, existingKBVerdicts, pages, entityTypeFilter);
      allItems.push(...factItems);
      console.log(`  Facts: ${factItems.length} items`);
    } catch (e: unknown) {
      console.warn(`  Facts: failed to load FactBase: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (shouldCollectRecords) {
    const recordItems = await collectRecordItems(existingRecordVerdicts, entityTypeFilter, tableFilter);
    allItems.push(...recordItems);
    console.log(`  Records: ${recordItems.length} items`);
  }

  if (shouldCollectEntities) {
    const entityItems = collectEntityItems(entities, pages, entityTypeFilter);
    allItems.push(...entityItems);
    console.log(`  Entities (web search): ${entityItems.length} items`);
  }

  // ── Step 2b: Apply --entity filter ──
  if (entityFilter) {
    const before = allItems.length;
    const filtered: VerifyItem[] = [];
    for (const item of allItems) {
      let matches = false;
      if (item.data.kind === 'fact') {
        matches = item.data.entity.id === entityFilter;
      } else if (item.data.kind === 'record') {
        matches = item.data.entityId === entityFilter;
      } else if (item.data.kind === 'entity') {
        matches = item.data.entity.id === entityFilter;
      }
      if (matches) filtered.push(item);
    }
    allItems.length = 0;
    allItems.push(...filtered);
    console.log(`  --entity=${entityFilter}: ${allItems.length} of ${before} items match`);
  }

  if (allItems.length === 0) {
    return { exitCode: 0, output: 'No verification items found.' };
  }

  // ── Step 3: Sort by priority (highest first) ──
  allItems.sort((a, b) => b.priority - a.priority);

  // ── Step 4: Apply limits ──
  let itemsToVerify = allItems;

  if (budgetLimit !== undefined) {
    if (!isFinite(budgetLimit) || budgetLimit <= 0) {
      return { exitCode: 1, output: `Invalid budget: ${budgetLimit}. Budget must be a positive number.` };
    }
    const maxByBudget = Math.floor(budgetLimit / ESTIMATED_COST_PER_VERIFICATION);
    if (maxByBudget < itemsToVerify.length) {
      itemsToVerify = itemsToVerify.slice(0, maxByBudget);
    }
  }

  if (itemLimit !== undefined && itemLimit > 0 && itemLimit < itemsToVerify.length) {
    itemsToVerify = itemsToVerify.slice(0, itemLimit);
  }

  // ── Step 5: Report or execute ──
  const estimatedCost = itemsToVerify.length * ESTIMATED_COST_PER_VERIFICATION;

  if (isDryRun) {
    return formatDryRunOutput(allItems, itemsToVerify, estimatedCost, existingKBVerdicts, existingRecordVerdicts, options);
  }

  // ── Live execution ──
  const useBatch = !!options.batch;
  const parsedConcurrency = options.concurrency ? parseInt(String(options.concurrency), 10) : 5;
  const concurrency = isNaN(parsedConcurrency) || parsedConcurrency < 1 ? 5 : parsedConcurrency;
  const summary: OrchestrationSummary = {
    total: itemsToVerify.length,
    confirmed: 0,
    contradicted: 0,
    unverifiable: 0,
    outdated: 0,
    partial: 0,
    errors: 0,
    deadLinks: 0,
    estimatedCost: useBatch ? estimatedCost * 0.5 : estimatedCost,
    actualVerified: 0,
    byKind: {
      fact: { total: 0, verified: 0 },
      record: { total: 0, verified: 0 },
      entity: { total: 0, verified: 0 },
    },
    results: [],
    failures: [],
  };

  // Count by kind
  for (const item of itemsToVerify) {
    summary.byKind[item.kind].total++;
  }

  if (useBatch) {
    await runBatchExecution(itemsToVerify, summary, concurrency);
  } else {
    await runRealtimeExecution(itemsToVerify, summary, concurrency, useWebSearch);
  }

  // ── Build summary output ──
  if (options.ci) {
    return {
      exitCode: summary.contradicted > 0 ? 1 : 0,
      output: JSON.stringify(summary),
    };
  }

  return { exitCode: summary.contradicted > 0 ? 1 : 0, output: formatSummaryOutput(summary) };
}

// ── Batch execution path ─────────────────────────────────────────────

/**
 * Maximum items per batch submission. The Anthropic Batch API has no hard per-batch
 * limit, but 500 balances progress visibility (results stream in per chunk) with
 * API overhead (one submit + poll cycle per chunk). For 3,000+ record backfills,
 * this yields 6 sequential chunks rather than one opaque multi-hour batch.
 */
const BATCH_CHUNK_SIZE = 500;

async function runBatchExecution(
  itemsToVerify: VerifyItem[],
  summary: OrchestrationSummary,
  concurrency: number,
): Promise<void> {
  console.log(`\n\x1b[1mBatch mode: preparing ${itemsToVerify.length} items (est. \$${summary.estimatedCost.toFixed(2)} with 50% batch discount)...\x1b[0m\n`);

  // Phase 1: Fetch source content and build prompts (with concurrency)
  // Results are stored by original index to preserve the priority sort order of
  // itemsToVerify. Without this, concurrent prepareItem completions would push
  // into batchRequests in arrival order, shuffling high-priority items into
  // later chunks when they happened to be slower to prepare.
  const preparedSlots: ({ request: BatchRequest; item: VerifyItem; sourceUrl: string } | null)[] =
    new Array(itemsToVerify.length).fill(null);
  const batchItemMap = new Map<string, { item: VerifyItem; sourceUrl: string }>();
  let preparedCount = 0;

  async function prepareItem(item: VerifyItem, index: number): Promise<void> {
    preparedCount++;
    const progress = `[${preparedCount}/${itemsToVerify.length}]`;

    // Handle deterministic matching for grants and investments first
    if (item.data.kind === 'record' && (item.data.recordType === 'grant' || item.data.recordType === 'investment')) {
      try {
        const deterministicResult = await tryDeterministicMatch(item);
        if (deterministicResult) {
          summary[deterministicResult.verdict]++;
          summary.actualVerified++;
          summary.byKind[item.kind].verified++;
          summary.results.push(deterministicResult);
          console.log(`  ${progress} ${item.description.slice(0, 80)}`);
          console.log(`    \x1b[32mdeterministic: ${deterministicResult.verdict}\x1b[0m`);
          await storeResult(item, deterministicResult).catch((e: unknown) => {
            console.warn(`[source-check] Storage failed: ${e instanceof Error ? e.message : String(e)}`);
          });
          return;
        }
      } catch (e: unknown) {
        console.warn(`[source-check] Deterministic matching failed for ${item.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Fetch source content
    let sourceUrl = item.sourceUrl;
    let sourceContent: string | null = null;

    if (!sourceUrl && item.data.kind === 'entity') {
      // Entity items have no sourceUrl — perform web search to find one
      const { searchForEntity } = await import('./item-collectors.ts');
      const urls = await searchForEntity(item.data.entity);
      for (const url of urls) {
        const result = await fetchSourceContent(url);
        if (result.content) {
          sourceUrl = url;
          sourceContent = result.content;
          break;
        }
      }
      if (!sourceContent || !sourceUrl) {
        summary.errors++;
        summary.failures.push({ itemId: item.id, kind: item.kind, description: item.description, error: 'No sources found via web search' });
        return;
      }
    } else if (!sourceUrl) {
      summary.errors++;
      summary.failures.push({ itemId: item.id, kind: item.kind, description: item.description, error: 'No source URL' });
      return;
    }

    if (!sourceContent) {
      const fetchResult = await fetchSourceContent(sourceUrl);
      if (!fetchResult.content) {
        // Dead links get a proper verdict instead of an error — saves LLM cost
        if (fetchResult.errorType === 'dead_link') {
          const deadLinkResult: VerifyResult = {
            itemId: item.id,
            kind: item.kind,
            description: item.description,
            verdict: 'unverifiable' as SourceCheckVerdict,
            confidence: 1.0,
            extractedValue: '',
            reasoning: `[dead_link] ${fetchResult.errorMessage ?? 'Source URL is dead'}`,
            sourceUrl,
            checkerModel: 'dead-link-detector',
          };
          summary.unverifiable++;
          summary.deadLinks++;
          summary.actualVerified++;
          summary.byKind[item.kind].verified++;
          summary.results.push(deadLinkResult);
          console.log(`  ${progress} ${item.description.slice(0, 80)}`);
          console.log(`    \x1b[33mdead_link: unverifiable\x1b[0m`);
          await storeResult(item, deadLinkResult).catch((e: unknown) => {
            console.warn(`[source-check] Storage failed: ${e instanceof Error ? e.message : String(e)}`);
          });
          return;
        }
        summary.errors++;
        summary.failures.push({
          itemId: item.id, kind: item.kind, description: item.description,
          error: fetchResult.errorMessage ?? 'Could not fetch source content',
          errorType: fetchResult.errorType,
        });
        return;
      }
      sourceContent = fetchResult.content;
    }

    // Build prompt
    let prompt: string;
    switch (item.data.kind) {
      case 'fact':
        prompt = buildFactVerificationPrompt(item.data, sourceContent);
        break;
      case 'record':
        prompt = buildRecordVerificationPrompt(item.data, item.description, sourceContent);
        break;
      case 'entity':
        prompt = buildEntityVerificationPrompt(item.data.entity, sourceContent, sourceUrl);
        break;
    }

    const customId = `verify-${item.id}`;
    preparedSlots[index] = {
      request: {
        customId,
        params: {
          model: MODELS.haiku,
          max_tokens: 500,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        },
      },
      item,
      sourceUrl,
    };
    console.log(`  ${progress} Prepared: ${item.description.slice(0, 80)}`);
  }

  // Prepare items with concurrency (index preserved for slot assignment)
  const prepExecuting = new Set<Promise<void>>();
  for (let i = 0; i < itemsToVerify.length; i++) {
    const idx = i;
    const p = prepareItem(itemsToVerify[idx], idx).finally(() => prepExecuting.delete(p));
    prepExecuting.add(p);
    if (prepExecuting.size >= concurrency) await Promise.race(prepExecuting);
  }
  await Promise.all(prepExecuting);

  // Compact prepared slots into batchRequests, preserving original priority order
  const batchRequests: BatchRequest[] = [];
  for (const slot of preparedSlots) {
    if (slot) {
      batchRequests.push(slot.request);
      batchItemMap.set(slot.request.customId, { item: slot.item, sourceUrl: slot.sourceUrl });
    }
  }

  if (batchRequests.length === 0) {
    console.log('\nNo items require LLM verification (all resolved deterministically or errored).');
    return;
  }

  // Phase 2-4: Submit, poll, and process in chunks
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const anthropicClient = new Anthropic();
  const totalChunks = Math.ceil(batchRequests.length / BATCH_CHUNK_SIZE);

  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    const chunkStart = chunkIdx * BATCH_CHUNK_SIZE;
    const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, batchRequests.length);
    const chunkRequests = batchRequests.slice(chunkStart, chunkEnd);
    const chunkLabel = totalChunks > 1 ? ` (chunk ${chunkIdx + 1}/${totalChunks})` : '';

    // Phase 2: Submit batch chunk
    console.log(`\n\x1b[1mSubmitting batch of ${chunkRequests.length} requests to Anthropic Batch API${chunkLabel}...\x1b[0m`);

    const batch = await submitBatch(anthropicClient, chunkRequests);
    console.log(`  Batch ID: ${batch.id}`);
    console.log(`  Polling for completion (may take minutes to hours)...`);

    // Phase 3: Poll for completion
    const completedBatch = await pollBatch(anthropicClient, batch.id, {
      intervalMs: 15_000,
      timeoutMs: 4_500_000, // 75 min — fits within 90-min workflow timeout with setup buffer
      onPoll: (b) => {
        const counts = b.request_counts;
        console.log(`  ... processing: ${counts.processing}, succeeded: ${counts.succeeded}, errored: ${counts.errored}`);
      },
    });

    console.log(`\n\x1b[1mBatch completed${chunkLabel}. Processing ${completedBatch.request_counts.succeeded} results...\x1b[0m\n`);

    // Phase 4: Process results
    const resultsMap = await getBatchResults(anthropicClient, batch.id);
    for (const [customId, batchResult] of resultsMap) {
      const batchEntry = batchItemMap.get(customId);
      if (!batchEntry) continue;
      const { item, sourceUrl } = batchEntry;

      if (batchResult.result.type !== 'succeeded') {
        summary.errors++;
        summary.failures.push({
          itemId: item.id, kind: item.kind, description: item.description,
          error: `Batch request ${batchResult.result.type}`,
        });
        continue;
      }

      const text = extractBatchResultText(batchResult);
      if (!text) {
        summary.errors++;
        summary.failures.push({
          itemId: item.id, kind: item.kind, description: item.description,
          error: 'Empty batch result',
        });
        continue;
      }

      // Parse LLM response with shared Zod schema (same validation as real-time path)
      const raw = parseJsonResponse(text);
      const parsed = LlmResponseSchema.safeParse(raw);
      if (!parsed.success) {
        summary.errors++;
        summary.failures.push({
          itemId: item.id, kind: item.kind, description: item.description,
          error: `Invalid LLM response: ${parsed.error.message}`,
        });
        continue;
      }

      const verdict = validateVerdict(parsed.data.verdict);
      const confidence = parsed.data.confidence;
      const extractedValue = parsed.data.extracted_value;
      const reasoning = parsed.data.reasoning;

      const verifyResult: VerifyResult = {
        itemId: item.id,
        kind: item.kind,
        description: item.description,
        verdict,
        confidence,
        extractedValue,
        reasoning,
        sourceUrl: sourceUrl ?? '',
      };

      summary[verdict]++;
      summary.actualVerified++;
      summary.byKind[item.kind].verified++;
      summary.results.push(verifyResult);

      const color = verdict === 'confirmed' ? '\x1b[32m' : verdict === 'contradicted' ? '\x1b[31m' : '\x1b[33m';
      console.log(`  ${item.description.slice(0, 80)}`);
      console.log(`    ${color}${verdict}\x1b[0m (confidence: ${(confidence * 100).toFixed(0)}%)`);

      await storeResult(item, verifyResult).catch((e: unknown) => {
        console.warn(`    \x1b[33mStorage failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
      });
    }
  }
}

// ── Real-time execution path ─────────────────────────────────────────

async function runRealtimeExecution(
  itemsToVerify: VerifyItem[],
  summary: OrchestrationSummary,
  concurrency: number,
  useWebSearch: boolean,
): Promise<void> {
  const client = createLlmClient();
  const estimatedCost = itemsToVerify.length * ESTIMATED_COST_PER_VERIFICATION;
  const concurrencyLabel = concurrency > 1 ? `, concurrency=${concurrency}` : '';
  console.log(`\n\x1b[1mVerifying ${itemsToVerify.length} items (est. \$${estimatedCost.toFixed(2)}${concurrencyLabel})...\x1b[0m\n`);

  let completedCount = 0;

  async function processItem(item: VerifyItem): Promise<void> {
    const kindLabel = item.kind.toUpperCase().padEnd(7);

    const result = await verifySingleItem(item, client, useWebSearch);

    // Synchronize output and summary updates
    completedCount++;
    const progress = `[${completedCount}/${itemsToVerify.length}]`;

    if ('error' in result) {
      summary.errors++;
      summary.failures.push(result);
      const typeTag = result.errorType ? ` [${result.errorType}]` : '';
      console.log(`  ${progress} ${kindLabel} ${item.description.slice(0, 80)}`);
      console.log(`    \x1b[31mERROR${typeTag}: ${result.error}\x1b[0m`);
    } else {
      summary[result.verdict]++;
      if (result.checkerModel === 'dead-link-detector') {
        summary.deadLinks++;
      }
      summary.actualVerified++;
      summary.byKind[item.kind].verified++;
      summary.results.push(result);

      const color = result.verdict === 'confirmed'
        ? '\x1b[32m'
        : result.verdict === 'contradicted'
          ? '\x1b[31m'
          : '\x1b[33m';
      console.log(`  ${progress} ${kindLabel} ${item.description.slice(0, 80)}`);
      console.log(`    ${color}${result.verdict}\x1b[0m (confidence: ${(result.confidence * 100).toFixed(0)}%)`);

      if (result.verdict === 'contradicted' || result.verdict === 'outdated') {
        console.log(`    Source says: ${result.extractedValue.slice(0, 100)}`);
      }

      // Store result (best-effort)
      await storeResult(item, result).catch((e: unknown) => {
        console.warn(`    \x1b[33mStorage failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
      });
    }
  }

  // Run with concurrency-limited pool
  if (concurrency <= 1) {
    for (let i = 0; i < itemsToVerify.length; i++) {
      await processItem(itemsToVerify[i]);
    }
  } else {
    const executing = new Set<Promise<void>>();
    for (let i = 0; i < itemsToVerify.length; i++) {
      const p = processItem(itemsToVerify[i]).finally(() => executing.delete(p));
      executing.add(p);
      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);
  }
}

// ── Output formatting ────────────────────────────────────────────────

function formatDryRunOutput(
  allItems: VerifyItem[],
  selectedItems: VerifyItem[],
  estimatedCost: number,
  kbVerdicts: Map<string, VerifiedFactInfo>,
  recordVerdicts: Map<string, VerifiedRecordInfo>,
  options: OrchestrateOptions,
): CommandResult {
  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        totalAvailable: allItems.length,
        selected: selectedItems.length,
        estimatedCost,
        items: selectedItems.map(i => ({
          id: i.id,
          kind: i.kind,
          description: i.description,
          entityType: i.entityType,
          priority: i.priority,
          neverVerified: i.neverVerified,
          sourceUrl: i.sourceUrl,
        })),
      }),
    };
  }

  const lines: string[] = [];
  lines.push(`\x1b[1mDry run: ${selectedItems.length} of ${allItems.length} items would be verified\x1b[0m`);
  lines.push(`Estimated cost: \$${estimatedCost.toFixed(2)}`);
  lines.push('');

  // Coverage summary
  const neverVerifiedFacts = allItems.filter(i => i.kind === 'fact' && i.neverVerified).length;
  const totalFacts = allItems.filter(i => i.kind === 'fact').length;
  const neverVerifiedRecords = allItems.filter(i => i.kind === 'record' && i.neverVerified).length;
  const totalRecords = allItems.filter(i => i.kind === 'record').length;
  const totalEntities = allItems.filter(i => i.kind === 'entity').length;

  lines.push('\x1b[1mCoverage overview:\x1b[0m');
  if (totalFacts > 0) {
    lines.push(`  Facts:    ${totalFacts} total, ${neverVerifiedFacts} never verified (${kbVerdicts.size} existing verdicts)`);
  }
  if (totalRecords > 0) {
    lines.push(`  Records:  ${totalRecords} total, ${neverVerifiedRecords} never verified (${recordVerdicts.size} existing verdicts)`);
  }
  if (totalEntities > 0) {
    lines.push(`  Entities: ${totalEntities} without sources (web search candidates)`);
  }
  lines.push('');

  // Entity type breakdown
  const typeCounts = new Map<string, number>();
  for (const item of selectedItems) {
    typeCounts.set(item.entityType, (typeCounts.get(item.entityType) ?? 0) + 1);
  }

  lines.push('\x1b[1mSelected items by type:\x1b[0m');
  for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${type.padEnd(20)} ${count}`);
  }
  lines.push('');

  // Top items by priority
  const topItems = selectedItems.slice(0, 20);
  const header = `${'Kind'.padEnd(8)} ${'Priority'.padEnd(10)} ${'Status'.padEnd(12)} ${'Description'.padEnd(60)} Source`;
  lines.push(`\x1b[1m${header}\x1b[0m`);
  lines.push('-'.repeat(120));

  for (const item of topItems) {
    const status = item.neverVerified ? '\x1b[33mnew\x1b[0m' : 'verified';
    const desc = item.description.length > 58 ? item.description.slice(0, 57) + '...' : item.description;
    const src = item.sourceUrl
      ? (item.sourceUrl.length > 30 ? item.sourceUrl.slice(0, 29) + '...' : item.sourceUrl)
      : '(none)';
    lines.push(
      `${item.kind.padEnd(8)} ${String(item.priority.toFixed(0)).padEnd(10)} ${status.padEnd(12)} ${desc.padEnd(60)} ${src}`,
    );
  }

  if (selectedItems.length > 20) {
    lines.push(`  ... and ${selectedItems.length - 20} more items`);
  }

  lines.push('');
  lines.push('Use without --dry-run to run verification with LLM.');

  return { exitCode: 0, output: lines.join('\n') };
}

function formatSummaryOutput(summary: OrchestrationSummary): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('\x1b[1m=== Verification Orchestrator Summary ===\x1b[0m');
  lines.push(`Total items:    ${summary.total}`);
  lines.push(`Verified:       ${summary.actualVerified}`);
  lines.push(`Est. cost:      \$${summary.estimatedCost.toFixed(2)}`);
  lines.push('');
  lines.push(`\x1b[32mConfirmed:      ${summary.confirmed}\x1b[0m`);
  lines.push(`\x1b[31mContradicted:   ${summary.contradicted}\x1b[0m`);
  lines.push(`\x1b[33mUnverifiable:   ${summary.unverifiable}\x1b[0m${summary.deadLinks > 0 ? ` (${summary.deadLinks} dead links)` : ''}`);
  lines.push(`\x1b[33mOutdated:       ${summary.outdated}\x1b[0m`);
  lines.push(`\x1b[33mPartial:        ${summary.partial}\x1b[0m`);
  lines.push(`\x1b[31mErrors:         ${summary.errors}\x1b[0m`);
  if (summary.deadLinks > 0) {
    // Derive unit price from the (possibly batch-discounted) estimated cost
    const unitCost = summary.total > 0
      ? summary.estimatedCost / summary.total
      : ESTIMATED_COST_PER_VERIFICATION;
    const savedCost = summary.deadLinks * unitCost;
    lines.push(`\x1b[32mLLM calls saved: ${summary.deadLinks} (dead links skipped, ~\$${savedCost.toFixed(2)} saved)\x1b[0m`);
  }
  lines.push('');

  // By kind
  lines.push('\x1b[1mBy verification type:\x1b[0m');
  for (const [kind, counts] of Object.entries(summary.byKind)) {
    if (counts.total > 0) {
      lines.push(`  ${kind.padEnd(10)} ${counts.verified}/${counts.total} verified`);
    }
  }

  // Contradictions detail
  const contradictions = summary.results.filter(r => r.verdict === 'contradicted');
  if (contradictions.length > 0) {
    lines.push('');
    lines.push('\x1b[31m\x1b[1mContradictions:\x1b[0m');
    for (const c of contradictions) {
      lines.push(`  [${c.kind}] ${c.description}`);
      lines.push(`    Source says: ${c.extractedValue.slice(0, 200)}`);
      lines.push(`    Reason: ${c.reasoning}`);
      lines.push(`    URL: ${c.sourceUrl}`);
      lines.push('');
    }
  }

  // Outdated detail
  const outdated = summary.results.filter(r => r.verdict === 'outdated');
  if (outdated.length > 0) {
    lines.push('');
    lines.push('\x1b[33m\x1b[1mOutdated:\x1b[0m');
    for (const o of outdated) {
      lines.push(`  [${o.kind}] ${o.description}`);
      lines.push(`    Source says: ${o.extractedValue.slice(0, 200)}`);
      lines.push('');
    }
  }

  // Error breakdown
  if (summary.failures.length > 0) {
    lines.push('');
    lines.push(`\x1b[31m\x1b[1mErrors (${summary.failures.length}):\x1b[0m`);
    const shown = summary.failures.slice(0, 10);
    for (const f of shown) {
      const typeTag = f.errorType ? ` [${f.errorType}]` : '';
      lines.push(`  [${f.kind}] ${f.description.slice(0, 60)}${typeTag}: ${f.error}`);
    }
    if (summary.failures.length > 10) {
      lines.push(`  ... and ${summary.failures.length - 10} more errors`);
    }

    // Error type breakdown
    const errorTypeCounts = new Map<string, number>();
    for (const f of summary.failures) {
      const type = f.errorType ?? 'unknown';
      errorTypeCounts.set(type, (errorTypeCounts.get(type) ?? 0) + 1);
    }
    if (errorTypeCounts.size > 1) {
      lines.push('');
      lines.push('  Error breakdown:');
      for (const [type, cnt] of [...errorTypeCounts.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`    ${type}: ${cnt}`);
      }
    }
  }

  return lines.join('\n');
}
