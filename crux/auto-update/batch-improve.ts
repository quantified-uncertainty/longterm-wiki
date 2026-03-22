/**
 * Batch Improve — Anthropic Batch API integration for auto-update.
 *
 * Runs analysis + research for all pages (these need tool use, can't be batched),
 * then collects the improve prompts and submits them as a single batch via the
 * Anthropic Batch API for 50% cost reduction.
 *
 * Flow:
 * 1. For each page: run analyzePhase + researchPhase (sequential, needs tools)
 * 2. Build IMPROVE_PROMPT for each page
 * 3. Submit all prompts as a single batch
 * 4. Poll until complete
 * 5. Extract results and apply to pages
 *
 * Limitations:
 * - No tool use during improve (batch API doesn't support tool_use)
 * - No adversarial loop or section-level rewriting (batch is single-turn)
 * - Best suited for polish/standard tiers
 */

import fs from 'fs';
import { createLlmClient } from '../lib/llm.ts';
import { MODELS } from '../lib/anthropic.ts';
import { buildCachedSystemPrompt, STATIC_IMPROVE_GUIDELINES } from '../lib/prompt-cache.ts';
import { runBatch, extractBatchResultText, type BatchRequest } from '../lib/anthropic-batch.ts';
import type { PageUpdate, RunResult } from './types.ts';
import { analyzePhase } from '../authoring/page-improver/phases/analyze.ts';
import { researchPhase } from '../authoring/page-improver/phases/research.ts';
import type { PageData, AnalysisResult, ResearchResult, PipelineOptions } from '../authoring/page-improver/types.ts';
import {
  ROOT, getFilePath, getImportPath, loadPages, findPage,
} from '../authoring/page-improver/utils.ts';
import { setApiDirectMode } from '../authoring/page-improver/api.ts';
import { resolveModel } from '../lib/anthropic.ts';
import { buildImproveContext } from '../authoring/page-improver/build-context.ts';
import { postProcessImproveResult } from '../authoring/page-improver/post-process.ts';

interface PreparedPage {
  update: PageUpdate;
  page: PageData;
  analysis: AnalysisResult;
  research: ResearchResult;
  prompt: string;
  currentContent: string;
  filePath: string;
}

/**
 * Execute page improvements via the Anthropic Batch API.
 *
 * @param updates - Page updates from the routing plan
 * @param verbose - Show detailed progress
 * @returns Array of RunResult for each page
 */
export async function executeBatchImprove(
  updates: PageUpdate[],
  verbose = false,
): Promise<RunResult[]> {
  if (updates.length === 0) return [];

  // Force API-direct mode for batch execution (CLI mode doesn't support batches).
  // Not restored: executeBatchImprove is always the top-level entry point for batch
  // runs (called from auto-update orchestrator), so no caller depends on prior mode.
  setApiDirectMode(true);

  const client = createLlmClient();
  const pages = loadPages();
  const results: RunResult[] = [];

  // ── Phase 1: Prepare all pages (analysis + research + prompt building) ───
  console.log(`  Batch: preparing ${updates.length} pages (analysis + research)...`);
  const prepared: PreparedPage[] = [];

  for (const update of updates) {
    const start = Date.now();
    const page = findPage(pages, update.pageId);

    if (!page) {
      console.log(`    ${update.pageTitle}: page not found, skipping`);
      results.push({
        pageId: update.pageId,
        status: 'failed',
        tier: update.suggestedTier,
        error: 'Page not found',
        durationMs: Date.now() - start,
      });
      continue;
    }

    try {
      const options: PipelineOptions = {
        tier: update.suggestedTier,
        directions: update.directions,
        apiDirect: true,
      };

      if (verbose) console.log(`    ${update.pageTitle}: analyzing...`);
      const analysis = await analyzePhase(page, update.directions, options);

      let research: ResearchResult = { sources: [] };
      if (update.suggestedTier !== 'polish') {
        if (verbose) console.log(`    ${update.pageTitle}: researching...`);
        research = await researchPhase(page, analysis, { ...options, deep: false });
      }

      // Build the improve prompt using shared context builder
      const filePath = getFilePath(page.path);
      const currentContent = fs.readFileSync(filePath, 'utf-8');
      const importPath = getImportPath();

      const verboseLog = verbose
        ? (phase: string, msg: string) => console.log(`    ${update.pageTitle}: [${phase}] ${msg}`)
        : undefined;

      const { prompt } = await buildImproveContext({
        page, currentContent, filePath, importPath,
        directions: update.directions,
        analysis, research, tier: update.suggestedTier,
        log: verboseLog,
      });

      prepared.push({
        update,
        page,
        analysis,
        research,
        prompt,
        currentContent,
        filePath,
      });

      if (verbose) console.log(`    ${update.pageTitle}: prepared (${((Date.now() - start) / 1000).toFixed(0)}s)`);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.log(`    ${update.pageTitle}: preparation failed: ${error.message.slice(0, 100)}`);
      results.push({
        pageId: update.pageId,
        status: 'failed',
        tier: update.suggestedTier,
        error: error.message.slice(0, 300),
        durationMs: Date.now() - start,
      });
    }
  }

  if (prepared.length === 0) {
    console.log(`  Batch: no pages to submit`);
    return results;
  }

  // ── Phase 2: Submit batch ───────────────────────────────────────────────
  console.log(`  Batch: submitting ${prepared.length} pages to Anthropic Batch API...`);

  const batchRequests: BatchRequest[] = prepared.map(p => ({
    customId: p.update.pageId,
    params: {
      model: resolveModel(MODELS.sonnet),
      max_tokens: 16000,
      system: buildCachedSystemPrompt(STATIC_IMPROVE_GUIDELINES, ''),
      messages: [{ role: 'user' as const, content: p.prompt }],
    },
  }));

  const batchStart = Date.now();
  let batchResults;
  try {
    batchResults = await runBatch(client, batchRequests, {
      intervalMs: 15_000,
      timeoutMs: 60 * 60 * 1000, // 1 hour
      onSubmit: (batch) => {
        console.log(`  Batch submitted: ${batch.id}`);
      },
      onPoll: (batch) => {
        const elapsed = ((Date.now() - batchStart) / 1000).toFixed(0);
        const counts = batch.request_counts;
        console.log(
          `  Batch ${batch.id}: ${counts.succeeded} succeeded, ` +
          `${counts.processing} processing, ${counts.errored} errored (${elapsed}s)`
        );
      },
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`  Batch failed: ${error.message}`);
    // Mark all prepared pages as failed
    for (const p of prepared) {
      results.push({
        pageId: p.update.pageId,
        status: 'failed',
        tier: p.update.suggestedTier,
        error: `Batch failed: ${error.message.slice(0, 200)}`,
        durationMs: Date.now() - batchStart,
      });
    }
    return results;
  }

  // ── Phase 3: Apply results ──────────────────────────────────────────────
  console.log(`  Batch completed. Applying results...`);

  for (const p of prepared) {
    const result = batchResults.get(p.update.pageId);
    if (!result) {
      results.push({
        pageId: p.update.pageId,
        status: 'failed',
        tier: p.update.suggestedTier,
        error: 'No result returned from batch',
      });
      continue;
    }

    if (result.result.type !== 'succeeded') {
      const errorMsg = result.result.type === 'errored'
        ? `API error: ${JSON.stringify(result.result.error).slice(0, 200)}`
        : `Result type: ${result.result.type}`;
      results.push({
        pageId: p.update.pageId,
        status: 'failed',
        tier: p.update.suggestedTier,
        error: errorMsg,
      });
      continue;
    }

    try {
      const text = extractBatchResultText(result);
      if (!text) {
        results.push({
          pageId: p.update.pageId,
          status: 'failed',
          tier: p.update.suggestedTier,
          error: 'Empty response from batch',
        });
        continue;
      }

      const applied = await applyBatchResult(p, text, verbose);
      results.push(applied);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      results.push({
        pageId: p.update.pageId,
        status: 'failed',
        tier: p.update.suggestedTier,
        error: error.message.slice(0, 300),
      });
    }
  }

  return results;
}

/**
 * Apply a batch API result to a page file.
 * Uses shared postProcessImproveResult for all post-processing.
 */
async function applyBatchResult(
  p: PreparedPage,
  rawResult: string,
  verbose: boolean,
): Promise<RunResult> {
  const start = Date.now();

  const verboseLog = verbose
    ? (phase: string, msg: string) => console.log(`    ${p.update.pageTitle}: [${phase}] ${msg}`)
    : (_phase: string, _msg: string) => {};

  const postProcessed = await postProcessImproveResult(
    rawResult, p.currentContent, p.page.id, p.filePath, ROOT, verboseLog,
  );

  if (postProcessed.failed) {
    return {
      pageId: p.update.pageId,
      status: 'failed',
      tier: p.update.suggestedTier,
      error: postProcessed.failureReason,
      durationMs: Date.now() - start,
    };
  }

  // Write the result
  fs.writeFileSync(p.filePath, postProcessed.content);
  if (verbose) console.log(`    ${p.update.pageTitle}: applied`);

  return {
    pageId: p.update.pageId,
    status: 'success',
    tier: p.update.suggestedTier,
    durationMs: Date.now() - start,
  };
}
