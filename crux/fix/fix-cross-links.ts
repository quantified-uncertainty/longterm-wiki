#!/usr/bin/env node

/**
 * Cross-Link Auto-Fixer
 *
 * Automatically adds EntityLinks to plain text mentions of known entities.
 * Uses two-phase matching:
 *   1. Exact matches (high confidence, applied automatically)
 *   2. Fuzzy matches via noun extraction (suggestions only)
 *
 * Usage:
 *   node crux/crux.mjs fix cross-links              # Preview changes
 *   node crux/crux.mjs fix cross-links --apply      # Apply changes
 *   node crux/crux.mjs fix cross-links --verbose    # Show detailed matches
 *   node crux/crux.mjs fix cross-links --file path  # Fix single file
 *   node crux/crux.mjs fix cross-links --fuzzy      # Include fuzzy suggestions
 *
 * Rules:
 *   - Only links FIRST mention of each entity per page
 *   - Skips mentions already in EntityLink, URLs, code blocks, JSX tags
 *   - Skips the entity's own page (no self-links)
 *   - Exact matches: case-insensitive with word boundaries
 *   - Fuzzy matches: extracts proper nouns, uses Levenshtein distance
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { findMdxFiles } from '../lib/file-utils.ts';
import { parseFrontmatter } from '../lib/mdx-utils.ts';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT, CONTENT_DIR_ABS as CONTENT_DIR, loadPathRegistry, loadOrganizations, loadExperts } from '../lib/content-types.ts';
import { logBulkFixes } from '../lib/edit-log.ts';
import { ENTITY_LINK_RE } from '../lib/patterns.ts';

const args: string[] = process.argv.slice(2);
const APPLY_MODE: boolean = args.includes('--apply');
const VERBOSE: boolean = args.includes('--verbose');
const HELP: boolean = args.includes('--help');
const FUZZY_MODE: boolean = args.includes('--fuzzy');
const SINGLE_FILE: string | undefined = args.find(a => a.startsWith('--file='))?.split('=')[1];

const colors = getColors();

interface EntityEntry {
  id: string;
  displayName: string;
  priority: number;
  termLength: number;
}

interface ProperNoun {
  text: string;
  originalText: string;
  position: number;
}

interface FuzzyMatch {
  noun: string;
  originalText: string;
  position: number;
  suggestedEntity: EntityEntry;
  matchedTerm: string;
  score: number;
}

interface ExactChange {
  entityId: string;
  originalText: string;
  line: number;
  context: string;
}

interface ProcessResult {
  changes: ExactChange[];
  modifiedContent?: string;
  originalContent?: string;
  fuzzySuggestions?: FuzzyMatch[];
  skipped?: string;
}

/**
 * Levenshtein distance for fuzzy matching
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Calculate similarity ratio (0-1)
 */
function similarity(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  const distance = levenshteinDistance(aLower, bLower);
  const maxLen = Math.max(aLower.length, bLower.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

/**
 * Extract proper nouns (capitalized words/phrases) from text
 * Returns array of { text, position }
 */
function extractProperNouns(content: string): ProperNoun[] {
  const nouns: ProperNoun[] = [];

  // Match sequences of capitalized words (potential proper nouns)
  // Includes possessives like "Anthropic's"
  const regex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:'s)?)\b/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const text = match[1].replace(/'s$/, ''); // Strip possessive
    if (text.length >= 4) {
      nouns.push({
        text,
        originalText: match[1],
        position: match.index,
      });
    }
  }

  // Also match acronyms (all caps, 3+ letters)
  const acronymRegex = /\b([A-Z]{3,})\b/g;
  while ((match = acronymRegex.exec(content)) !== null) {
    nouns.push({
      text: match[1],
      originalText: match[1],
      position: match.index,
    });
  }

  return nouns;
}

/**
 * Find fuzzy matches for proper nouns against entity names
 */
function findFuzzyMatches(nouns: ProperNoun[], entities: Map<string, EntityEntry>, threshold: number = 0.8): FuzzyMatch[] {
  const matches: FuzzyMatch[] = [];
  const seen = new Set<string>();

  for (const noun of nouns) {
    if (seen.has(noun.text.toLowerCase())) continue;

    let bestMatch: { entity: EntityEntry; term: string; score: number } | null = null;
    let bestScore = 0;

    for (const [term, entity] of entities) {
      const score = similarity(noun.text, term);
      if (score >= threshold && score > bestScore && score < 1.0) {
        // Score < 1.0 means it's not an exact match (those are handled separately)
        bestMatch = { entity, term, score };
        bestScore = score;
      }
    }

    if (bestMatch) {
      matches.push({
        noun: noun.text,
        originalText: noun.originalText,
        position: noun.position,
        suggestedEntity: bestMatch.entity,
        matchedTerm: bestMatch.term,
        score: bestMatch.score,
      });
      seen.add(noun.text.toLowerCase());
    }
  }

  return matches;
}

function showHelp(): void {
  console.log(`
${colors.bold}Cross-Link Auto-Fixer${colors.reset}

Adds EntityLinks to plain text mentions of known entities.

${colors.bold}Usage:${colors.reset}
  crux fix cross-links              Preview exact match changes (dry run)
  crux fix cross-links --apply      Apply exact match changes to files
  crux fix cross-links --fuzzy      Also show fuzzy match suggestions
  crux fix cross-links --verbose    Show detailed match info
  crux fix cross-links --file=path  Fix single file only

${colors.bold}Matching modes:${colors.reset}
  Exact matches (default):
    - Case-insensitive exact name matches
    - High confidence, safe to auto-apply

  Fuzzy matches (--fuzzy):
    - Extracts proper nouns (capitalized words)
    - Uses Levenshtein distance to find similar entity names
    - Shows suggestions only (review before applying)
    - Catches: possessives ("Anthropic's"), typos, variations

${colors.bold}Safety:${colors.reset}
  - Preserves original casing in link text
  - Skips ambiguous contexts (code, URLs, existing links)
  - Only links first mention per entity per page
`);
}

/**
 * Load entities from generated JSON files and path registry
 */
function loadEntityLookup(): Map<string, EntityEntry> {
  const pathRegistry = loadPathRegistry();

  if (Object.keys(pathRegistry).length === 0) {
    console.error('Error: pathRegistry.json is empty after auto-build. Check data/ directory for issues.');
    process.exit(1);
  }

  const organizations = loadOrganizations();
  const experts = loadExperts();

  // Build entity lookup: searchTerm -> { id, displayName, priority }
  const entities = new Map<string, EntityEntry>();

  // Priority: longer names first (to match "Google DeepMind" before "DeepMind")
  const addEntity = (term: string, id: string, displayName: string, priority: number = 0): void => {
    if (!term || term.length < 4) return; // Skip very short terms
    if (!pathRegistry[id]) return; // Must have a page

    const key = term.toLowerCase();
    const existing = entities.get(key);
    if (!existing || priority > existing.priority) {
      entities.set(key, { id, displayName: displayName || term, priority, termLength: term.length });
    }
  };

  // Add organizations (highest priority)
  for (const org of organizations) {
    if (org.name && org.id) {
      addEntity(org.name, org.id, org.name, 100 + org.name.length);
      if (org.shortName && org.shortName.length >= 4) {
        addEntity(org.shortName, org.id, org.shortName, 50 + org.shortName.length);
      }
    }
  }

  // Add people
  for (const expert of experts) {
    if (expert.name && expert.id) {
      addEntity(expert.name, expert.id, expert.name, 80 + expert.name.length);
    }
  }

  // Add common aliases (full names and acronyms)
  const aliases: Record<string, string> = {
    // Organizations - full names
    'Machine Intelligence Research Institute': 'miri',
    'Center for AI Safety': 'cais',
    'Centre for AI Safety': 'cais',
    'Future of Humanity Institute': 'fhi',
    'Center for Human-Compatible AI': 'chai',
    'Centre for the Governance of AI': 'govai',
    'Alignment Research Center': 'arc',
    'Redwood Research': 'redwood-research',
    'Apollo Research': 'apollo-research',
    'Centre for Effective Altruism': 'cea',
    'Center for Effective Altruism': 'cea',
    'Future of Life Institute': 'fli',
    'Global Catastrophic Risk Institute': 'gcri',
    'Center for Security and Emerging Technology': 'cset',
    'Centre for Long-Term Resilience': 'cltr',
    'Berkeley Existential Risk Initiative': 'beri',
    'Existential Risk Observatory': 'ero',

    // Organizations - acronyms
    'MIRI': 'miri',
    'CFAR': 'center-for-applied-rationality',
    'CHAI': 'chai',
    'CAIS': 'cais',
    'GovAI': 'govai',
    'METR': 'metr',
    'LTFF': 'ltff',
    'SERI': 'seri-mats',
    'AISC': 'aisc',
    'BERI': 'beri',
    'CSET': 'cset',
    'CLTR': 'cltr',
    'GCRI': 'gcri',

    // Labs
    'Google DeepMind': 'deepmind',
    'OpenAI': 'openai',

    // Funders
    'Open Phil': 'open-philanthropy',
    'SFF': 'sff',

    // Community
    'EA Forum': 'ea-forum',
    'Alignment Forum': 'alignment-forum',
    'EAG': 'ea-global',
    'EAGx': 'ea-global',

    // Concepts - alternate names
    'RLHF': 'rlhf',
    'RSPs': 'responsible-scaling-policies',
    'RSP': 'responsible-scaling-policies',
  };

  for (const [alias, id] of Object.entries(aliases)) {
    if (pathRegistry[id]) {
      addEntity(alias, id, alias, 90 + alias.length);
    }
  }

  // Add all MDX pages by their frontmatter title (lower priority than YAML entities)
  // This catches pages that don't have YAML entries
  for (const [id, urlPath] of Object.entries(pathRegistry)) {
    if (id.startsWith('__index__')) continue;

    // Skip if already added from YAML data
    if ([...entities.values()].some(e => e.id === id)) continue;

    // Find the MDX file for this entity
    const mdxPath = join(CONTENT_DIR, urlPath.replace(/^\//, '').replace(/\/$/, '') + '.mdx');
    if (!existsSync(mdxPath)) continue;

    try {
      const content = readFileSync(mdxPath, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const title = frontmatter?.title as string | undefined;

      if (title && title.length >= 4) {
        // Add by title (medium priority - after YAML orgs/people but before aliases)
        addEntity(title, id, title, 60 + title.length);
      }
    } catch (_e) {
      // Skip files that can't be parsed
    }
  }

  // Sort by term length descending (match longer terms first)
  const sorted = [...entities.entries()].sort((a, b) => b[1].termLength - a[1].termLength);
  return new Map(sorted);
}

/**
 * Check if position is in a context where we shouldn't add links
 */
function isInProtectedContext(content: string, position: number): boolean {
  const before = content.slice(0, position);

  // In code block
  const codeBlocksBefore = (before.match(/```/g) || []).length;
  if (codeBlocksBefore % 2 === 1) return true;

  // In inline code
  const lastBacktick = before.lastIndexOf('`');
  const lastDoubleBacktick = before.lastIndexOf('``');
  if (lastBacktick > lastDoubleBacktick) {
    const afterBacktick = before.slice(lastBacktick + 1);
    if (!afterBacktick.includes('`')) return true;
  }

  // In EntityLink
  const lastEntityLinkOpen = before.lastIndexOf('<EntityLink');
  const lastEntityLinkClose = before.lastIndexOf('</EntityLink>');
  if (lastEntityLinkOpen > lastEntityLinkClose) return true;

  // In JSX tag (between < and >)
  const lastTagOpen = before.lastIndexOf('<');
  const lastTagClose = before.lastIndexOf('>');
  if (lastTagOpen > lastTagClose) return true;

  // In markdown link text [text] or URL (url)
  const lastBracketOpen = before.lastIndexOf('[');
  const lastBracketClose = before.lastIndexOf(']');
  if (lastBracketOpen > lastBracketClose) return true;

  // In markdown link URL
  if (/\]\([^)]*$/.test(before)) return true;

  // In URL (http://... or https://...)
  if (/https?:\/\/[^\s]*$/.test(before)) return true;

  // In frontmatter
  const frontmatterEnd = content.indexOf('---', 3);
  if (frontmatterEnd > 0 && position < frontmatterEnd) return true;

  // In JSX expression (inside curly braces in JSX)
  // Count unmatched { and } before position
  let braceDepth = 0;
  for (let i = 0; i < position; i++) {
    if (content[i] === '{') braceDepth++;
    else if (content[i] === '}') braceDepth--;
  }
  if (braceDepth > 0) return true;

  // In import statement
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = content.slice(lineStart, content.indexOf('\n', position));
  if (line.trim().startsWith('import ')) return true;

  return false;
}

/**
 * Find and fix entity mentions in a file
 */
function processFile(filePath: string, entities: Map<string, EntityEntry>, pageEntityId: string): ProcessResult {
  const content = readFileSync(filePath, 'utf-8');
  const frontmatter = parseFrontmatter(content);

  // Skip stubs, documentation, and internal pages
  if (frontmatter.pageType === 'stub' || frontmatter.pageType === 'documentation' || frontmatter.entityType === 'internal') {
    return { changes: [], skipped: 'pageType' };
  }

  // Find the body start (after frontmatter and imports)
  const frontmatterEnd = content.indexOf('---', 3) + 3;
  let bodyStart = frontmatterEnd;

  // Skip past import statements
  const afterFrontmatter = content.slice(frontmatterEnd);
  const importMatch = afterFrontmatter.match(/^(\s*import\s+.*\n)+/);
  if (importMatch) {
    bodyStart = frontmatterEnd + importMatch[0].length;
  }

  const changes: ExactChange[] = [];
  const linkedEntities = new Set<string>();
  let modifiedContent = content;
  let offset = 0;

  // Find existing EntityLinks to avoid duplicates
  const existingLinks = new Set<string>();
  for (const linkMatch of content.matchAll(ENTITY_LINK_RE)) {
    existingLinks.add(linkMatch[1]);
  }

  // Process each entity
  for (const [term, entity] of entities) {
    // Skip if already linked or is own page
    if (existingLinks.has(entity.id)) continue;
    if (entity.id === pageEntityId) continue;
    if (linkedEntities.has(entity.id)) continue;

    // Create regex for exact match with word boundaries
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b(${escaped})\\b`, 'gi');

    let match: RegExpExecArray | null;
    while ((match = regex.exec(modifiedContent)) !== null) {
      const position = match.index;

      // Skip if before body or in protected context
      if (position < bodyStart + offset) continue;
      if (isInProtectedContext(modifiedContent, position)) continue;

      // Found a valid match - add EntityLink
      const originalText = match[1]; // Preserve original casing
      const replacement = `<EntityLink id="${entity.id}">${originalText}</EntityLink>`;

      const before = modifiedContent.slice(0, position);
      const after = modifiedContent.slice(position + originalText.length);
      modifiedContent = before + replacement + after;

      changes.push({
        entityId: entity.id,
        originalText,
        line: (before.match(/\n/g) || []).length + 1,
        context: modifiedContent.slice(Math.max(0, position - 20), position + replacement.length + 20).replace(/\n/g, ' '),
      });

      // Only link first mention
      linkedEntities.add(entity.id);
      offset += replacement.length - originalText.length;
      break;
    }
  }

  // Find fuzzy suggestions (if enabled)
  let fuzzySuggestions: FuzzyMatch[] = [];
  if (FUZZY_MODE) {
    const body = modifiedContent.slice(bodyStart);
    const nouns = extractProperNouns(body);
    // Filter out nouns that match existing links or exact matches
    const filteredNouns = nouns.filter(n => {
      const lower = n.text.toLowerCase();
      // Skip if already linked
      if (existingLinks.has(lower)) return false;
      // Skip if we just added a link for this entity
      for (const change of changes) {
        if (change.originalText.toLowerCase() === lower) return false;
      }
      // Skip if it's an exact match for any entity (handled above)
      for (const [term] of entities) {
        if (term === lower) return false;
      }
      return true;
    });

    fuzzySuggestions = findFuzzyMatches(filteredNouns, entities, 0.75);

    // Filter out suggestions for entities we already linked
    fuzzySuggestions = fuzzySuggestions.filter(s => {
      if (linkedEntities.has(s.suggestedEntity.id)) return false;
      if (existingLinks.has(s.suggestedEntity.id)) return false;
      if (s.suggestedEntity.id === pageEntityId) return false;
      return true;
    });
  }

  return { changes, modifiedContent, originalContent: content, fuzzySuggestions };
}

async function main(): Promise<void> {
  if (HELP) {
    showHelp();
    process.exit(0);
  }

  console.log(`${colors.bold}${colors.blue}Cross-Link Auto-Fixer${colors.reset}`);
  console.log(`${colors.dim}Mode: ${APPLY_MODE ? 'APPLY CHANGES' : 'Preview (dry run)'}${colors.reset}\n`);

  const entities = loadEntityLookup();
  console.log(`${colors.dim}Loaded ${entities.size} entity terms${colors.reset}\n`);

  let files: string[];
  if (SINGLE_FILE) {
    const fullPath = SINGLE_FILE.startsWith('/') ? SINGLE_FILE : join(PROJECT_ROOT, SINGLE_FILE);
    if (!existsSync(fullPath)) {
      console.error(`File not found: ${SINGLE_FILE}`);
      process.exit(1);
    }
    files = [fullPath];
  } else {
    files = findMdxFiles(CONTENT_DIR);
  }

  let totalChanges = 0;
  let filesChanged = 0;
  let totalFuzzySuggestions = 0;
  const modifiedFiles: string[] = [];

  for (const file of files) {
    const relPath = relative(CONTENT_DIR, file);
    const pageEntityId = relPath.replace(/\.mdx?$/, '').replace(/\/index$/, '').split('/').pop()!;

    const result = processFile(file, entities, pageEntityId);

    if (result.skipped) continue;

    const hasChanges = result.changes.length > 0;
    const hasFuzzy = result.fuzzySuggestions && result.fuzzySuggestions.length > 0;

    if (!hasChanges && !hasFuzzy) continue;

    if (hasChanges) {
      filesChanged++;
      totalChanges += result.changes.length;
    }

    if (hasFuzzy) {
      totalFuzzySuggestions += result.fuzzySuggestions!.length;
    }

    if (VERBOSE || !APPLY_MODE) {
      if (hasChanges) {
        console.log(`${colors.cyan}${relPath}${colors.reset} (${result.changes.length} exact matches)`);
        for (const change of result.changes) {
          console.log(`  ${colors.green}+${colors.reset} ${change.originalText} → <EntityLink id="${change.entityId}">`);
          if (VERBOSE) {
            console.log(`    ${colors.dim}Line ${change.line}: ...${change.context}...${colors.reset}`);
          }
        }
      }

      if (hasFuzzy && FUZZY_MODE) {
        if (!hasChanges) {
          console.log(`${colors.cyan}${relPath}${colors.reset}`);
        }
        console.log(`  ${colors.yellow}Fuzzy suggestions:${colors.reset}`);
        for (const suggestion of result.fuzzySuggestions!) {
          const pct = Math.round(suggestion.score * 100);
          console.log(`    ${colors.yellow}?${colors.reset} "${suggestion.noun}" → ${suggestion.suggestedEntity.displayName} (${pct}% match)`);
        }
      }
    }

    if (APPLY_MODE && hasChanges) {
      writeFileSync(file, result.modifiedContent!);
      modifiedFiles.push(file);
      console.log(`  ${colors.green}✓${colors.reset} Saved ${relPath}`);
    }
  }

  if (APPLY_MODE && modifiedFiles.length > 0) {
    logBulkFixes(modifiedFiles, {
      tool: 'crux-fix',
      agency: 'automated',
      note: 'Auto-linked EntityLink components',
    });
  }

  console.log();
  console.log(`${colors.bold}Summary:${colors.reset}`);
  console.log(`  Exact matches: ${totalChanges} EntityLinks in ${filesChanged} files`);
  if (FUZZY_MODE) {
    console.log(`  Fuzzy suggestions: ${totalFuzzySuggestions} potential matches (review manually)`);
  }

  if (!APPLY_MODE && totalChanges > 0) {
    console.log();
    console.log(`${colors.yellow}Run with --apply to apply exact matches${colors.reset}`);
  }

  if (!FUZZY_MODE && !APPLY_MODE) {
    console.log(`${colors.dim}Run with --fuzzy to see fuzzy match suggestions${colors.reset}`);
  }

  if (APPLY_MODE && totalChanges > 0) {
    console.log();
    console.log(`${colors.green}✓ Applied ${totalChanges} changes to ${filesChanged} files${colors.reset}`);
    console.log(`${colors.dim}Run 'node crux/crux.mjs validate compile --quick' to verify${colors.reset}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
