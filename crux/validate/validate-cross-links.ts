#!/usr/bin/env node

/**
 * Cross-Link Validator
 *
 * Validates that pages have adequate cross-linking to related entities.
 * Uses the entity-mentions rule to find unlinked entity references.
 *
 * Usage:
 *   npm run crux -- validate cross-links              # Run full check
 *   npm run crux -- validate cross-links --ci         # CI mode (exit 1 if issues)
 *   npm run crux -- validate cross-links --threshold 10  # Custom threshold
 *
 * This helps ensure new pages are properly integrated into the wiki's link graph.
 */

import { readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { findMdxFiles } from '../lib/file-utils.ts';
import { parseFrontmatter, getContentBody } from '../lib/mdx-utils.ts';
import { getColors } from '../lib/output.ts';
import {
  PROJECT_ROOT,
  CONTENT_DIR_ABS as CONTENT_DIR,
  DATA_DIR_ABS as DATA_DIR,
  loadPathRegistry,
  loadDatabase,
  type PathRegistry,
  type DatabaseSchema,
  type OrganizationEntry,
  type ExpertEntry,
} from '../lib/content-types.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';

const args: string[] = process.argv.slice(2);
const CI_MODE: boolean = args.includes('--ci');
const JSON_MODE: boolean = args.includes('--json');
const HELP_MODE: boolean = args.includes('--help');

// Default: warn if any page has more than 3 unlinked high-importance entity mentions
const thresholdArg: string | undefined = args.find((a: string) => a.startsWith('--threshold'));
const THRESHOLD: number = thresholdArg ? parseInt(thresholdArg.split('=')[1]) || 3 : 3;

const colors = getColors(JSON_MODE);

function showHelp(): void {
  console.log(`
${colors.bold}Cross-Link Validator${colors.reset}

Checks for pages that mention known entities without linking to them.
This helps ensure wiki pages are properly cross-referenced.

${colors.bold}Usage:${colors.reset}
  crux validate cross-links              Run validation
  crux validate cross-links --ci         CI mode (exit 1 if threshold exceeded)
  crux validate cross-links --threshold=5   Custom threshold per page
  crux validate cross-links --json       JSON output

${colors.bold}What it checks:${colors.reset}
  - Finds mentions of entity names that aren't wrapped in EntityLink
  - Reports pages with high numbers of missing links
  - In CI mode, fails if any page exceeds the threshold

${colors.bold}Fixing issues:${colors.reset}
  1. Run: crux analyze entity-links <entity-id>
  2. Add <EntityLink id="entity-id"> around mentions
  3. Or run: crux fix entity-links (auto-fix some cases)
`);
}

/**
 * Entity lookup entry mapping a term to its entity ID and display name.
 */
interface EntityLookupEntry {
  id: string;
  name: string;
}

/**
 * An unlinked mention of an entity in page content.
 */
interface UnlinkedMention {
  id: string;
  name: string;
  count: number;
  context: string;
}

/**
 * Result for a single page's cross-link analysis.
 */
interface PageCrossLinkResult {
  path: string;
  title: string;
  importance: number;
  unlinkedCount: number;
  unlinked: UnlinkedMention[];
}

/**
 * Loaded data from path registry and database.
 */
interface LoadedData {
  pathRegistry: PathRegistry;
  database: DatabaseSchema;
}

/**
 * Load path registry and database
 */
function loadData(): LoadedData {
  const pathRegistry: PathRegistry = loadPathRegistry();
  const database: DatabaseSchema = loadDatabase();

  // Ensure expected shape for downstream consumers
  if (!database.entities) database.entities = [];
  if (!database.experts) database.experts = [];
  if (!database.organizations) database.organizations = [];

  return { pathRegistry, database };
}

/**
 * Build entity lookup from database
 */
function buildEntityLookup(database: DatabaseSchema, pathRegistry: PathRegistry): Map<string, EntityLookupEntry> {
  const lookup = new Map<string, EntityLookupEntry>();

  // Add organizations
  for (const org of (database.organizations || []) as Array<OrganizationEntry & { shortName?: string }>) {
    if (org.name && org.id && pathRegistry[org.id]) {
      lookup.set(org.name.toLowerCase(), { id: org.id, name: org.name });
      if (org.shortName) {
        lookup.set(org.shortName.toLowerCase(), { id: org.id, name: org.shortName });
      }
    }
  }

  // Add experts (people)
  for (const expert of (database.experts || [])) {
    if (expert.name && expert.id && pathRegistry[expert.id]) {
      lookup.set(expert.name.toLowerCase(), { id: expert.id, name: expert.name });
    }
  }

  return lookup;
}

/**
 * Find EntityLinks in content
 */
function findEntityLinks(content: string): Set<string> {
  const regex = /<EntityLink\s+id="([^"]+)"/g;
  const links = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    links.add(match[1]);
  }
  return links;
}

/**
 * Find unlinked entity mentions
 */
function findUnlinkedMentions(
  content: string,
  entityLookup: Map<string, EntityLookupEntry>,
  existingLinks: Set<string>,
  pageEntityId: string | undefined
): UnlinkedMention[] {
  const unlinked = new Map<string, UnlinkedMention>(); // entityId -> { count, firstContext }

  for (const [term, entity] of entityLookup) {
    // Skip if this is the page's own entity
    if (entity.id === pageEntityId) continue;

    // Skip if already linked
    if (existingLinks.has(entity.id)) continue;

    // Skip very short terms
    if (term.length < 4) continue;

    // Search for mentions (case-insensitive, word boundaries)
    const escaped: string = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');

    let match: RegExpExecArray | null;
    let count = 0;
    let firstContext = '';

    while ((match = regex.exec(content)) !== null) {
      // Skip if in code block or JSX tag
      const before: string = content.slice(Math.max(0, match.index - 50), match.index);
      if (before.includes('<EntityLink') || before.includes('```') || before.includes('`')) {
        continue;
      }

      count++;
      if (!firstContext) {
        const start: number = Math.max(0, match.index - 30);
        const end: number = Math.min(content.length, match.index + term.length + 30);
        firstContext = content.slice(start, end).replace(/\n/g, ' ').trim();
      }
    }

    if (count > 0 && !unlinked.has(entity.id)) {
      unlinked.set(entity.id, {
        id: entity.id,
        name: entity.name,
        count,
        context: firstContext
      });
    }
  }

  return [...unlinked.values()];
}

/**
 * Get page entity ID from file path
 */
function getPageEntityId(filePath: string): string | undefined {
  const rel: string = relative(CONTENT_DIR, filePath);
  return rel
    .replace(/\.mdx?$/, '')
    .replace(/\/index$/, '')
    .split('/')
    .pop();
}

/**
 * Run the cross-link check and return a ValidatorResult.
 */
export async function runCheck(options: ValidatorOptions = {}): Promise<ValidatorResult> {
  const { pathRegistry, database } = loadData();
  const entityLookup = buildEntityLookup(database, pathRegistry);
  const files: string[] = findMdxFiles(CONTENT_DIR);
  const results: PageCrossLinkResult[] = [];

  for (const file of files) {
    try {
      const content: string = readFileSync(file, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const body: string = getContentBody(content);

      if (frontmatter.pageType === 'stub' || frontmatter.pageType === 'documentation') {
        continue;
      }

      const pageEntityId: string | undefined = getPageEntityId(file);
      const existingLinks: Set<string> = findEntityLinks(body);
      const unlinked: UnlinkedMention[] = findUnlinkedMentions(body, entityLookup, existingLinks, pageEntityId);

      if (unlinked.length > 0) {
        results.push({
          path: relative(CONTENT_DIR, file),
          title: (frontmatter.title as string) || pageEntityId || '',
          importance: (frontmatter.importance as number) || 0,
          unlinkedCount: unlinked.length,
          unlinked: unlinked.slice(0, 5),
        });
      }
    } catch {
      // Skip files that can't be analyzed
    }
  }

  results.sort((a: PageCrossLinkResult, b: PageCrossLinkResult) => b.unlinkedCount - a.unlinkedCount);

  const overThreshold: PageCrossLinkResult[] = results.filter((r: PageCrossLinkResult) => r.unlinkedCount > THRESHOLD);
  const totalWarnings: number = results.length;

  return {
    passed: overThreshold.length === 0,
    errors: overThreshold.length,
    warnings: totalWarnings - overThreshold.length,
  };
}

async function main(): Promise<void> {
  if (HELP_MODE) {
    showHelp();
    process.exit(0);
  }

  console.log(`${colors.bold}${colors.blue}Cross-Link Validator${colors.reset}\n`);

  const { pathRegistry, database } = loadData();
  const entityLookup = buildEntityLookup(database, pathRegistry);

  console.log(`${colors.dim}Loaded ${entityLookup.size} entity terms to check${colors.reset}\n`);

  const files: string[] = findMdxFiles(CONTENT_DIR);
  const results: PageCrossLinkResult[] = [];

  for (const file of files) {
    try {
      const content: string = readFileSync(file, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const body: string = getContentBody(content);

      // Skip stubs and documentation
      if (frontmatter.pageType === 'stub' || frontmatter.pageType === 'documentation') {
        continue;
      }

      const pageEntityId: string | undefined = getPageEntityId(file);
      const existingLinks: Set<string> = findEntityLinks(body);
      const unlinked: UnlinkedMention[] = findUnlinkedMentions(body, entityLookup, existingLinks, pageEntityId);

      if (unlinked.length > 0) {
        results.push({
          path: relative(CONTENT_DIR, file),
          title: (frontmatter.title as string) || pageEntityId || '',
          importance: (frontmatter.importance as number) || 0,
          unlinkedCount: unlinked.length,
          unlinked: unlinked.slice(0, 5), // Top 5
        });
      }
    } catch {
      // Skip files that can't be analyzed
    }
  }

  // Sort by number of unlinked mentions
  results.sort((a: PageCrossLinkResult, b: PageCrossLinkResult) => b.unlinkedCount - a.unlinkedCount);

  if (JSON_MODE) {
    console.log(JSON.stringify({ results, threshold: THRESHOLD }, null, 2));
    process.exit(0);
  }

  // Report results
  const overThreshold: PageCrossLinkResult[] = results.filter((r: PageCrossLinkResult) => r.unlinkedCount > THRESHOLD);
  const total: number = results.reduce((sum: number, r: PageCrossLinkResult) => sum + r.unlinkedCount, 0);

  if (results.length === 0) {
    console.log(`${colors.green}✓ All pages have adequate cross-linking${colors.reset}`);
    process.exit(0);
  }

  console.log(`${colors.yellow}Found ${total} unlinked entity mentions across ${results.length} pages${colors.reset}\n`);

  // Show top offenders
  console.log(`${colors.bold}Pages with most missing cross-links:${colors.reset}`);
  for (const page of results.slice(0, 15)) {
    const marker: string = page.unlinkedCount > THRESHOLD ? colors.red + '!' : colors.yellow + '○';
    console.log(`  ${marker}${colors.reset} ${page.title} (${page.unlinkedCount} missing)`);
    for (const entity of page.unlinked.slice(0, 3)) {
      console.log(`    ${colors.dim}- ${entity.name}${colors.reset}`);
    }
  }

  if (results.length > 15) {
    console.log(`  ${colors.dim}... and ${results.length - 15} more pages${colors.reset}`);
  }

  console.log();
  console.log(`${colors.bold}To fix:${colors.reset}`);
  console.log(`  1. Run: ${colors.cyan}npm run crux -- analyze entity-links <entity-id>${colors.reset}`);
  console.log(`  2. Add EntityLinks to appropriate mentions`);
  console.log(`  3. Or run: ${colors.cyan}npm run crux -- fix entity-links${colors.reset} for auto-fix`);

  // CI mode: fail if over threshold
  if (CI_MODE && overThreshold.length > 0) {
    console.log();
    console.log(`${colors.red}CI FAILURE: ${overThreshold.length} pages exceed threshold of ${THRESHOLD} missing links${colors.reset}`);
    process.exit(1);
  }

  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
