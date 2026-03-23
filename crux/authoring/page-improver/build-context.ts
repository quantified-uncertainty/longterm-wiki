/**
 * Shared prompt-building context for the improve pipeline.
 *
 * Assembles the entity lookup, KB facts, template context, and objectivity
 * context needed to construct the IMPROVE_PROMPT. Used by both the interactive
 * improve pipeline (improvePhase) and the batch-improve path (auto-update).
 *
 * Extracted from duplicated logic in improve.ts and batch-improve.ts — see #2924.
 */

import { buildEntityLookupForContent } from '../../lib/entity-lookup.ts';
import { buildKbContextForPage } from '../../lib/factbase-context.ts';
import { buildSourceCheckContext } from '../../lib/source-check-context.ts';
import { resolveTemplate, formatTemplateForPrompt } from '../../lib/content/page-templates.ts';
import { getPageType } from '../../lib/page-analysis.ts';
import { IMPROVE_PROMPT } from './phases/prompts.ts';
import type { PageData, AnalysisResult, ResearchResult } from './types.ts';
import { ROOT, buildObjectivityContext } from './utils.ts';

export interface ImproveContext {
  /** The assembled prompt string for the IMPROVE_PROMPT. */
  prompt: string;
  /** Entity lookup table for content-referenced entities. */
  entityLookup: string;
  /** KB context (structured facts) for the page entity, or null if unavailable. */
  kbContext: string | null;
  /** Template context string for the page type, or null if no template. */
  templateContext: string | null;
  /** Objectivity context (alerts + issues) from analysis. */
  objectivityContext: string;
  /** Source-check verdict context (contradicted/outdated claims), or null if unavailable. */
  sourceCheckContext: string | null;
}

export interface BuildImproveContextOptions {
  page: PageData;
  currentContent: string;
  filePath: string;
  importPath: string;
  directions: string;
  analysis: AnalysisResult;
  research: ResearchResult;
  tier: string;
  /** Optional: pass a custom log function. Defaults to no-op. */
  log?: (phase: string, msg: string) => void;
}

/**
 * Build the full improve context (entity lookup, KB facts, template, prompt).
 *
 * This is the shared logic that both improve.ts and batch-improve.ts use to
 * assemble the IMPROVE_PROMPT. Callers provide page data, analysis, research,
 * and directions; this function handles the rest.
 */
export async function buildImproveContext(
  options: BuildImproveContextOptions,
): Promise<ImproveContext> {
  const {
    page, currentContent, filePath, importPath,
    directions, analysis, research, tier,
  } = options;
  const log = options.log ?? (() => {});

  const objectivityContext = buildObjectivityContext(page, analysis);

  log('improve', 'Building entity lookup table...');
  const entityLookup = buildEntityLookupForContent(currentContent, ROOT);
  const entityLookupCount = entityLookup.split('\n').filter(Boolean).length;
  log('improve', `  Found ${entityLookupCount} relevant entities for lookup`);

  // Load KB facts and source-check verdicts in parallel (independent I/O)
  log('improve', 'Loading KB facts and source-check verdicts...');
  const [kbResult, sourceCheckResult] = await Promise.allSettled([
    buildKbContextForPage(page.id, page.path),
    buildSourceCheckContext(page.id),
  ]);

  let kbContext: string | null = null;
  if (kbResult.status === 'fulfilled' && kbResult.value) {
    kbContext = kbResult.value;
    const lineCount = kbContext.split('\n').length;
    log('improve', `  Found KB entity with ${lineCount} lines of structured facts`);
  } else if (kbResult.status === 'rejected') {
    log('improve', `  KB context load failed: ${kbResult.reason instanceof Error ? kbResult.reason.message : String(kbResult.reason)} — continuing without`);
  } else {
    log('improve', '  No KB entity found for this page (or entity has no facts)');
  }

  let sourceCheckContext: string | null = null;
  if (sourceCheckResult.status === 'fulfilled' && sourceCheckResult.value) {
    sourceCheckContext = sourceCheckResult.value;
    const lineCount = sourceCheckContext.split('\n').filter(Boolean).length;
    log('improve', `  Found ${lineCount} source-check warnings for this entity`);
  } else if (sourceCheckResult.status === 'rejected') {
    log('improve', `  Source-check context load failed: ${sourceCheckResult.reason instanceof Error ? sourceCheckResult.reason.message : String(sourceCheckResult.reason)} — continuing without`);
  } else {
    log('improve', '  No actionable source-check verdicts found');
  }

  // Resolve template for this page (explicit frontmatter > entity type inference)
  const pageType = getPageType(page);
  const fmMatch = currentContent.match(/^---\n([\s\S]*?)\n---/);
  const pageTemplateMatch = fmMatch?.[1]?.match(/^pageTemplate:\s*(.+)$/m);
  const pageTemplateValue = pageTemplateMatch?.[1]?.trim().replace(/^["']|["']$/g, '');
  const template = resolveTemplate(pageTemplateValue, pageType);
  let templateContext: string | null = null;
  if (template) {
    templateContext = formatTemplateForPrompt(template);
    log('improve', `  Using template: ${template.name}`);
  }

  const prompt = IMPROVE_PROMPT({
    page, filePath, importPath, directions,
    analysis, research, objectivityContext,
    currentContent, entityLookup,
    claimsContext: null,
    gapAnalysisContext: null,
    kbContext, tier, templateContext,
    sourceCheckContext,
  });

  return {
    prompt,
    entityLookup,
    kbContext,
    templateContext,
    objectivityContext,
    sourceCheckContext,
  };
}
