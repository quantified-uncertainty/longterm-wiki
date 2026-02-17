#!/usr/bin/env node

/**
 * Fact Value Auto-Fixer
 *
 * Mechanically replaces hardcoded values in MDX prose with <F> components,
 * ensuring wiki-wide fact consistency without any LLM calls.
 *
 * For each canonical fact in data/facts/*.yaml, finds matching hardcoded values
 * in MDX body text and wraps them with <F e="entity" f="factId">value</F>.
 *
 * Usage:
 *   pnpm crux fix facts                    # Preview changes (dry run)
 *   pnpm crux fix facts --apply            # Apply changes
 *   pnpm crux fix facts --verbose          # Show detailed matches
 *   pnpm crux fix facts --file=path        # Fix single file
 *   pnpm crux fix facts --entity=anthropic # Only facts for one entity
 *   pnpm crux fix facts --limit=10         # Limit files processed
 *
 * Safety:
 *   - Only wraps values in prose (not code blocks, tables, frontmatter, JSX attrs)
 *   - Only wraps first occurrence per fact per page (avoids clutter)
 *   - Skips values already inside <F> or <Calc> components
 *   - Adds F import automatically if needed
 *   - Preserves original text (just wraps it)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT, CONTENT_DIR_ABS as CONTENT_DIR } from '../lib/content-types.ts';
import { logBulkFixes } from '../lib/edit-log.ts';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args: string[] = process.argv.slice(2);
const APPLY_MODE: boolean = args.includes('--apply');
const VERBOSE: boolean = args.includes('--verbose');
const HELP: boolean = args.includes('--help');
const SINGLE_FILE: string | undefined = args.find(a => a.startsWith('--file='))?.split('=')[1];
const ENTITY_FILTER: string | undefined = args.find(a => a.startsWith('--entity='))?.split('=')[1];
const LIMIT: number = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);

const colors = getColors();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CanonicalFact {
  entity: string;
  factId: string;
  key: string;
  value: string;
  asOf?: string;
  noCompute?: boolean;
  [k: string]: unknown;
}

interface SearchVariant {
  regex: RegExp;
  /** The canonical text to display as the wrapped content (may differ from match) */
  canonicalDisplay?: string;
}

interface FactMatch {
  fact: CanonicalFact;
  matchText: string;
  position: number;
  line: number;
}

interface FileChange {
  fact: CanonicalFact;
  matchText: string;
  line: number;
  context: string;
}

interface ProcessResult {
  changes: FileChange[];
  modifiedContent?: string;
  originalContent: string;
  skipped?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FACTS_DIR: string = join(PROJECT_ROOT, 'data/facts');
const MIN_VALUE_LENGTH = 5;

// Values too generic to replace reliably
const GENERIC_VALUES = new Set<string>([
  '2025', '2026', '2027', '2028', '2029', '2030',
  '25%', '40%', '50%', '75%', '20%', '30%', '10%',
  '20-30%',  // Common range
  '40-60',   // Common range
  '200-330',  // Ranges need entity-specific context
  '88%', '76%',  // Retention rates too generic
  '100 million',  // Too common across many contexts
  '300,000+',     // Business customer count is generic
]);

// ---------------------------------------------------------------------------
// Fact loading
// ---------------------------------------------------------------------------

function loadCanonicalFacts(): CanonicalFact[] {
  const facts: CanonicalFact[] = [];
  if (!existsSync(FACTS_DIR)) return facts;

  const files = readdirSync(FACTS_DIR).filter((f: string) => f.endsWith('.yaml'));
  for (const file of files) {
    const filepath = join(FACTS_DIR, file);
    const content = readFileSync(filepath, 'utf-8');
    const parsed = parseYaml(content) as { entity?: string; facts?: Record<string, Record<string, unknown>> } | null;
    if (!parsed?.entity || !parsed?.facts) continue;

    if (ENTITY_FILTER && parsed.entity !== ENTITY_FILTER) continue;

    for (const [factId, factData] of Object.entries(parsed.facts)) {
      const value = factData.value as string | undefined;
      if (!value) continue;
      if (value.length < MIN_VALUE_LENGTH && !value.startsWith('$')) continue;
      if (GENERIC_VALUES.has(value)) continue;

      facts.push({
        entity: parsed.entity,
        factId,
        key: `${parsed.entity}.${factId}`,
        value,
        ...factData,
      });
    }
  }

  // Sort by value length descending — match longer values first to avoid
  // partial matches (e.g. "$14 billion" before "$1 billion")
  facts.sort((a, b) => b.value.length - a.value.length);

  return facts;
}

// ---------------------------------------------------------------------------
// Pattern generation (mirrors fact-consistency rule)
// ---------------------------------------------------------------------------

function generateSearchVariants(value: string): SearchVariant[] {
  const variants: SearchVariant[] = [];

  // 1. Direct exact match — handle both $ and \$ in MDX
  let escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match both \$ and $ for dollar amounts
  escaped = escaped.replace(/\\\$/g, '\\\\?\\$');
  variants.push({ regex: new RegExp(escaped, 'g') });

  // 2. Dollar abbreviation: "$13 billion" → "$13B"
  const dollarMatch = value.match(/^\$?([\d,.]+)\s*(billion|million|trillion|thousand)/i);
  if (dollarMatch) {
    const num = dollarMatch[1];
    const unit = dollarMatch[2].toLowerCase();
    const abbrevMap: Record<string, string> = {
      billion: 'B', million: 'M', trillion: 'T', thousand: 'K',
    };
    const abbr = abbrevMap[unit];
    if (abbr) {
      const escapedNum = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match $13B, \$13B, $13 B
      variants.push({
        regex: new RegExp(`\\\\?\\$${escapedNum}\\s*${abbr}\\b`, 'g'),
      });
    }
  }

  // 3. Number + unit without dollar sign: "100 million" → "100M"
  const numUnitMatch = value.match(/^([\d,.]+)\s*(billion|million|trillion|thousand)/i);
  if (numUnitMatch && !dollarMatch) {
    const num = numUnitMatch[1];
    const unit = numUnitMatch[2].toLowerCase();
    const abbrevMap: Record<string, string> = { billion: 'B', million: 'M', trillion: 'T', thousand: 'K' };
    const abbr = abbrevMap[unit];
    if (abbr) {
      variants.push({
        regex: new RegExp(`\\b${num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*${abbr}\\b`, 'g'),
      });
    }
  }

  return variants;
}

// ---------------------------------------------------------------------------
// Context checking — skip protected regions
// ---------------------------------------------------------------------------

function isInsideFOrCalc(body: string, matchIndex: number): boolean {
  const before = body.slice(Math.max(0, matchIndex - 300), matchIndex);
  const after = body.slice(matchIndex, Math.min(body.length, matchIndex + 300));

  // Check <F ...>...</F>
  const lastOpenF = before.lastIndexOf('<F ');
  if (lastOpenF !== -1) {
    const afterOpen = before.slice(lastOpenF);
    const closingBracket = afterOpen.indexOf('>');
    if (closingBracket === -1) return true; // Inside opening tag
    if (afterOpen[closingBracket - 1] === '/') {
      // Self-closing — only inside if match is within the tag itself
      // Since we're past >, we're not inside
    } else if (after.includes('</F>')) {
      return true; // Between <F ...> and </F>
    }
  }

  // Check <Calc ...>...</Calc> and <Calc ... />
  const lastOpenCalc = before.lastIndexOf('<Calc ');
  if (lastOpenCalc !== -1) {
    const afterOpen = before.slice(lastOpenCalc);
    const closingBracket = afterOpen.indexOf('>');
    if (closingBracket === -1) return true;
    if (afterOpen[closingBracket - 1] !== '/' && after.includes('</Calc>')) {
      return true;
    }
  }

  return false;
}

function isInProtectedContext(content: string, position: number): boolean {
  const before = content.slice(0, position);

  // Code fences
  const fences = before.split('```');
  if (fences.length % 2 === 0) return true;

  // Inline code
  const line = before.split('\n').pop() || '';
  const backticks = (line.match(/`/g) || []).length;
  if (backticks % 2 === 1) return true;

  // YAML frontmatter
  if (before.startsWith('---')) {
    const secondDash = before.indexOf('---', 3);
    if (secondDash === -1 || position < secondDash + 3) return true;
  }

  // Import statements
  const lineStart = before.lastIndexOf('\n') + 1;
  const currentLine = content.slice(lineStart, content.indexOf('\n', position));
  if (currentLine.trim().startsWith('import ')) return true;

  // JSX tag attributes (between < and >)
  const lastTagOpen = before.lastIndexOf('<');
  const lastTagClose = before.lastIndexOf('>');
  if (lastTagOpen > lastTagClose) return true;

  // Markdown table rows (lines starting with |)
  if (currentLine.trim().startsWith('|')) return true;

  // Footnote definitions (lines starting with [^N]:)
  if (/^\[?\[\^/.test(currentLine.trim())) return true;

  // Markdown headings (# ## ### etc.)
  if (/^#{1,6}\s/.test(currentLine.trim())) return true;

  // JSX expression braces (inside {})
  // Simple heuristic: check if we're inside a JSX attribute value
  const lastOpenBrace = before.lastIndexOf('{');
  const lastCloseBrace = before.lastIndexOf('}');
  if (lastOpenBrace > lastCloseBrace) {
    // Could be inside JSX expression — check if it looks like an attribute
    const beforeBrace = before.slice(Math.max(0, lastOpenBrace - 20), lastOpenBrace);
    if (/=\s*$/.test(beforeBrace)) return true; // attr={...}
  }

  return false;
}

// ---------------------------------------------------------------------------
// Entity proximity — only replace if the entity is mentioned nearby
// ---------------------------------------------------------------------------

/** Common display names for entities (for proximity matching) */
const ENTITY_DISPLAY_NAMES: Record<string, string[]> = {
  anthropic: ['Anthropic'],
  openai: ['OpenAI', 'Open AI'],
  'sam-altman': ['Sam Altman', 'Altman'],
  'jaan-tallinn': ['Jaan Tallinn', 'Tallinn'],
};

/**
 * Get the paragraph surrounding a position (text between blank lines).
 */
function getParagraph(content: string, position: number): string {
  // Find previous blank line (or start of content)
  let start = position;
  while (start > 0) {
    const prevNewline = content.lastIndexOf('\n', start - 1);
    if (prevNewline === -1) { start = 0; break; }
    // Check if this line and the previous line are both newlines (blank line)
    if (content[prevNewline - 1] === '\n' || prevNewline === 0) {
      start = prevNewline + 1;
      break;
    }
    start = prevNewline;
  }

  // Find next blank line (or end of content)
  let end = position;
  while (end < content.length) {
    const nextNewline = content.indexOf('\n', end);
    if (nextNewline === -1) { end = content.length; break; }
    if (content[nextNewline + 1] === '\n' || nextNewline + 1 >= content.length) {
      end = nextNewline;
      break;
    }
    end = nextNewline + 1;
  }

  return content.slice(start, end);
}

/**
 * Check if the entity is contextually relevant at this position.
 *
 * Two-tier matching:
 *   - **Entity's own pages**: Page path contains the entity ID → always match
 *   - **Other pages**: Entity name must appear in the SAME PARAGRAPH as the value
 *
 * This avoids false positives like "$1 billion" on a bioweapons page
 * matching Anthropic's revenue just because "Anthropic" is mentioned
 * 500 chars away in a different context.
 */
function isEntityRelevant(
  content: string,
  position: number,
  entity: string,
  relPath: string,
): boolean {
  // 1. Page path contains entity ID (e.g., "anthropic-investors" for "anthropic")
  const pageSlug = relPath.replace(/\.mdx?$/, '').split('/').pop() || '';
  if (pageSlug === entity || pageSlug.startsWith(entity + '-')) return true;

  // 2. Frontmatter entityId matches
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch && fmMatch[1].includes(`entityId: ${entity}`)) return true;

  // 3. Entity name appears in the SAME PARAGRAPH as the match
  const paragraph = getParagraph(content, position);
  const names = ENTITY_DISPLAY_NAMES[entity] || [];
  // Always include the capitalized entity ID as a fallback
  const capitalizedId = entity.charAt(0).toUpperCase() + entity.slice(1);
  const allNames = [...names, capitalizedId];

  for (const name of allNames) {
    if (paragraph.includes(name)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Import management
// ---------------------------------------------------------------------------

const WIKI_IMPORT_PATTERN: RegExp = /import\s*\{([^}]+)\}\s*from\s*['"]@components\/wiki['"]/;

function ensureFImport(content: string): string {
  const importMatch = content.match(WIKI_IMPORT_PATTERN);
  if (importMatch) {
    const imports = importMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    if (imports.includes('F')) return content;
    // Add F to existing import
    const newImports = [...imports, 'F'].join(', ');
    return content.replace(WIKI_IMPORT_PATTERN, (match) => {
      const quoteChar = match.includes("'") ? "'" : '"';
      return `import {${newImports}} from ${quoteChar}@components/wiki${quoteChar}`;
    });
  }

  // No wiki import exists — add after frontmatter
  const lines = content.split('\n');
  let fmCount = 0;
  let insertIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '---') {
      fmCount++;
      if (fmCount === 2) {
        insertIdx = i + 1;
        break;
      }
    }
  }
  lines.splice(insertIdx, 0, "import {F} from '@components/wiki';");
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

function processFile(filePath: string, facts: CanonicalFact[]): ProcessResult {
  const content = readFileSync(filePath, 'utf-8');

  // Skip internal pages
  const relPath = relative(CONTENT_DIR, filePath);
  if (relPath.startsWith('internal/') || relPath.startsWith('internal\\')) {
    return { changes: [], originalContent: content, skipped: 'internal' };
  }

  // Find body start (after frontmatter + imports)
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
  const bodyStart = fmMatch ? fmMatch[0].length : 0;

  const changes: FileChange[] = [];
  let modifiedContent = content;
  let offset = 0;

  // Track which facts have been wrapped in this file (first occurrence only)
  const wrappedFacts = new Set<string>();

  for (const fact of facts) {
    if (wrappedFacts.has(fact.key)) continue;

    const variants = generateSearchVariants(fact.value);

    for (const variant of variants) {
      variant.regex.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = variant.regex.exec(modifiedContent)) !== null) {
        const pos = match.index;

        // Skip if before body
        if (pos < bodyStart + offset) continue;

        // Skip if in protected context
        if (isInProtectedContext(modifiedContent, pos)) continue;
        if (isInsideFOrCalc(modifiedContent, pos)) continue;

        // Skip if entity is not contextually relevant near this match
        if (!isEntityRelevant(modifiedContent, pos, fact.entity, relPath)) continue;

        // Build replacement: <F e="entity" f="factId">matched text</F>
        const matchedText = match[0];
        const replacement = `<F e="${fact.entity}" f="${fact.factId}">${matchedText}</F>`;

        const beforeMatch = modifiedContent.slice(0, pos);
        const afterMatch = modifiedContent.slice(pos + matchedText.length);
        modifiedContent = beforeMatch + replacement + afterMatch;

        const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;
        const lineStart = beforeMatch.lastIndexOf('\n') + 1;
        const lineEnd = modifiedContent.indexOf('\n', pos);
        const lineText = modifiedContent.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();

        changes.push({
          fact,
          matchText: matchedText,
          line: lineNum,
          context: lineText.length > 100 ? lineText.slice(0, 100) + '...' : lineText,
        });

        offset += replacement.length - matchedText.length;
        wrappedFacts.add(fact.key);
        break; // Only first occurrence per fact
      }

      if (wrappedFacts.has(fact.key)) break; // Found via this variant, skip remaining variants
    }
  }

  if (changes.length > 0) {
    modifiedContent = ensureFImport(modifiedContent);
  }

  return { changes, modifiedContent, originalContent: content };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
${colors.bold}Fact Value Auto-Fixer${colors.reset}

Replaces hardcoded canonical fact values with <F> components.
No LLM calls — pure mechanical find-and-replace.

${colors.bold}Usage:${colors.reset}
  crux fix facts                    Preview changes (dry run)
  crux fix facts --apply            Apply changes to files
  crux fix facts --verbose          Show detailed match context
  crux fix facts --file=path        Fix single file only
  crux fix facts --entity=anthropic Only facts for one entity
  crux fix facts --limit=10         Limit number of files processed

${colors.bold}What it does:${colors.reset}
  - Loads all canonical facts from data/facts/*.yaml
  - For each MDX file, finds hardcoded values matching facts
  - Wraps them: "\\$380 billion" → <F e="anthropic" f="valuation">\\$380 billion</F>
  - Adds F import if missing
  - Only wraps first occurrence per fact per page

${colors.bold}Safety:${colors.reset}
  - Skips code blocks, inline code, tables, frontmatter, JSX attributes
  - Skips values already inside <F> or <Calc> components
  - Preserves original text exactly (just wraps it)
  - Longer values matched first to avoid partial replacements
  - Dry run by default — use --apply to write changes
`);
}

async function main(): Promise<void> {
  if (HELP) {
    showHelp();
    process.exit(0);
  }

  console.log(`${colors.bold}${colors.blue}Fact Value Auto-Fixer${colors.reset}`);
  console.log(`${colors.dim}Mode: ${APPLY_MODE ? 'APPLY CHANGES' : 'Preview (dry run)'}${colors.reset}`);
  if (ENTITY_FILTER) {
    console.log(`${colors.dim}Entity filter: ${ENTITY_FILTER}${colors.reset}`);
  }
  console.log();

  const facts = loadCanonicalFacts();
  console.log(`${colors.dim}Loaded ${facts.length} canonical facts${colors.reset}`);

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
    if (LIMIT > 0) {
      // Process files with most potential matches first — sort by size descending
      files.sort((a, b) => {
        try {
          return readFileSync(b, 'utf-8').length - readFileSync(a, 'utf-8').length;
        } catch {
          return 0;
        }
      });
      files = files.slice(0, LIMIT);
    }
  }

  console.log(`${colors.dim}Scanning ${files.length} files...${colors.reset}\n`);

  let totalChanges = 0;
  let filesChanged = 0;
  const modifiedFiles: string[] = [];
  const fileResults: Array<{ relPath: string; changes: FileChange[] }> = [];

  for (const file of files) {
    const result = processFile(file, facts);
    if (result.skipped) continue;
    if (result.changes.length === 0) continue;

    filesChanged++;
    totalChanges += result.changes.length;

    const relPath = relative(CONTENT_DIR, file);
    fileResults.push({ relPath, changes: result.changes });

    console.log(`${colors.cyan}${relPath}${colors.reset} (${result.changes.length} replacements)`);
    for (const change of result.changes) {
      console.log(`  ${colors.green}+${colors.reset} ${change.matchText} → <F e="${change.fact.entity}" f="${change.fact.factId}">`);
      if (VERBOSE) {
        console.log(`    ${colors.dim}Line ${change.line}: ${change.context}${colors.reset}`);
      }
    }

    if (APPLY_MODE) {
      writeFileSync(file, result.modifiedContent!);
      modifiedFiles.push(file);
      console.log(`  ${colors.green}✓${colors.reset} Saved`);
    }
  }

  if (APPLY_MODE && modifiedFiles.length > 0) {
    logBulkFixes(modifiedFiles, {
      tool: 'crux-fix',
      agency: 'automated',
      note: `Wrapped hardcoded fact values with <F> components (${totalChanges} replacements)`,
    });
  }

  console.log();
  console.log(`${colors.bold}Summary:${colors.reset}`);
  console.log(`  ${totalChanges} hardcoded values in ${filesChanged} files`);

  if (!APPLY_MODE && totalChanges > 0) {
    console.log();
    console.log(`${colors.yellow}Run with --apply to apply these changes${colors.reset}`);
    console.log(`${colors.dim}Then run: pnpm crux fix escaping && pnpm crux fix imports${colors.reset}`);
  }

  if (APPLY_MODE && totalChanges > 0) {
    console.log();
    console.log(`${colors.green}✓ Applied ${totalChanges} changes to ${filesChanged} files${colors.reset}`);
    console.log(`${colors.dim}Run 'pnpm crux fix escaping' to fix any escaping issues${colors.reset}`);
    console.log(`${colors.dim}Run 'pnpm crux validate gate' to verify${colors.reset}`);
  }

  // Exit with error in dry-run mode if there are unfixed issues (useful for CI)
  if (!APPLY_MODE && totalChanges > 0) {
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
