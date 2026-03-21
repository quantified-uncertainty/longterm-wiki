/**
 * Improve Phase
 *
 * Generates improved content using analysis, research, and LLM synthesis.
 * Delegates prompt-building to buildImproveContext() and post-processing to
 * postProcessImproveResult() — shared with the batch-improve path.
 */

import fs from 'fs';
import { MODELS } from '../../../lib/anthropic.ts';
import { buildCachedSystemPrompt, STATIC_IMPROVE_GUIDELINES } from '../../../lib/prompt-cache.ts';
import type { PageData, AnalysisResult, ResearchResult, PipelineOptions } from '../types.ts';
import { ROOT, log, getFilePath, getImportPath, writeTemp } from '../utils.ts';
import { runAgent } from '../api.ts';
import { buildImproveContext } from '../build-context.ts';
import { postProcessImproveResult } from '../post-process.ts';

export async function improvePhase(page: PageData, analysis: AnalysisResult, research: ResearchResult, directions: string, options: PipelineOptions, contentOverride?: string): Promise<string> {
  log('improve', 'Starting improvements');

  const filePath = getFilePath(page.path);
  // Use contentOverride if provided (e.g., adversarial loop iterating on in-memory content),
  // otherwise read from disk (initial improve pass).
  const currentContent = contentOverride ?? fs.readFileSync(filePath, 'utf-8');
  const importPath = getImportPath();

  const tier = options.tier || 'standard';
  const { prompt } = await buildImproveContext({
    page, currentContent, filePath, importPath,
    directions, analysis, research, tier,
    log,
  });

  // Use prompt caching: pass static guidelines as a cached system prompt.
  // The Anthropic API caches the system prompt for 5 minutes, so sequential
  // page improvements reuse it (90% discount on input tokens for the cached portion).
  const cachedSystem = buildCachedSystemPrompt(STATIC_IMPROVE_GUIDELINES, '');

  const result = await runAgent(prompt, {
    model: options.improveModel || MODELS.sonnet,
    maxTokens: 16000,
    systemPrompt: cachedSystem,
  });

  const postProcessed = await postProcessImproveResult(
    result, currentContent, page.id, filePath, ROOT, log,
  );

  if (postProcessed.failed) {
    log('improve', `Post-processing failed: ${postProcessed.failureReason} — keeping original`);
    return currentContent;
  }

  writeTemp(page.id, 'improved.mdx', postProcessed.content);
  log('improve', 'Complete');
  return postProcessed.content;
}
