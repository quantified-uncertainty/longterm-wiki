/**
 * Improve Phase
 *
 * Generates improved content using analysis, research, and LLM synthesis.
 * Handles entity lookup, frontmatter repair, and related-pages stripping.
 */

import fs from 'fs';
import { MODELS } from '../../../lib/anthropic.ts';
import { buildEntityLookupForContent } from '../../../lib/entity-lookup.ts';
import { buildFactLookupForContent } from '../../../lib/fact-lookup.ts';
import { convertSlugsToNumericIds } from '../../creator/deployment.ts';
import type { PageData, AnalysisResult, ResearchResult, PipelineOptions } from '../types.ts';
import {
  ROOT, log, getFilePath, getImportPath, writeTemp,
  repairFrontmatter, stripRelatedPagesSections, buildObjectivityContext,
} from '../utils.ts';
import { runAgent } from '../api.ts';
import { IMPROVE_PROMPT } from './prompts.ts';

export async function improvePhase(page: PageData, analysis: AnalysisResult, research: ResearchResult, directions: string, options: PipelineOptions, contentOverride?: string): Promise<string> {
  log('improve', 'Starting improvements');

  const filePath = getFilePath(page.path);
  // Use contentOverride if provided (e.g., adversarial loop iterating on in-memory content),
  // otherwise read from disk (initial improve pass).
  const currentContent = contentOverride ?? fs.readFileSync(filePath, 'utf-8');
  const importPath = getImportPath();

  const objectivityContext = buildObjectivityContext(page, analysis);

  log('improve', 'Building entity lookup table...');
  const entityLookup = buildEntityLookupForContent(currentContent, ROOT);
  const entityLookupCount = entityLookup.split('\n').filter(Boolean).length;
  log('improve', `  Found ${entityLookupCount} relevant entities for lookup`);

  log('improve', 'Building fact lookup table...');
  const factLookup = buildFactLookupForContent(page.id, currentContent, ROOT);
  const factLookupCount = factLookup ? factLookup.split('\n').filter(l => l && !l.startsWith('#')).length : 0;
  log('improve', `  Found ${factLookupCount} available facts for wrapping`);

  const tier = options.tier || 'standard';
  const prompt = IMPROVE_PROMPT({
    page, filePath, importPath, directions,
    analysis, research, objectivityContext,
    currentContent, entityLookup, factLookup, tier,
  });

  const result = await runAgent(prompt, {
    model: options.improveModel || MODELS.sonnet,
    maxTokens: 16000
  });

  let improvedContent: string = result;
  if (!improvedContent.startsWith('---')) {
    const mdxMatch = result.match(/```(?:mdx)?\n([\s\S]*?)```/);
    if (mdxMatch) {
      improvedContent = mdxMatch[1];
    }
  }

  // Update lastEdited in frontmatter
  const today = new Date().toISOString().split('T')[0];
  improvedContent = improvedContent.replace(
    /lastEdited:\s*["']?\d{4}-\d{2}-\d{2}["']?/,
    `lastEdited: "${today}"`
  );

  improvedContent = repairFrontmatter(improvedContent);
  improvedContent = stripRelatedPagesSections(improvedContent);

  const { content: convertedContent, converted: slugsConverted } = convertSlugsToNumericIds(improvedContent, ROOT);
  if (slugsConverted > 0) {
    log('improve', `  Converted ${slugsConverted} remaining slug-based EntityLink ID(s) to E## format`);
    improvedContent = convertedContent;
  }

  writeTemp(page.id, 'improved.mdx', improvedContent);
  log('improve', 'Complete');
  return improvedContent;
}
