#!/usr/bin/env node

/**
 * Entity Link Analyzer
 *
 * Analyzes linking status for a specific entity:
 * - Pages that link TO this entity (inbound links via EntityLink)
 * - Pages that MENTION this entity without linking (missing inbound)
 * - Entities mentioned ON this entity's page that aren't linked (missing outbound)
 *
 * Usage:
 *   node tooling/analyze/analyze-entity-links.mjs sam-altman          # Analyze sam-altman
 *   node tooling/analyze/analyze-entity-links.mjs sam-altman --json   # JSON output
 *   node tooling/analyze/analyze-entity-links.mjs --help              # Show help
 *
 * Use this after creating or significantly editing a page to ensure proper cross-linking.
 */

import { readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { findMdxFiles } from '../lib/file-utils.mjs';
import { parseFrontmatter, getContentBody } from '../lib/mdx-utils.mjs';
import { getColors } from '../lib/output.mjs';
import { CONTENT_DIR_ABS as CONTENT_DIR, loadPathRegistry, loadEntities, loadBacklinks } from '../lib/content-types.mjs';

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const HELP_MODE = args.includes('--help');
const colors = getColors(JSON_MODE);

// Get entity ID from args (first non-flag argument)
const entityId = args.find(arg => !arg.startsWith('-'));

function showHelp() {
  console.log(`
${colors.bold}Entity Link Analyzer${colors.reset}

Analyzes linking status for a specific entity to help maintain wiki connectivity.

${colors.bold}Usage:${colors.reset}
  crux analyze entity-links <entity-id>          Analyze entity links
  crux analyze entity-links <entity-id> --json   JSON output

${colors.bold}Output:${colors.reset}
  1. ${colors.green}Inbound links${colors.reset} - Pages that link TO this entity via EntityLink
  2. ${colors.yellow}Missing inbound${colors.reset} - Pages that mention entity name but don't link
  3. ${colors.cyan}Outbound links${colors.reset} - Entities this page links to
  4. ${colors.yellow}Missing outbound${colors.reset} - Entities mentioned but not linked on this page

${colors.bold}Examples:${colors.reset}
  crux analyze entity-links sam-altman
  crux analyze entity-links openai
  crux analyze entity-links scheming --json

${colors.bold}When to use:${colors.reset}
  - After creating a new page
  - After significantly editing a page
  - When reviewing cross-reference coverage
`);
}

/**
 * Find the MDX file for an entity
 */
function findEntityFile(entityId, pathRegistry) {
  const path = pathRegistry[entityId];
  if (!path) return null;

  // Convert URL path to file path
  const relativePath = path.replace(/^\//, '').replace(/\/$/, '');
  const possiblePaths = [
    join(CONTENT_DIR, relativePath + '.mdx'),
    join(CONTENT_DIR, relativePath, 'index.mdx'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Get display name for an entity
 */
function getEntityDisplayName(entityId, entities) {
  const entity = entities.find(e => e.id === entityId);
  return entity?.title || entityId;
}

/**
 * Get search terms for an entity (name + aliases)
 */
function getEntitySearchTerms(entityId, entities) {
  const entity = entities.find(e => e.id === entityId);
  const terms = [entityId];

  if (entity?.title) {
    terms.push(entity.title);
  }
  if (entity?.aliases) {
    terms.push(...entity.aliases);
  }

  // Also add common variations
  const name = entity?.title || entityId;
  if (name.includes('-')) {
    terms.push(name.replace(/-/g, ' '));
  }

  return [...new Set(terms)];
}

/**
 * Find EntityLink usages in content
 */
function findEntityLinks(content) {
  const regex = /<EntityLink\s+id="([^"]+)"/g;
  const links = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1]);
  }
  return [...new Set(links)];
}

/**
 * Check if content mentions search terms (case-insensitive)
 * Returns { found: boolean, context: string } with a snippet of context
 * Filters out matches that appear to be in URLs or markdown link URLs
 */
function contentMentionsTerms(content, terms) {
  const lowerContent = content.toLowerCase();
  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    let searchStart = 0;

    while (true) {
      const index = lowerContent.indexOf(lowerTerm, searchStart);
      if (index === -1) break;

      // Check surrounding context for URL patterns
      const beforeMatch = content.slice(Math.max(0, index - 150), index);
      const afterMatch = content.slice(index, Math.min(content.length, index + term.length + 50));

      // Skip if this looks like it's inside a URL
      const isInUrl = /https?:\/\/[^\s\)]*$/.test(beforeMatch) ||  // Inside http URL
                      /\]\([^\)]*$/.test(beforeMatch) ||           // Inside markdown link URL
                      /href="[^"]*$/.test(beforeMatch) ||          // Inside href
                      /^\S*\)/.test(afterMatch.slice(term.length)); // Followed by ) with no space (end of URL)

      if (!isInUrl) {
        // Extract context (50 chars before and after)
        const start = Math.max(0, index - 50);
        const end = Math.min(content.length, index + term.length + 50);
        let context = content.slice(start, end).replace(/\n/g, ' ').trim();
        if (start > 0) context = '...' + context;
        if (end < content.length) context = context + '...';
        return { found: true, context, term };
      }

      // Continue searching after this match
      searchStart = index + term.length;
    }
  }
  return { found: false, context: '', term: '' };
}

/**
 * Get page slug from file path
 */
function getPageSlug(filePath) {
  const rel = relative(CONTENT_DIR, filePath);
  return rel
    .replace(/\.mdx?$/, '')
    .replace(/\/index$/, '')
    .split('/')
    .pop();
}

/**
 * Analyze entity links
 */
function analyzeEntity(entityId, pathRegistry, entities) {
  const files = findMdxFiles(CONTENT_DIR);
  const searchTerms = getEntitySearchTerms(entityId, entities);
  const entityFile = findEntityFile(entityId, pathRegistry);

  const result = {
    entityId,
    displayName: getEntityDisplayName(entityId, entities),
    searchTerms,
    entityFilePath: entityFile ? relative(CONTENT_DIR, entityFile) : null,
    inbound: [],          // Pages that link to this entity
    missingInbound: [],   // Pages that mention but don't link
    outbound: [],         // Entities this page links to
    missingOutbound: [],  // Entities mentioned but not linked (would need entity-mentions rule)
  };

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const body = getContentBody(content);
      const relPath = relative(CONTENT_DIR, file);
      const slug = getPageSlug(file);

      // Skip the entity's own page for inbound analysis
      const isOwnPage = entityFile && file === entityFile;

      // Check for EntityLink to this entity
      const entityLinks = findEntityLinks(body);
      const linksToEntity = entityLinks.includes(entityId);

      // Check for text mentions (in body only, not frontmatter)
      const mentionResult = contentMentionsTerms(body, searchTerms);

      if (!isOwnPage) {
        if (linksToEntity) {
          result.inbound.push({
            path: relPath,
            title: frontmatter.title || slug,
            importance: frontmatter.importance || 0,
          });
        } else if (mentionResult.found) {
          result.missingInbound.push({
            path: relPath,
            title: frontmatter.title || slug,
            importance: frontmatter.importance || 0,
            context: mentionResult.context,
            matchedTerm: mentionResult.term,
          });
        }
      }

      // For the entity's own page, track outbound links
      if (isOwnPage) {
        result.outbound = entityLinks.map(id => ({
          id,
          name: getEntityDisplayName(id, entities),
        }));
      }
    } catch (err) {
      // Skip files that can't be analyzed
    }
  }

  // Sort by importance
  result.inbound.sort((a, b) => b.importance - a.importance);
  result.missingInbound.sort((a, b) => b.importance - a.importance);

  return result;
}

function main() {
  if (HELP_MODE || !entityId) {
    showHelp();
    process.exit(HELP_MODE ? 0 : 1);
  }

  const pathRegistry = loadPathRegistry();
  const entities = loadEntities();

  // Check if entity exists
  if (!pathRegistry[entityId]) {
    console.error(`${colors.red}Entity not found: ${entityId}${colors.reset}`);
    console.log(`${colors.dim}Run: node tooling/crux.mjs analyze links --page ${entityId}${colors.reset}`);
    process.exit(1);
  }

  const result = analyzeEntity(entityId, pathRegistry, entities);

  if (JSON_MODE) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Print report
  console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}  Entity Link Analysis: ${result.displayName}${colors.reset}`);
  console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

  console.log(`${colors.dim}Entity ID: ${entityId}${colors.reset}`);
  console.log(`${colors.dim}Page: ${result.entityFilePath || 'Not found'}${colors.reset}`);
  console.log(`${colors.dim}Search terms: ${result.searchTerms.join(', ')}${colors.reset}\n`);

  // Inbound links
  console.log(`${colors.bold}${colors.green}✓ Inbound Links${colors.reset} (${result.inbound.length} pages link to this entity):`);
  if (result.inbound.length > 0) {
    for (const page of result.inbound.slice(0, 15)) {
      console.log(`  ${colors.dim}[${page.importance}]${colors.reset} ${page.title}`);
    }
    if (result.inbound.length > 15) {
      console.log(`  ${colors.dim}... and ${result.inbound.length - 15} more${colors.reset}`);
    }
  } else {
    console.log(`  ${colors.dim}No pages link to this entity${colors.reset}`);
  }
  console.log();

  // Missing inbound links
  console.log(`${colors.bold}${colors.yellow}⚠ Missing Inbound${colors.reset} (${result.missingInbound.length} pages mention but don't link):`);
  if (result.missingInbound.length > 0) {
    for (const page of result.missingInbound.slice(0, 12)) {
      console.log(`  ${colors.dim}[${page.importance}]${colors.reset} ${page.title}`);
      if (page.context) {
        // Truncate context and highlight the matched term
        let ctx = page.context.length > 80 ? page.context.slice(0, 80) + '...' : page.context;
        console.log(`    ${colors.dim}"${ctx}"${colors.reset}`);
      }
    }
    if (result.missingInbound.length > 12) {
      console.log(`  ${colors.dim}... and ${result.missingInbound.length - 12} more${colors.reset}`);
    }
  } else {
    console.log(`  ${colors.green}All mentions are linked!${colors.reset}`);
  }
  console.log();

  // Outbound links
  console.log(`${colors.bold}${colors.cyan}→ Outbound Links${colors.reset} (${result.outbound.length} entities linked from this page):`);
  if (result.outbound.length > 0) {
    for (const entity of result.outbound.slice(0, 20)) {
      console.log(`  - ${entity.name} (${entity.id})`);
    }
    if (result.outbound.length > 20) {
      console.log(`  ${colors.dim}... and ${result.outbound.length - 20} more${colors.reset}`);
    }
  } else {
    console.log(`  ${colors.dim}No EntityLinks found on this page${colors.reset}`);
  }
  console.log();

  // Summary
  console.log(`${colors.bold}Summary:${colors.reset}`);
  console.log(`  Inbound: ${result.inbound.length} linked, ${result.missingInbound.length} missing`);
  console.log(`  Outbound: ${result.outbound.length} links`);

  if (result.missingInbound.length > 0) {
    console.log();
    console.log(`${colors.yellow}Suggestion:${colors.reset} Add EntityLinks to the ${result.missingInbound.length} pages that mention "${result.displayName}"`);
  }

  // Exit with error if there are missing inbound links
  if (result.missingInbound.length > 5) {
    process.exit(1);
  }
}

main();
