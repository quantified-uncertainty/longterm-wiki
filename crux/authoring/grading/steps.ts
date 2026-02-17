/**
 * Grading pipeline steps.
 *
 * Step 1: Automated warnings (regex rules, no LLM)
 * Step 2: LLM checklist review (Haiku)
 * Step 3: LLM rating (Sonnet)
 *
 * Also includes quality computation and metrics.
 */

import { createClient, callClaude, parseJsonResponse } from '../../lib/anthropic.ts';
import { readFileSync } from 'fs';
import { ValidationEngine, ContentFile } from '../../lib/validation-engine.ts';
import { countFootnoteRefs } from '../../lib/metrics-extractor.ts';
import {
  insiderJargonRule,
  falseCertaintyRule,
  prescriptiveLanguageRule,
  toneMarkersRule,
  structuralQualityRule,
  evaluativeFramingRule,
  unsourcedBiographicalClaimsRule,
  evaluativeFlattery,
  footnoteCoverageRule,
} from '../../lib/rules/index.ts';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  PageInfo, Warning, ChecklistWarning, GradeResult,
  Ratings, Metrics, Frontmatter, Weights,
} from './types.ts';
import {
  SYSTEM_PROMPT, USER_PROMPT_TEMPLATE,
  CHECKLIST_SYSTEM_PROMPT, CHECKLIST_USER_TEMPLATE,
} from './prompts.ts';

// ── Warning rules used in Step 1 ────────────────────────────────────────────

const WARNING_RULES = [
  insiderJargonRule,
  falseCertaintyRule,
  prescriptiveLanguageRule,
  toneMarkersRule,
  structuralQualityRule,
  evaluativeFramingRule,
  unsourcedBiographicalClaimsRule,
  evaluativeFlattery,
  footnoteCoverageRule,
];

// ── Content helpers ──────────────────────────────────────────────────────────

/** Get content without frontmatter, optionally truncated. */
export function getContent(text: string, maxWords: number = 10000): string {
  const withoutFm = text.replace(/^---[\s\S]*?---\n*/, '');
  const words = withoutFm.split(/\s+/);
  if (words.length <= maxWords) return withoutFm;
  return words.slice(0, maxWords).join(' ') + '\n\n[... truncated at ' + maxWords + ' words]';
}

/** Compute automated metrics from content. */
export function computeMetrics(content: string): Metrics {
  const withoutFm = content.replace(/^---[\s\S]*?---\n*/, '');

  const withoutTables = withoutFm.replace(/\|[^\n]+\|/g, '');
  const withoutCodeBlocks = withoutTables.replace(/```[\s\S]*?```/g, '');
  const withoutImports = withoutCodeBlocks.replace(/^import\s+.*$/gm, '');
  const withoutComponents = withoutImports.replace(/<[^>]+\/>/g, '').replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '');
  const proseWords = withoutComponents.split(/\s+/).filter(w => w.length > 0).length;

  const rComponents = (withoutFm.match(/<R\s+id=/g) || []).length;
  const citations = rComponents + countFootnoteRefs(withoutFm);

  const tables = (withoutFm.match(/\|[-:]+\|/g) || []).length;

  const mermaid = (withoutFm.match(/<Mermaid/g) || []).length;
  const images = (withoutFm.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
  const diagrams = mermaid + images;

  return { wordCount: proseWords, citations, tables, diagrams };
}

/** Detect content type from frontmatter or path. */
export function detectContentType(frontmatter: Frontmatter, relativePath: string): string {
  if (frontmatter.contentType) return frontmatter.contentType;
  if (relativePath.includes('/models/')) return 'analysis';
  if (relativePath.includes('/organizations/') || relativePath.includes('/people/')) return 'reference';
  return 'reference';
}

// ── Step 1: Automated Warnings ───────────────────────────────────────────────

/** Run automated validation rules against a single page. */
export async function runAutomatedWarnings(page: PageInfo): Promise<Warning[]> {
  const engine = new ValidationEngine();
  await engine.load();

  const contentFile = engine.content.get(page.filePath);
  if (!contentFile) {
    const cf = new ContentFile(page.filePath, page.content);
    const issues: Warning[] = [];
    for (const rule of WARNING_RULES) {
      const ruleIssues = await rule.check(cf, engine);
      if (Array.isArray(ruleIssues)) {
        issues.push(...ruleIssues);
      }
    }
    return issues.map(i => ({
      rule: i.rule, line: i.line, message: i.message, severity: i.severity,
    }));
  }

  const issues: Warning[] = [];
  for (const rule of WARNING_RULES) {
    const ruleIssues = await rule.check(contentFile, engine);
    if (Array.isArray(ruleIssues)) {
      issues.push(...ruleIssues);
    }
  }
  return issues.map(i => ({
    rule: i.rule, line: i.line, message: i.message, severity: i.severity,
  }));
}

// ── Step 2: LLM Checklist Review ─────────────────────────────────────────────

/** Run LLM checklist review using Haiku. */
export async function runChecklistReview(client: Anthropic, page: PageInfo): Promise<ChecklistWarning[]> {
  const fullContent = getContent(page.content, 6000);
  const contentType = detectContentType(page.frontmatter, page.relativePath);

  const userPrompt: string = CHECKLIST_USER_TEMPLATE
    .replace('{{title}}', page.title)
    .replace('{{contentType}}', contentType)
    .replace('{{content}}', fullContent);

  try {
    const result = await callClaude(client, {
      model: 'haiku',
      systemPrompt: CHECKLIST_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 1500,
    });

    const parsed = parseJsonResponse(result.text) as { warnings?: ChecklistWarning[] };
    return parsed.warnings || [];
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`  Checklist review failed for ${page.id}: ${error.message}`);
    return [];
  }
}

// ── Step 3: LLM Rating ──────────────────────────────────────────────────────

/** Format warnings summary for inclusion in the rating prompt. */
export function formatWarningsSummary(automatedWarnings: Warning[], checklistWarnings: ChecklistWarning[]): string {
  const lines: string[] = [];

  if (automatedWarnings.length > 0) {
    lines.push('**Automated rule warnings:**');
    for (const w of automatedWarnings.slice(0, 15)) {
      lines.push(`- [${w.rule}] Line ${w.line}: ${w.message}`);
    }
    if (automatedWarnings.length > 15) {
      lines.push(`- ... and ${automatedWarnings.length - 15} more`);
    }
  }

  if (checklistWarnings.length > 0) {
    lines.push('**Checklist review warnings:**');
    for (const w of checklistWarnings.slice(0, 15)) {
      lines.push(`- [${w.id}] "${w.quote}" — ${w.note}`);
    }
    if (checklistWarnings.length > 15) {
      lines.push(`- ... and ${checklistWarnings.length - 15} more`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'No warnings from automated checks or checklist review.';
}

/** Call Claude API to grade a page (Step 3). */
export async function gradePage(client: Anthropic, page: PageInfo, warningsSummary: string | null = null): Promise<GradeResult | null> {
  const fullContent = getContent(page.content);
  const contentType = detectContentType(page.frontmatter, page.relativePath);

  let userPrompt: string = USER_PROMPT_TEMPLATE
    .replace('{{filePath}}', page.relativePath)
    .replace('{{category}}', page.category)
    .replace('{{contentType}}', contentType)
    .replace('{{title}}', page.title)
    .replace('{{description}}', page.frontmatter.description || '(none)')
    .replace('{{content}}', fullContent);

  if (warningsSummary) {
    userPrompt += `\n\n---\nPRE-SCREENING WARNINGS (from automated rules and checklist review — factor these into your ratings, especially objectivity, rigor, and concreteness):\n${warningsSummary}\n---`;
  }

  const response = await callClaude(client, {
    model: 'sonnet',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 800,
  });

  try {
    return parseJsonResponse(response.text) as GradeResult;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`Failed to parse response for ${page.id}:`, response.text);
    return null;
  }
}

// ── Quality Computation ──────────────────────────────────────────────────────

/**
 * Compute derived quality score from ratings, metrics, and frontmatter.
 *
 * Content-type-specific weighting:
 * - analysis: focus, novelty, concreteness weighted 1.5x
 * - reference: rigor, completeness weighted 1.5x
 * - explainer: completeness, rigor weighted 1.5x
 *
 * Formula: weightedAvg x 8 + min(8, words/600) + min(7, citations x 0.35)
 */
export function computeQuality(ratings: Ratings, metrics: Metrics, frontmatter: Frontmatter = {}, relativePath: string = ''): number {
  const contentType = detectContentType(frontmatter, relativePath);

  const focus = ratings.focus ?? 5;
  const novelty = ratings.novelty ?? 5;
  const rigor = ratings.rigor ?? 5;
  const completeness = ratings.completeness ?? 5;
  const concreteness = ratings.concreteness ?? 5;
  const actionability = ratings.actionability ?? 5;
  const objectivity = ratings.objectivity ?? 5;

  let weights: Weights;
  if (contentType === 'analysis') {
    weights = { focus: 1.5, novelty: 1.5, rigor: 1.0, completeness: 0.8, concreteness: 1.5, actionability: 1.2, objectivity: 1.2 };
  } else if (contentType === 'explainer') {
    weights = { focus: 1.0, novelty: 0.5, rigor: 1.5, completeness: 1.5, concreteness: 1.0, actionability: 0.5, objectivity: 0.8 };
  } else {
    weights = { focus: 1.0, novelty: 0.8, rigor: 1.5, completeness: 1.5, concreteness: 1.0, actionability: 0.5, objectivity: 1.0 };
  }

  const totalWeight: number = Object.values(weights).reduce((a, b) => a + b, 0);
  const weightedSum: number =
    focus * weights.focus + novelty * weights.novelty + rigor * weights.rigor +
    completeness * weights.completeness + concreteness * weights.concreteness +
    actionability * weights.actionability + objectivity * weights.objectivity;

  const weightedAvg: number = weightedSum / totalWeight;
  const baseScore: number = weightedAvg * 8;
  const lengthScore: number = Math.min(8, metrics.wordCount / 600);
  const evidenceScore: number = Math.min(7, metrics.citations * 0.35);

  let quality: number = baseScore + lengthScore + evidenceScore;

  if (frontmatter.pageType === 'stub') {
    quality = Math.min(quality, 35);
  }
  if (metrics.wordCount < 100) {
    quality = Math.min(quality, 40);
  }

  return Math.round(Math.max(0, quality));
}
