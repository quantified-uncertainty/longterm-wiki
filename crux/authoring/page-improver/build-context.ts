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

  // Load KB facts for the entity associated with this page
  log('improve', 'Loading KB facts for entity...');
  let kbContext: string | null = null;
  try {
    kbContext = await buildKbContextForPage(page.id, page.path);
    if (kbContext) {
      const lineCount = kbContext.split('\n').length;
      log('improve', `  Found KB entity with ${lineCount} lines of structured facts`);
    } else {
      log('improve', '  No KB entity found for this page (or entity has no facts)');
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('improve', `  KB context load failed: ${error.message} — continuing without KB context`);
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
  });

  return {
    prompt,
    entityLookup,
    kbContext,
    templateContext,
    objectivityContext,
  };
}
