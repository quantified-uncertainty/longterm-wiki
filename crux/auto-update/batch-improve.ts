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
import Anthropic from '@anthropic-ai/sdk';
import { createLlmClient } from '../lib/llm.ts';
import { MODELS } from '../lib/anthropic.ts';
import { buildCachedSystemPrompt, STATIC_IMPROVE_GUIDELINES } from '../lib/prompt-cache.ts';
import { runBatch, extractBatchResultText, type BatchRequest } from '../lib/anthropic-batch.ts';
import type { PageUpdate, RunResult } from './types.ts';
import { analyzePhase } from '../authoring/page-improver/phases/analyze.ts';
import { researchPhase } from '../authoring/page-improver/phases/research.ts';
import { IMPROVE_PROMPT } from '../authoring/page-improver/phases/prompts.ts';
import type { PageData, AnalysisResult, ResearchResult, PipelineOptions } from '../authoring/page-improver/types.ts';
import {
  ROOT, getFilePath, getImportPath, repairFrontmatter, ensureFrontmatterFields,
  stripRelatedPagesSections, cleanEntityLinks, buildObjectivityContext, loadPages, findPage,
} from '../authoring/page-improver/utils.ts';
import { setApiDirectMode } from '../authoring/page-improver/api.ts';
import { buildEntityLookupForContent } from '../lib/entity-lookup.ts';
import { buildKbContextForPage } from '../lib/factbase-context.ts';
import { resolveTemplate, formatTemplateForPrompt } from '../lib/content/page-templates.ts';
import { getPageType } from '../lib/page-analysis.ts';
import { convertSlugsToWikiIds } from '../authoring/creator/deployment.ts';
import { convertNewFootnotes } from '../lib/convert-new-footnotes.ts';
import { resolveModel } from '../lib/anthropic.ts';

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

      // Build the improve prompt (same as improvePhase does)
      const filePath = getFilePath(page.path);
      const currentContent = fs.readFileSync(filePath, 'utf-8');
      const importPath = getImportPath();
      const objectivityContext = buildObjectivityContext(page, analysis);
      const entityLookup = buildEntityLookupForContent(currentContent, ROOT);

      let kbContext: string | null = null;
      try {
        kbContext = await buildKbContextForPage(page.id, page.path);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (verbose) console.log(`    ${update.pageTitle}: KB context failed: ${error.message}`);
      }

      const pageType = getPageType(page);
      const fmMatch = currentContent.match(/^---\n([\s\S]*?)\n---/);
      const pageTemplateMatch = fmMatch?.[1]?.match(/^pageTemplate:\s*(.+)$/m);
      const pageTemplateValue = pageTemplateMatch?.[1]?.trim().replace(/^["']|["']$/g, '');
      const template = resolveTemplate(pageTemplateValue, pageType);
      let templateContext: string | null = null;
      if (template) {
        templateContext = formatTemplateForPrompt(template);
      }

      const prompt = IMPROVE_PROMPT({
        page, filePath, importPath,
        directions: update.directions,
        analysis, research, objectivityContext,
        currentContent, entityLookup,
        claimsContext: null,
        gapAnalysisContext: null,
        kbContext,
        tier: update.suggestedTier,
        templateContext,
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
 * Mirrors the post-processing logic from improvePhase.
 */
async function applyBatchResult(
  p: PreparedPage,
  rawResult: string,
  verbose: boolean,
): Promise<RunResult> {
  const start = Date.now();

  let improvedContent = rawResult;

  // Extract MDX from code blocks if wrapped
  if (!improvedContent.startsWith('---')) {
    const codeBlocks = [...rawResult.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g)];
    const mdxBlock = codeBlocks.find(m => m[1].trimStart().startsWith('---'));
    if (mdxBlock) {
      improvedContent = mdxBlock[1];
    } else if (codeBlocks.length > 0) {
      const largest = codeBlocks.reduce((a, b) => a[1].length >= b[1].length ? a : b);
      improvedContent = largest[1];
    }

    // Detect JSON-wrapped responses: {"content": "...", "claimMap": [...]}
    // The LLM sometimes returns structured JSON instead of raw MDX.
    const contentFieldMatch = improvedContent.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
    if (contentFieldMatch) {
      if (verbose) console.log(`    ${p.update.pageTitle}: detected JSON-wrapped response — extracting "content" field`);
      try {
        // Unescape JSON string: \n → newline, \" → ", \\ → \, \t → tab
        const extracted = JSON.parse(`"${contentFieldMatch[1]}"`);
        if (typeof extracted === 'string' && extracted.length > 100) {
          improvedContent = extracted;
        }
      } catch {
        // JSON.parse may fail on truncated strings — try manual unescaping
        const raw = contentFieldMatch[1];
        let manual = '';
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] === '\\' && i + 1 < raw.length) {
            const next = raw[i + 1];
            if (next === 'n') { manual += '\n'; i++; }
            else if (next === '"') { manual += '"'; i++; }
            else if (next === '\\') { manual += '\\'; i++; }
            else if (next === 't') { manual += '\t'; i++; }
            else { manual += raw[i]; }
          } else {
            manual += raw[i];
          }
        }
        if (manual.length > 100) {
          if (verbose) console.log(`    ${p.update.pageTitle}: used manual unescaping for truncated JSON content string`);
          improvedContent = manual;
        }
      }
    }
  }

  // Validate: looks like MDX?
  const trimmed = improvedContent.trim();
  if (
    !trimmed.startsWith('---') &&
    !trimmed.startsWith('#') &&
    !trimmed.startsWith('import ') &&
    !trimmed.startsWith('<')
  ) {
    return {
      pageId: p.update.pageId,
      status: 'failed',
      tier: p.update.suggestedTier,
      error: `Response does not look like MDX (starts with "${trimmed.substring(0, 40)}...")`,
      durationMs: Date.now() - start,
    };
  }

  // Guard against truncation
  const inputWords = p.currentContent.split(/\s+/).length;
  const outputWords = improvedContent.split(/\s+/).length;
  if (outputWords < inputWords * 0.5 && inputWords > 200) {
    return {
      pageId: p.update.pageId,
      status: 'failed',
      tier: p.update.suggestedTier,
      error: `Truncation detected: output (${outputWords} words) < 50% of input (${inputWords} words)`,
      durationMs: Date.now() - start,
    };
  }

  // Update lastEdited
  const today = new Date().toISOString().split('T')[0];
  improvedContent = improvedContent.replace(
    /lastEdited:\s*["']?\d{4}-\d{2}-\d{2}["']?/,
    `lastEdited: "${today}"`,
  );

  // Post-processing (same as improvePhase)
  improvedContent = repairFrontmatter(improvedContent);
  improvedContent = ensureFrontmatterFields(p.currentContent, improvedContent);
  improvedContent = cleanEntityLinks(improvedContent);
  improvedContent = stripRelatedPagesSections(improvedContent);

  const { content: convertedContent, converted: slugsConverted } = convertSlugsToWikiIds(improvedContent, ROOT);
  if (slugsConverted > 0) {
    improvedContent = convertedContent;
  }

  // Convert footnotes
  try {
    const fnResult = await convertNewFootnotes(improvedContent, p.page.id, {
      createDbEntries: false,
      entityId: p.page.id,
    });
    if (fnResult.convertedCount > 0) {
      improvedContent = fnResult.content;
    }
  } catch (e: unknown) {
    console.warn(`Footnote conversion failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Write the result
  fs.writeFileSync(p.filePath, improvedContent);
  if (verbose) console.log(`    ${p.update.pageTitle}: applied`);

  return {
    pageId: p.update.pageId,
    status: 'success',
    tier: p.update.suggestedTier,
    durationMs: Date.now() - start,
  };
}
