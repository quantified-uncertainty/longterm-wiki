/**
 * Tool: adversarial_review
 *
 * Runs a lightweight adversarial review on the current page content:
 * extracts factual claims, identifies uncited claims, detects speculation,
 * and flags potential issues. Uses regex-based extraction (no LLM).
 * Cost: $0 (local analysis).
 */

import { stripFrontmatter } from '../../../lib/patterns.ts';
import type { ToolRegistration } from './types.ts';

// ---------------------------------------------------------------------------
// Claim & issue extraction (no LLM — regex + heuristics)
// ---------------------------------------------------------------------------

interface ExtractedIssue {
  type: 'uncited-claim' | 'speculation' | 'weasel-words' | 'low-fact-density';
  description: string;
  section?: string;
  severity: 'critical' | 'warning' | 'info';
}

/** Words/phrases that indicate speculative or hedging language. */
const SPECULATION_PATTERNS = [
  /\b(?:might|may|could|possibly|perhaps|likely|probably|presumably|arguably)\b/i,
  /\b(?:it is believed|some believe|many think|it is thought|widely considered)\b/i,
  /\b(?:appears to|seems to|tends to)\b/i,
];

/** Weasel words that weaken claims without attribution. */
const WEASEL_PATTERNS = [
  /\b(?:some experts|many researchers|critics argue|supporters claim|some say)\b/i,
  /\b(?:it has been suggested|it is often said|it is sometimes argued)\b/i,
];

/** Patterns that indicate factual claims (dates, numbers, dollar amounts). */
const FACTUAL_CLAIM_PATTERNS = [
  /\$[\d,.]+\s*(?:billion|million|trillion|B|M|K|T)/i,
  /\b(?:founded|established|created|launched)\s+in\s+\d{4}/i,
  /\b\d[\d,]*\s+(?:employees?|staff|researchers?|members?|people)\b/i,
  /\b(?:raised|received|secured|invested)\s+\$[\d,.]+/i,
  /\bin\s+\d{4},/i, // "In 2023," temporal claims
];

function analyzeContent(content: string): ExtractedIssue[] {
  const body = stripFrontmatter(content);
  const issues: ExtractedIssue[] = [];
  const paragraphs = body.split(/\n\n+/);
  let currentHeading: string | undefined;

  const sectionStats: Map<string, { factualClaims: number; totalSentences: number; uncited: number }> = new Map();

  for (const para of paragraphs) {
    const trimmed = para.trim();

    // Track headings
    const headingMatch = /^#{1,3}\s+(.+)/.exec(trimmed);
    if (headingMatch) {
      currentHeading = headingMatch[1];
      continue;
    }

    // Skip non-prose
    if (trimmed.startsWith('|') || trimmed.startsWith('[^') || trimmed.startsWith('<') ||
        trimmed.startsWith('```') || trimmed.startsWith('import ') || trimmed.startsWith('---')) {
      continue;
    }

    // Split into sentences
    const sentences = trimmed.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20);

    for (const sentence of sentences) {
      const section = currentHeading || 'Overview';
      const stats = sectionStats.get(section) || { factualClaims: 0, totalSentences: 0, uncited: 0 };
      stats.totalSentences++;

      // Check for factual claims
      const isFactual = FACTUAL_CLAIM_PATTERNS.some((p) => p.test(sentence));
      if (isFactual) {
        stats.factualClaims++;
        // Check if cited
        if (!sentence.includes('[^')) {
          stats.uncited++;
          issues.push({
            type: 'uncited-claim',
            description: sentence.slice(0, 120),
            section,
            severity: 'warning',
          });
        }
      }

      // Check for speculation
      for (const pattern of SPECULATION_PATTERNS) {
        if (pattern.test(sentence) && !sentence.includes('[^')) {
          issues.push({
            type: 'speculation',
            description: sentence.slice(0, 120),
            section,
            severity: 'info',
          });
          break;
        }
      }

      // Check for weasel words
      for (const pattern of WEASEL_PATTERNS) {
        if (pattern.test(sentence)) {
          issues.push({
            type: 'weasel-words',
            description: sentence.slice(0, 120),
            section,
            severity: 'info',
          });
          break;
        }
      }

      sectionStats.set(section, stats);
    }
  }

  // Flag sections with low fact density
  for (const [section, stats] of sectionStats) {
    if (stats.totalSentences >= 5 && stats.factualClaims === 0) {
      issues.push({
        type: 'low-fact-density',
        description: `Section "${section}" has ${stats.totalSentences} sentences but no specific facts (dates, numbers, amounts).`,
        section,
        severity: 'info',
      });
    }
  }

  return issues;
}

export const tool: ToolRegistration = {
  name: 'adversarial_review',
  cost: 0,
  definition: {
    name: 'adversarial_review',
    description:
      'Run an adversarial review on the current page: detect uncited factual claims, speculation, weasel words, and low fact-density sections. Use this after rewriting to catch quality issues before finishing. Returns actionable findings sorted by severity. Cost: $0 (local analysis, no LLM).',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  createHandler: (ctx) => async () => {
    try {
      const issues = analyzeContent(ctx.currentContent);

      const bySeverity = {
        critical: issues.filter((i) => i.severity === 'critical').length,
        warning: issues.filter((i) => i.severity === 'warning').length,
        info: issues.filter((i) => i.severity === 'info').length,
      };

      const byType = {
        'uncited-claim': issues.filter((i) => i.type === 'uncited-claim').length,
        speculation: issues.filter((i) => i.type === 'speculation').length,
        'weasel-words': issues.filter((i) => i.type === 'weasel-words').length,
        'low-fact-density': issues.filter((i) => i.type === 'low-fact-density').length,
      };

      return JSON.stringify(
        {
          page_id: ctx.page.id,
          totalIssues: issues.length,
          bySeverity,
          byType,
          // Show top issues, prioritized by severity
          issues: issues
            .sort((a, b) => {
              const order = { critical: 0, warning: 1, info: 2 };
              return order[a.severity] - order[b.severity];
            })
            .slice(0, 20)
            .map((i) => ({
              type: i.type,
              severity: i.severity,
              section: i.section,
              description: i.description,
            })),
          ...(issues.length === 0 && {
            message: 'No adversarial issues detected. Page looks clean.',
          }),
        },
        null,
        2,
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({ error: `Adversarial review failed: ${error.message}` });
    }
  },
};
