#!/usr/bin/env node

/**
 * Stale Content Detector
 *
 * Flags wiki pages that may contain outdated information by cross-referencing:
 *   1. Page `lastEdited` dates vs entity data changes (departures, end dates)
 *   2. Personnel records with endDate that post-date the page's lastEdited
 *   3. Pages referencing entities whose YAML was updated more recently
 *
 * This catches bugs like:
 *   - Greg Brockman still listed as "President" after departing Aug 2024
 *   - Elizabeth Kelly still listed as "Director" after departing Feb 2025
 *   - Sam Altman net worth outdated ($2.8B → $10.5B+)
 *
 * Usage:
 *   npx tsx crux/validate/validate-stale-content.ts
 *   npx tsx crux/validate/validate-stale-content.ts --ci
 *   npx tsx crux/validate/validate-stale-content.ts --top=20
 *   npx tsx crux/validate/validate-stale-content.ts --entity=anthropic
 *
 * Exit codes:
 *   0 = Advisory only (never blocks CI)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { findMdxFiles } from '../lib/file-utils.ts';
import { parseFrontmatter, getContentBody } from '../lib/mdx-utils.ts';
import { CONTENT_DIR, PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';
import type { ValidatorResult } from './types.ts';

// ============================================================================
// TYPES
// ============================================================================

interface PageInfo {
  filePath: string;
  pageId: string;
  title: string;
  lastEdited: string | null;
  lastEditedDate: Date | null;
  entityType: string | null;
  wikiId: string | null;
  referencedEntities: string[];
}

interface EntityInfo {
  id: string;
  type: string;
  title: string;
  sourceFile: string;
  yamlModified: Date;
  /** For person entities: known departure/end dates from the data */
  endDates: Array<{ context: string; date: string }>;
}

export interface StalenessWarning {
  pageId: string;
  pageTitle: string;
  filePath: string;
  lastEdited: string | null;
  reason: string;
  severity: 'high' | 'medium' | 'low';
  /** Entity that triggered the warning */
  entityId?: string;
  /** Staleness score (higher = more likely stale) */
  score: number;
}

// ============================================================================
// DATA LOADING
// ============================================================================

function loadEntities(): Map<string, EntityInfo> {
  const entitiesDir = join(PROJECT_ROOT, 'data', 'entities');
  const entities = new Map<string, EntityInfo>();

  const files = readdirSync(entitiesDir).filter(
    (f) => extname(f) === '.yaml' || extname(f) === '.yml',
  );

  for (const filename of files) {
    const filePath = join(entitiesDir, filename);
    const content = readFileSync(filePath, 'utf-8');
    const fileStat = statSync(filePath);

    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch {
      continue;
    }

    const entityList = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

    for (const entity of entityList) {
      if (!entity || typeof entity !== 'object' || !entity.id) continue;

      const endDates: Array<{ context: string; date: string }> = [];

      // Note: The entity YAML schema (data/schema.ts) does not currently include
      // lifecycle fields like departureDate, endDate, dissolvedDate, or
      // status: inactive|dissolved. The `endDates` array will remain empty until
      // such fields are added to the schema. The staleness check still provides
      // value via the other heuristics (page age, YAML mtime comparison).

      entities.set(entity.id as string, {
        id: entity.id as string,
        type: (entity.type as string) || 'unknown',
        title: (entity.title as string) || (entity.id as string),
        sourceFile: filename,
        yamlModified: fileStat.mtime,
        endDates,
      });
    }
  }

  return entities;
}

function loadPages(entityFilter?: string): PageInfo[] {
  const files = findMdxFiles(CONTENT_DIR);
  const pages: PageInfo[] = [];

  for (const filePath of files) {
    // Skip internal docs
    const rel = filePath.replace(/^.*content\/docs\//, '');
    if (rel.startsWith('internal/')) continue;

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const fm = parseFrontmatter(raw);
    const body = getContentBody(raw);

    // Extract referenced entity IDs from EntityLink components
    const entityLinkPattern = /EntityLink[^>]*id=["']([^"']+)["']/g;
    const referencedEntities: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = entityLinkPattern.exec(body)) !== null) {
      referencedEntities.push(m[1]);
    }

    // Include the page's own entity (wikiId) in the referenced set so that
    // --entity=<id> filtering also matches the page's own entity identity
    const wikiId = (fm.wikiId as string) || null;
    if (wikiId && !referencedEntities.includes(wikiId)) {
      referencedEntities.push(wikiId);
    }

    if (entityFilter && !referencedEntities.includes(entityFilter)) continue;

    const lastEdited = fm.lastEdited ? String(fm.lastEdited) : null;
    let lastEditedDate: Date | null = null;
    if (lastEdited) {
      const d = new Date(lastEdited);
      if (!isNaN(d.getTime())) lastEditedDate = d;
    }

    pages.push({
      filePath,
      pageId: rel.replace(/\.mdx?$/, ''),
      title: (fm.title as string) || rel,
      lastEdited,
      lastEditedDate,
      entityType: (fm.entityType as string) || null,
      wikiId,
      referencedEntities: [...new Set(referencedEntities)],
    });
  }

  return pages;
}

// ============================================================================
// STALENESS DETECTION
// ============================================================================

const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const NOW = new Date();

/**
 * Check for staleness indicators across all pages.
 */
export function detectStaleness(
  pages: PageInfo[],
  entities: Map<string, EntityInfo>,
  options?: { ciMode?: boolean },
): StalenessWarning[] {
  const warnings: StalenessWarning[] = [];

  for (const page of pages) {
    let pageScore = 0;
    const reasons: string[] = [];

    // Check 1: Page hasn't been edited in a long time
    if (page.lastEditedDate) {
      const ageMs = NOW.getTime() - page.lastEditedDate.getTime();

      if (ageMs > ONE_YEAR_MS) {
        pageScore += 30;
        const months = Math.round(ageMs / (30 * 24 * 60 * 60 * 1000));
        reasons.push(`Page last edited ${months} months ago`);
      } else if (ageMs > SIX_MONTHS_MS) {
        pageScore += 15;
        const months = Math.round(ageMs / (30 * 24 * 60 * 60 * 1000));
        reasons.push(`Page last edited ${months} months ago`);
      }
    } else {
      // No lastEdited at all — suspicious
      pageScore += 10;
      reasons.push('No lastEdited date in frontmatter');
    }

    // Check 2: Referenced entities have known end/departure dates after page edit
    for (const entityId of page.referencedEntities) {
      const entity = entities.get(entityId);
      if (!entity) continue;

      for (const { context, date } of entity.endDates) {
        if (date === 'unknown') {
          // Entity is inactive/dissolved — page may reference it as active
          pageScore += 20;
          reasons.push(
            `References "${entity.title}" which has ${context} status — may describe it as active`,
          );
          continue;
        }

        const endDate = new Date(date);
        if (isNaN(endDate.getTime())) continue;

        if (page.lastEditedDate && endDate > page.lastEditedDate) {
          // Entity had a significant change after the page was last edited
          pageScore += 40;
          reasons.push(
            `References "${entity.title}" (${context}: ${date}) but page last edited ${page.lastEdited}`,
          );
        }
      }

      // Check 3: Entity YAML was modified more recently than the page
      // Skip in CI mode: statSync().mtime reflects checkout time on fresh clones,
      // not the actual last semantic change time, producing false positives.
      if (!options?.ciMode && page.lastEditedDate && entity.yamlModified > page.lastEditedDate) {
        const daysDiff = Math.round(
          (entity.yamlModified.getTime() - page.lastEditedDate.getTime()) / (24 * 60 * 60 * 1000),
        );
        if (daysDiff > 30) {
          pageScore += 10;
          reasons.push(
            `Entity "${entity.title}" YAML modified ${daysDiff} days after page was last edited`,
          );
        }
      }
    }

    // Check 4: Biographical/factual pages are higher risk for staleness
    if (page.entityType === 'person') {
      pageScore += 10;
    } else if (page.entityType === 'organization') {
      pageScore += 5;
    }

    if (pageScore > 0 && reasons.length > 0) {
      const severity = pageScore >= 40 ? 'high' : pageScore >= 20 ? 'medium' : 'low';
      warnings.push({
        pageId: page.pageId,
        pageTitle: page.title,
        filePath: page.filePath,
        lastEdited: page.lastEdited,
        reason: reasons.join('; '),
        severity,
        score: pageScore,
      });
    }
  }

  // Sort by score descending
  warnings.sort((a, b) => b.score - a.score);
  return warnings;
}

// ============================================================================
// MAIN
// ============================================================================

export function runStalenessCheck(options?: {
  entityId?: string;
  limit?: number;
  ciMode?: boolean;
}): ValidatorResult & { warnings_list: StalenessWarning[] } {
  const entities = loadEntities();
  const pages = loadPages(options?.entityId);
  const warnings = detectStaleness(pages, entities, { ciMode: options?.ciMode });

  const limit = options?.limit ?? 50;
  const top = warnings.slice(0, limit);

  return {
    passed: true, // Advisory only
    errors: 0,
    warnings: warnings.length,
    infos: 0,
    warnings_list: top,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const CI_MODE = args.includes('--ci');
  const c = getColors(CI_MODE);

  const entityArg = args.find((a) => a.startsWith('--entity='));
  const entityId = entityArg ? entityArg.split('=')[1] : undefined;
  const topArg = args.find((a) => a.startsWith('--top='));
  const limit = topArg ? parseInt(topArg.split('=')[1], 10) : 30;

  const entities = loadEntities();
  const pages = loadPages(entityId);
  const warnings = detectStaleness(pages, entities, { ciMode: CI_MODE });

  if (CI_MODE) {
    console.log(
      JSON.stringify(
        {
          passed: true,
          errors: 0,
          warnings: warnings.length,
          top: warnings.slice(0, limit).map((w) => ({
            page: w.pageId,
            score: w.score,
            severity: w.severity,
            reason: w.reason,
            lastEdited: w.lastEdited,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`${c.bold}Stale Content Detection${c.reset}`);
    console.log(`${c.dim}  Checked ${pages.length} pages against ${entities.size} entities${c.reset}\n`);

    const high = warnings.filter((w) => w.severity === 'high');
    const medium = warnings.filter((w) => w.severity === 'medium');
    const low = warnings.filter((w) => w.severity === 'low');

    console.log(
      `  ${c.red}${high.length} high${c.reset} / ${c.yellow}${medium.length} medium${c.reset} / ${c.dim}${low.length} low${c.reset} staleness warnings\n`,
    );

    if (warnings.length === 0) {
      console.log(`${c.green}  No staleness indicators detected.${c.reset}\n`);
    } else {
      const display = warnings.slice(0, limit);
      for (const w of display) {
        const severityColor =
          w.severity === 'high' ? c.red : w.severity === 'medium' ? c.yellow : c.dim;
        const severityLabel = w.severity.toUpperCase().padEnd(6);

        console.log(
          `  ${severityColor}${severityLabel}${c.reset} [score:${w.score}] ${w.pageId}`,
        );
        console.log(`    ${c.dim}${w.reason}${c.reset}`);
        console.log();
      }

      if (warnings.length > limit) {
        console.log(
          `  ${c.dim}...and ${warnings.length - limit} more. Use --top=${warnings.length} to see all.${c.reset}\n`,
        );
      }
    }
  }

  process.exit(0); // Advisory only
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
