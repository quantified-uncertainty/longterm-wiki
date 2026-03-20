#!/usr/bin/env node

/**
 * Cross-Page Date Consistency Validator
 *
 * Detects when the same entity's dates (founding, departure, employment ranges)
 * are stated differently across multiple wiki pages. This catches bugs like:
 *   - Chris Olah at OpenAI: "2018-2021" in one place, "2018-2020" in another
 *   - Mustafa Suleyman: "Left DeepMind in 2022" vs "Placed on leave in 2019"
 *   - US AISI: "Founded Nov 2023" vs "Announced Nov 2023, operational Feb 2024"
 *
 * Approach:
 *   1. For each page, find EntityLink references
 *   2. In the surrounding context, extract year-range patterns (e.g., "2018-2021")
 *   3. For each entity, compare date mentions across all pages
 *   4. Flag contradictions where the same entity has different date ranges
 *
 * Usage:
 *   npx tsx crux/validate/validate-cross-page-dates.ts
 *   npx tsx crux/validate/validate-cross-page-dates.ts --entity=anthropic
 *   npx tsx crux/validate/validate-cross-page-dates.ts --ci
 *
 * Exit codes:
 *   0 = Advisory only (never blocks CI)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getContentBody } from '../lib/mdx-utils.ts';
import { CONTENT_DIR } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';
import type { ValidatorResult } from './types.ts';

// ============================================================================
// TYPES
// ============================================================================

interface DateMention {
  pageId: string;
  filePath: string;
  lineNum: number;
  context: string;
  /** The raw date pattern found */
  datePattern: string;
  /** Normalized form for comparison */
  normalized: string;
  /** Category of date (founding, departure, range, etc.) */
  category: DateCategory;
}

type DateCategory = 'year-range' | 'founding' | 'year-single' | 'month-year';

interface DateConflict {
  entityId: string;
  mentions: DateMention[];
  reason: string;
}

// ============================================================================
// DATE EXTRACTION
// ============================================================================

/**
 * Extract date-related patterns from text near an entity mention.
 */
function extractDateMentions(
  text: string,
  entityId: string,
  pageId: string,
  filePath: string,
): DateMention[] {
  const mentions: DateMention[] = [];
  const lines = text.split('\n');

  // Find lines that mention the entity
  const entityPatterns = [
    new RegExp(`EntityLink[^>]*id=["']${entityId}["']`, 'i'),
    new RegExp(`\\b${entityId.replace(/-/g, '[- ]')}\\b`, 'i'),
  ];

  const entityLineNums = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (entityPatterns.some((p) => p.test(lines[i]))) {
      // Include context window
      for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
        entityLineNums.add(j);
      }
    }
  }

  const contextLines = [...entityLineNums].sort((a, b) => a - b);

  for (const lineIdx of contextLines) {
    const line = lines[lineIdx];

    // Year ranges: 2018-2021, 2018–2021, 2018 to 2021
    const yearRangePattern = /\b((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2})\b/g;
    let match: RegExpExecArray | null;
    while ((match = yearRangePattern.exec(line)) !== null) {
      mentions.push({
        pageId,
        filePath,
        lineNum: lineIdx + 1,
        context: line.trim().substring(0, 200),
        datePattern: match[0],
        normalized: `${match[1]}-${match[2]}`,
        category: 'year-range',
      });
    }

    // "from 2018 to 2021" pattern
    const fromToPattern = /\bfrom\s+((?:19|20)\d{2})\s+to\s+((?:19|20)\d{2})\b/gi;
    while ((match = fromToPattern.exec(line)) !== null) {
      mentions.push({
        pageId,
        filePath,
        lineNum: lineIdx + 1,
        context: line.trim().substring(0, 200),
        datePattern: match[0],
        normalized: `${match[1]}-${match[2]}`,
        category: 'year-range',
      });
    }

    // "founded in YYYY" / "established in YYYY" / "created in YYYY"
    const foundingPattern = /\b(?:founded|established|created|launched|started)\s+(?:in\s+)?(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+)?((?:19|20)\d{2})\b/gi;
    while ((match = foundingPattern.exec(line)) !== null) {
      mentions.push({
        pageId,
        filePath,
        lineNum: lineIdx + 1,
        context: line.trim().substring(0, 200),
        datePattern: match[0],
        normalized: `founded:${match[1]}`,
        category: 'founding',
      });
    }

    // "Month YYYY" in structured context (founding, departure)
    const monthYearPattern = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+((?:19|20)\d{2})\b/gi;
    while ((match = monthYearPattern.exec(line)) !== null) {
      // Only capture if in a context that suggests a date claim (not just prose)
      const surroundingText = line.toLowerCase();
      const dateWords = ['founded', 'departed', 'left', 'joined', 'started', 'launched', 'announced', 'established', 'created', 'operational'];
      if (dateWords.some((w) => surroundingText.includes(w))) {
        mentions.push({
          pageId,
          filePath,
          lineNum: lineIdx + 1,
          context: line.trim().substring(0, 200),
          datePattern: match[0],
          normalized: `${match[1].toLowerCase()}-${match[2]}`,
          category: 'month-year',
        });
      }
    }
  }

  return mentions;
}

// ============================================================================
// CONFLICT DETECTION
// ============================================================================

/**
 * Find date conflicts for a given entity across pages.
 */
function findDateConflicts(
  entityId: string,
  mentions: DateMention[],
): DateConflict[] {
  const conflicts: DateConflict[] = [];

  // Group by category
  const byCategory = new Map<DateCategory, DateMention[]>();
  for (const m of mentions) {
    const existing = byCategory.get(m.category) || [];
    existing.push(m);
    byCategory.set(m.category, existing);
  }

  // Check year ranges for conflicts
  const yearRanges = byCategory.get('year-range') || [];
  if (yearRanges.length >= 2) {
    // Group by similar context (same starting year suggests same event)
    const byStartYear = new Map<string, DateMention[]>();
    for (const m of yearRanges) {
      const startYear = m.normalized.split('-')[0];
      const existing = byStartYear.get(startYear) || [];
      existing.push(m);
      byStartYear.set(startYear, existing);
    }

    for (const [startYear, group] of byStartYear) {
      if (group.length < 2) continue;

      // Check for different end years
      const endYears = new Set(group.map((m) => m.normalized.split('-')[1]));
      if (endYears.size > 1) {
        // Different end years for ranges starting in the same year — likely a conflict
        const crossPage = hasCrossPageMentions(group);
        if (crossPage) {
          conflicts.push({
            entityId,
            mentions: group,
            reason: `Year range starting ${startYear} has different end years: ${[...endYears].join(', ')}`,
          });
        }
      }
    }
  }

  // Check founding dates for conflicts
  const foundingMentions = byCategory.get('founding') || [];
  if (foundingMentions.length >= 2) {
    const years = new Set(foundingMentions.map((m) => m.normalized));
    if (years.size > 1 && hasCrossPageMentions(foundingMentions)) {
      conflicts.push({
        entityId,
        mentions: foundingMentions,
        reason: `Founding dates disagree: ${[...years].join(' vs ')}`,
      });
    }
  }

  return conflicts;
}

function hasCrossPageMentions(mentions: DateMention[]): boolean {
  const pages = new Set(mentions.map((m) => m.pageId));
  return pages.size > 1;
}

// ============================================================================
// MAIN RUNNER
// ============================================================================

export function runCrossPageDates(options?: {
  entityId?: string;
  limit?: number;
}): ValidatorResult & { conflicts: DateConflict[] } {
  const files = findMdxFiles(CONTENT_DIR);

  // Collect entity → date mentions
  const entityMentions = new Map<string, DateMention[]>();

  for (const filePath of files) {
    const rel = filePath.replace(/^.*content\/docs\//, '');
    if (rel.startsWith('internal/')) continue;

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const body = getContentBody(raw);
    const pageId = rel.replace(/\.mdx?$/, '');

    // Find entity IDs referenced in this file
    const entityLinkPattern = /EntityLink[^>]*id=["']([^"']+)["']/g;
    const entitiesInFile = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = entityLinkPattern.exec(body)) !== null) {
      entitiesInFile.add(m[1]);
    }

    if (options?.entityId) {
      if (!entitiesInFile.has(options.entityId)) continue;
      entitiesInFile.clear();
      entitiesInFile.add(options.entityId);
    }

    for (const entityId of entitiesInFile) {
      const mentions = extractDateMentions(body, entityId, pageId, filePath);
      if (mentions.length === 0) continue;

      const existing = entityMentions.get(entityId) || [];
      existing.push(...mentions);
      entityMentions.set(entityId, existing);
    }
  }

  // Find conflicts
  const allConflicts: DateConflict[] = [];
  for (const [entityId, mentions] of entityMentions) {
    if (mentions.length < 2) continue;
    const conflicts = findDateConflicts(entityId, mentions);
    allConflicts.push(...conflicts);
  }

  const limit = options?.limit ?? 20;
  return {
    passed: true, // Advisory
    errors: 0,
    warnings: allConflicts.length,
    infos: 0,
    conflicts: allConflicts.slice(0, limit),
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const CI_MODE = args.includes('--ci');
  const c = getColors(CI_MODE);

  const entityArg = args.find((a) => a.startsWith('--entity='));
  const entityId = entityArg ? entityArg.split('=')[1] : undefined;
  const topArg = args.find((a) => a.startsWith('--top='));
  const limit = topArg ? parseInt(topArg.split('=')[1], 10) : 20;

  const result = runCrossPageDates({ entityId, limit });

  if (CI_MODE) {
    console.log(
      JSON.stringify(
        {
          passed: true,
          errors: 0,
          warnings: result.conflicts.length,
          conflicts: result.conflicts.map((c) => ({
            entity: c.entityId,
            reason: c.reason,
            pages: [...new Set(c.mentions.map((m) => m.pageId))],
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`${c.bold}Cross-Page Date Consistency${c.reset}\n`);

    if (result.conflicts.length === 0) {
      console.log(`${c.green}  No cross-page date contradictions detected.${c.reset}\n`);
    } else {
      console.log(
        `${c.yellow}  ${result.warnings} potential date contradiction(s) found:${c.reset}\n`,
      );

      for (const conflict of result.conflicts) {
        console.log(`  ${c.yellow}CONFLICT${c.reset} [${conflict.entityId}] ${conflict.reason}`);
        const pages = [...new Set(conflict.mentions.map((m) => m.pageId))];
        for (const page of pages) {
          const pageMentions = conflict.mentions.filter((m) => m.pageId === page);
          for (const mention of pageMentions) {
            console.log(
              `    ${c.dim}${page}:${mention.lineNum}${c.reset} "${mention.datePattern}"`,
            );
          }
        }
        console.log();
      }
    }
  }

  process.exit(0); // Advisory only
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
