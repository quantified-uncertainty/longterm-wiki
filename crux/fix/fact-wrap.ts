#!/usr/bin/env node

/**
 * Fact Wrapping — Pass 1
 *
 * Scans wiki pages for hardcoded numbers that match existing canonical facts
 * from data/facts/*.yaml and wraps them with <F> components.
 *
 * Three-phase algorithm:
 *   Phase A (Deterministic): Load facts, generate normalized number variants,
 *     scan content while avoiding already-wrapped content and code blocks.
 *   Phase C (Application): Replace matched strings with
 *     <F e="entity" f="fact-id">original text</F>
 *
 * Usage:
 *   pnpm crux fix fact-wrap                    # Preview all pages (dry run)
 *   pnpm crux fix fact-wrap <page-id>          # Preview single page
 *   pnpm crux fix fact-wrap --apply            # Apply to all pages
 *   pnpm crux fix fact-wrap <page-id> --apply  # Apply to single page
 *   pnpm crux fix fact-wrap --verbose          # Show detailed match context
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { parse as parseYaml } from 'yaml';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT, CONTENT_DIR_ABS, loadDatabase } from '../lib/content-types.ts';
import { logBulkFixes } from '../lib/edit-log.ts';

const args: string[] = process.argv.slice(2);
const APPLY_MODE = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const HELP = args.includes('--help');
const PAGE_ID = args.find(a => !a.startsWith('--')) || null;

const colors = getColors();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CanonicalFact {
  entity: string;
  factId: string;
  key: string;
  value?: string;
  numeric?: number;
  asOf?: string;
  computed?: boolean;
  noCompute?: boolean;
}

interface SearchPattern {
  regex: RegExp;
  factKey: string;
  entity: string;
  factId: string;
  value: string;
  /** If true, only match on the fact's own entity page */
  lowSpecificity: boolean;
}

interface FactMatch {
  index: number;
  length: number;
  matchedText: string;
  entity: string;
  factId: string;
  factKey: string;
  factValue: string;
  line: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FACTS_DIR = join(PROJECT_ROOT, 'data/facts');

/** Values too short or generic to match reliably */
const MIN_VALUE_LENGTH = 4;
const GENERIC_VALUES = new Set<string>([
  '2020', '2021', '2022', '2023', '2024', '2025', '2026', '2027', '2028', '2029', '2030',
  '25%', '40%', '50%', '75%', '20%', '30%', '10%',
]);

/**
 * Check if a fact value is too common/ambiguous to match across entity boundaries.
 * Low-specificity values are only matched on the fact's own entity page.
 */
function isLowSpecificity(value: string): boolean {
  // Dollar amounts with common multipliers (with optional +)
  // e.g., "$1 billion", "$2.5 billion", "$500 billion+"
  if (/^\$[\d,.]+\s*(billion|million|trillion)\+?$/i.test(value)) return true;

  // Dollar ranges: "$20-26 billion"
  if (/^\$[\d,.]+-[\d,.]+\s*(billion|million|trillion)$/i.test(value)) return true;

  // Short plain numbers that appear in many contexts (including years)
  if (/^\d{1,4}$/.test(value)) return true;

  // Short ranges like "40-60", "20-30" — too common in unrelated contexts
  if (/^\d+-\d+$/.test(value)) return true;

  // Percentage values: "40%", "71.7%", "1,700%"
  if (/^[\d,.]+%$/.test(value)) return true;

  // Percentage ranges like "20-30%" — common in many domains
  if (/^\d+-\d+%$/.test(value)) return true;

  // Plain number with unit like "100 million" (no $) — very common
  if (/^\d+\s*(billion|million|trillion)\+?$/i.test(value)) return true;

  // Comma-separated numbers without context: "300,000"
  if (/^[\d,]+\+?$/.test(value)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Phase A: Load facts and generate patterns
// ---------------------------------------------------------------------------

/**
 * Load all canonical facts from YAML + overlay computed values from database.json.
 */
function loadCanonicalFacts(): CanonicalFact[] {
  const facts: CanonicalFact[] = [];

  if (!existsSync(FACTS_DIR)) return facts;

  const files = readdirSync(FACTS_DIR).filter((f: string) => f.endsWith('.yaml'));
  for (const file of files) {
    const filepath = join(FACTS_DIR, file);
    const content = readFileSync(filepath, 'utf-8');
    const parsed = parseYaml(content) as { entity?: string; facts?: Record<string, Record<string, unknown>> } | null;
    if (parsed && parsed.entity && parsed.facts) {
      for (const [factId, factData] of Object.entries(parsed.facts)) {
        facts.push({
          entity: parsed.entity,
          factId,
          key: `${parsed.entity}.${factId}`,
          ...factData as object,
        } as CanonicalFact);
      }
    }
  }

  // Overlay resolved values from database.json
  try {
    const db = loadDatabase();
    if (db.facts) {
      for (const fact of facts) {
        const dbFact = db.facts[fact.key];
        if (dbFact) {
          // Always prefer the display value from database.json (it's properly formatted)
          if (dbFact.value && (!fact.value || typeof fact.value !== 'string')) {
            fact.value = dbFact.value as string;
          }
          // Also grab value for computed facts
          if (dbFact.computed && dbFact.value) {
            fact.value = dbFact.value as string;
            fact.computed = true;
          }
        }
      }
    }
  } catch {
    // database.json may not exist yet
  }

  return facts;
}

/**
 * Generate search patterns for a fact value.
 * Returns regex patterns matching common variations of the value in MDX prose.
 */
function generateSearchPatterns(fact: CanonicalFact): SearchPattern[] {
  const value = fact.value;
  if (!value || typeof value !== 'string') return [];

  // Skip values too short or generic
  if (value.length < MIN_VALUE_LENGTH && !value.startsWith('$')) return [];
  if (GENERIC_VALUES.has(value)) return [];

  // Skip computed facts — these should use <Calc> not <F>
  if (fact.computed) return [];

  // Skip noCompute facts with year-like values — these are fixed historical dates
  // Per style guide, "Founded in 2021" should be plain text, not an <F> tag
  if (fact.noCompute && /^\d{4}$/.test(value)) return [];

  const patterns: SearchPattern[] = [];
  const isLowSpec = isLowSpecificity(value);
  const makePattern = (regex: RegExp): SearchPattern => ({
    regex,
    factKey: fact.key,
    entity: fact.entity,
    factId: fact.factId,
    value: fact.value!,
    lowSpecificity: isLowSpec,
  });

  // In MDX, dollar signs are escaped as \$. Build patterns matching both.

  // --- Dollar amount with full unit: "$380 billion" ---
  const dollarUnitMatch = value.match(/^\$([\d,.]+)\s*(billion|million|trillion|thousand)/i);
  if (dollarUnitMatch) {
    const num = dollarUnitMatch[1];
    const unit = dollarUnitMatch[2];
    const escapedNum = escapeRegex(num);

    // Full form: $380 billion / \$380 billion
    patterns.push(makePattern(
      new RegExp(`\\\\?\\$${escapedNum}\\s*${unit}`, 'gi')
    ));

    // Abbreviated: $380B / \$380B
    const abbrevMap: Record<string, string> = {
      billion: 'B', million: 'M', trillion: 'T', thousand: 'K',
    };
    const abbr = abbrevMap[unit.toLowerCase()];
    if (abbr) {
      patterns.push(makePattern(
        new RegExp(`\\\\?\\$${escapedNum}\\s*${abbr}\\b`, 'gi')
      ));
    }

    return patterns;
  }

  // --- Dollar range with unit: "$20-26 billion" ---
  const dollarRangeMatch = value.match(/^\$([\d,.]+)-([\d,.]+)\s*(billion|million|trillion)/i);
  if (dollarRangeMatch) {
    const lo = dollarRangeMatch[1];
    const hi = dollarRangeMatch[2];
    const unit = dollarRangeMatch[3];

    // Full form: $20-26 billion
    patterns.push(makePattern(
      new RegExp(`\\\\?\\$${escapeRegex(lo)}\\s*-\\s*${escapeRegex(hi)}\\s*${unit}`, 'gi')
    ));

    // With dollar signs on both: $20-$26 billion
    patterns.push(makePattern(
      new RegExp(`\\\\?\\$${escapeRegex(lo)}\\s*-\\s*\\\\?\\$${escapeRegex(hi)}\\s*${unit}`, 'gi')
    ));

    // "to" form: $20 to $26 billion
    patterns.push(makePattern(
      new RegExp(`\\\\?\\$${escapeRegex(lo)}\\s+to\\s+\\\\?\\$${escapeRegex(hi)}\\s*${unit}`, 'gi')
    ));

    return patterns;
  }

  // --- Dollar amount with plus (min bound): "$67 billion+" ---
  const dollarPlusMatch = value.match(/^\$([\d,.]+)\s*(billion|million|trillion)\+$/i);
  if (dollarPlusMatch) {
    const num = dollarPlusMatch[1];
    const unit = dollarPlusMatch[2];
    const escapedNum = escapeRegex(num);

    // With optional plus: $67 billion or $67 billion+
    patterns.push(makePattern(
      new RegExp(`\\\\?\\$${escapedNum}\\s*${unit}\\+?`, 'gi')
    ));

    // Abbreviated
    const abbrevMap: Record<string, string> = {
      billion: 'B', million: 'M', trillion: 'T',
    };
    const abbr = abbrevMap[unit.toLowerCase()];
    if (abbr) {
      patterns.push(makePattern(
        new RegExp(`\\\\?\\$${escapedNum}\\s*${abbr}\\+?\\b`, 'gi')
      ));
    }

    return patterns;
  }

  // --- Percentage: "40%" ---
  const pctMatch = value.match(/^([\d,.]+)%$/);
  if (pctMatch) {
    const num = pctMatch[1];
    // Only match if preceded/followed by non-digit context to reduce false positives
    patterns.push(makePattern(
      new RegExp(`(?<!\\d)${escapeRegex(num)}%`, 'g')
    ));
    return patterns;
  }

  // --- Percentage range: "20-30%" ---
  const pctRangeMatch = value.match(/^([\d,.]+)-([\d,.]+)%$/);
  if (pctRangeMatch) {
    const lo = pctRangeMatch[1];
    const hi = pctRangeMatch[2];
    patterns.push(makePattern(
      new RegExp(`(?<!\\d)${escapeRegex(lo)}\\s*-\\s*${escapeRegex(hi)}%`, 'g')
    ));
    return patterns;
  }

  // --- Plain number with unit: "100 million", "175 billion" ---
  const numUnitMatch = value.match(/^([\d,.]+)\s*(billion|million|trillion)/i);
  if (numUnitMatch) {
    const num = numUnitMatch[1];
    const unit = numUnitMatch[2];
    patterns.push(makePattern(
      new RegExp(`(?<!\\$|\\\\\\$)\\b${escapeRegex(num)}\\s*${unit}\\b`, 'gi')
    ));
    return patterns;
  }

  // --- Comma-separated number with plus: "300,000+" ---
  const commaNumPlusMatch = value.match(/^([\d,]+)\+$/);
  if (commaNumPlusMatch) {
    const num = commaNumPlusMatch[1];
    patterns.push(makePattern(
      new RegExp(`\\b${escapeRegex(num)}\\+?\\b`, 'g')
    ));
    return patterns;
  }

  // --- String values like "1,700%" ---
  const strPctMatch = value.match(/^([\d,]+)%$/);
  if (strPctMatch) {
    patterns.push(makePattern(
      new RegExp(`(?<!\\d)${escapeRegex(strPctMatch[1])}%`, 'g')
    ));
    return patterns;
  }

  // --- Generic string fallback (exact match with optional backslash-dollar) ---
  let escaped = escapeRegex(value);
  escaped = escaped.replace(/\\\$/g, '\\\\?\\$');
  patterns.push(makePattern(new RegExp(escaped, 'gi')));

  return patterns;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Context detection (skip protected regions)
// ---------------------------------------------------------------------------

/**
 * Check if position is inside an <F> component (already wrapped).
 */
function isInsideFComponent(body: string, matchIndex: number, matchLength: number): boolean {
  const before = body.slice(Math.max(0, matchIndex - 300), matchIndex);
  const after = body.slice(matchIndex, Math.min(body.length, matchIndex + matchLength + 300));

  // Check if inside <F ...>...</F> tags
  const lastOpenF = before.lastIndexOf('<F ');
  if (lastOpenF === -1) return false;

  const afterOpen = before.slice(lastOpenF);
  const closingBracket = afterOpen.indexOf('>');
  if (closingBracket === -1) return true; // Still inside opening tag attributes

  // Self-closing <F ... />
  if (afterOpen[closingBracket - 1] === '/') return false;

  // Look for </F> after our match
  return after.includes('</F>');
}

/**
 * Check if position is inside a Calc component expression.
 */
function isInsideCalcComponent(body: string, matchIndex: number): boolean {
  const before = body.slice(Math.max(0, matchIndex - 500), matchIndex);
  const after = body.slice(matchIndex, Math.min(body.length, matchIndex + 500));

  const lastCalc = before.lastIndexOf('<Calc ');
  if (lastCalc === -1) return false;

  const afterCalc = before.slice(lastCalc);
  const closingTag = afterCalc.indexOf('/>');
  // If self-closing hasn't happened yet, we're inside
  if (closingTag === -1) return true;

  return false;
}

/**
 * Check if position is inside a protected context where we shouldn't wrap.
 */
function isInProtectedContext(body: string, matchIndex: number): boolean {
  const before = body.slice(0, matchIndex);

  // In YAML frontmatter
  if (before.startsWith('---')) {
    const secondDash = before.indexOf('---', 3);
    if (secondDash === -1 || matchIndex < secondDash + 3) return true;
  }

  // In code fence
  const fences = before.split('```');
  if (fences.length % 2 === 0) return true;

  // In inline code
  const line = before.split('\n').pop() || '';
  const backticks = (line.match(/`/g) || []).length;
  if (backticks % 2 === 1) return true;

  // In JSX tag attributes (between < and >)
  const lastTagOpen = before.lastIndexOf('<');
  const lastTagClose = before.lastIndexOf('>');
  if (lastTagOpen > lastTagClose) {
    // We're between < and >, check if it's a component tag
    const tagSnippet = before.slice(lastTagOpen);
    if (/^<[A-Z]/.test(tagSnippet)) return true;
  }

  // In import statement
  const lineStart = before.lastIndexOf('\n') + 1;
  const fullLine = body.slice(lineStart, body.indexOf('\n', matchIndex));
  if (fullLine.trim().startsWith('import ')) return true;

  // In SquiggleEstimate code block (inside code={` ... `})
  const lastCodeStart = before.lastIndexOf('code={`');
  if (lastCodeStart !== -1) {
    const afterCodeStart = before.slice(lastCodeStart);
    if (!afterCodeStart.includes('`}')) return true;
  }

  // In JSX curly braces (expressions)
  let braceDepth = 0;
  // Only check after frontmatter
  const fmEnd = before.indexOf('---', 3);
  const checkStart = fmEnd > 0 ? fmEnd + 3 : 0;
  for (let i = checkStart; i < before.length; i++) {
    if (body[i] === '{') braceDepth++;
    else if (body[i] === '}') braceDepth--;
  }
  if (braceDepth > 0) return true;

  // In markdown link URL: [text](url)
  if (/\]\([^)]*$/.test(before)) return true;

  // In markdown link text: [text]
  const lastBracketOpen = before.lastIndexOf('[');
  const lastBracketClose = before.lastIndexOf(']');
  if (lastBracketOpen > lastBracketClose) return true;

  // In URL
  if (/https?:\/\/[^\s]*$/.test(before)) return true;

  // In footnote definition line: [^name]: ...
  const currentLineStart = before.lastIndexOf('\n') + 1;
  const currentLine = body.slice(currentLineStart, body.indexOf('\n', matchIndex));
  if (/^\[\^[^\]]+\]:/.test(currentLine)) return true;

  // In llmSummary frontmatter field
  const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch && matchIndex < fmMatch[0].length) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Phase C: Find and apply matches
// ---------------------------------------------------------------------------

interface ProcessResult {
  matches: FactMatch[];
  modifiedContent?: string;
  originalContent: string;
  pageId: string;
}

function processFile(filePath: string, patterns: SearchPattern[]): ProcessResult {
  const content = readFileSync(filePath, 'utf-8');
  const relPath = relative(CONTENT_DIR_ABS, filePath);
  const pageId = relPath.replace(/\.mdx?$/, '').split('/').pop()!;

  // Find facts already wrapped with <F> on this page (for idempotency)
  const alreadyWrappedFacts = new Set<string>();
  const fTagRegex = /<F\s+e="([^"]+)"\s+f="([^"]+)"/g;
  let fMatch: RegExpExecArray | null;
  while ((fMatch = fTagRegex.exec(content)) !== null) {
    alreadyWrappedFacts.add(`${fMatch[1]}.${fMatch[2]}`);
  }

  const allMatches: FactMatch[] = [];

  for (const pattern of patterns) {
    // Skip low-specificity patterns on pages that don't belong to this entity
    if (pattern.lowSpecificity && pageId !== pattern.entity) continue;

    // Skip facts already wrapped on this page (idempotency)
    if (alreadyWrappedFacts.has(pattern.factKey)) continue;

    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const idx = match.index;
      const matchedText = match[0];

      // Skip if in any protected context
      if (isInsideFComponent(content, idx, matchedText.length)) continue;
      if (isInsideCalcComponent(content, idx)) continue;
      if (isInProtectedContext(content, idx)) continue;

      // Find line number
      const beforeMatch = content.slice(0, idx);
      const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;

      allMatches.push({
        index: idx,
        length: matchedText.length,
        matchedText,
        entity: pattern.entity,
        factId: pattern.factId,
        factKey: pattern.factKey,
        factValue: pattern.value,
        line: lineNum,
      });
    }
  }

  // Deduplicate: for the same position, keep longest match
  // Then for overlapping matches, keep the first one
  const deduped = deduplicateMatches(allMatches);

  return {
    matches: deduped,
    originalContent: content,
    pageId,
  };
}

/**
 * Remove duplicate and overlapping matches.
 * For same position: prefer longer match.
 * For overlapping: prefer earlier match.
 * For same text matching multiple facts: prefer exact value match.
 */
function deduplicateMatches(matches: FactMatch[]): FactMatch[] {
  if (matches.length === 0) return [];

  // Sort by position, then by match length descending
  const sorted = [...matches].sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;
    return b.length - a.length;
  });

  // Remove duplicates at same position (keep longest / best match)
  const byPosition = new Map<number, FactMatch>();
  for (const m of sorted) {
    const existing = byPosition.get(m.index);
    if (!existing || m.length > existing.length) {
      byPosition.set(m.index, m);
    }
  }

  // Remove overlapping matches (keep earlier one)
  const result: FactMatch[] = [];
  let lastEnd = -1;
  for (const m of [...byPosition.values()].sort((a, b) => a.index - b.index)) {
    if (m.index >= lastEnd) {
      result.push(m);
      lastEnd = m.index + m.length;
    }
  }

  // Deduplicate by fact key — only wrap each fact once per page (first occurrence).
  // Later occurrences of the same value may refer to different things
  // (e.g., "$4 billion" first as revenue, then as an investment amount).
  const seenFacts = new Set<string>();
  return result.filter(m => {
    if (seenFacts.has(m.factKey)) return false;
    seenFacts.add(m.factKey);
    return true;
  });
}

/**
 * Apply matches by replacing matched text with <F> tags.
 * Processes from end to start to preserve indices.
 */
function applyMatches(content: string, matches: FactMatch[]): string {
  // Sort by position descending so replacements don't shift indices
  const sorted = [...matches].sort((a, b) => b.index - a.index);

  let result = content;
  for (const match of sorted) {
    const replacement = `<F e="${match.entity}" f="${match.factId}">${match.matchedText}</F>`;
    result = result.slice(0, match.index) + replacement + result.slice(match.index + match.length);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
${colors.bold}Fact Wrapping — Pass 1${colors.reset}

Scans wiki pages for hardcoded numbers that match canonical facts
from data/facts/*.yaml and wraps them with <F> components.

${colors.bold}Usage:${colors.reset}
  crux fix fact-wrap                    Preview all pages (dry run)
  crux fix fact-wrap <page-id>          Preview single page
  crux fix fact-wrap --apply            Apply to all pages
  crux fix fact-wrap <page-id> --apply  Apply to single page
  crux fix fact-wrap --verbose          Show detailed match context

${colors.bold}Options:${colors.reset}
  --apply     Apply changes to files (default: dry run)
  --verbose   Show line context for each match
  --help      Show this help

${colors.bold}What it does:${colors.reset}
  1. Loads all facts from data/facts/*.yaml + database.json
  2. Generates search patterns for each fact value
  3. Scans MDX pages for matches, skipping:
     - Already-wrapped <F> components
     - Code blocks and inline code
     - JSX attributes and expressions
     - SquiggleEstimate code blocks
     - Frontmatter, imports, URLs
  4. Wraps first occurrence of each fact with <F e="entity" f="factId">

${colors.bold}Safety:${colors.reset}
  - Only wraps first occurrence of each fact per page
  - Preserves original text as children of <F> tag
  - Skips computed facts (use <Calc> instead)
  - Idempotent: running twice produces same result
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (HELP) {
    showHelp();
    process.exit(0);
  }

  console.log(`${colors.bold}${colors.blue}Fact Wrapping — Pass 1${colors.reset}`);
  console.log(`${colors.dim}Mode: ${APPLY_MODE ? 'APPLY CHANGES' : 'Preview (dry run)'}${colors.reset}\n`);

  // Load facts and generate patterns
  const facts = loadCanonicalFacts();
  console.log(`${colors.dim}Loaded ${facts.length} canonical facts${colors.reset}`);

  const allPatterns: SearchPattern[] = [];
  for (const fact of facts) {
    allPatterns.push(...generateSearchPatterns(fact));
  }
  console.log(`${colors.dim}Generated ${allPatterns.length} search patterns${colors.reset}\n`);

  if (allPatterns.length === 0) {
    console.log('No searchable patterns generated. Check that data/facts/*.yaml has values.');
    process.exit(0);
  }

  // Find files to process
  let files: string[];
  if (PAGE_ID) {
    // Find the MDX file for this page ID
    const allFiles = findMdxFiles(CONTENT_DIR_ABS);
    const matching = allFiles.filter(f => {
      const base = f.replace(/\.mdx?$/, '').split('/').pop();
      return base === PAGE_ID;
    });

    if (matching.length === 0) {
      console.error(`${colors.red}Page not found: ${PAGE_ID}${colors.reset}`);
      console.log(`${colors.dim}Searched in ${CONTENT_DIR_ABS}${colors.reset}`);
      process.exit(1);
    }
    files = matching;
  } else {
    files = findMdxFiles(CONTENT_DIR_ABS);
  }

  let totalMatches = 0;
  let filesWithMatches = 0;
  const modifiedFiles: string[] = [];

  for (const file of files) {
    const relPath = relative(CONTENT_DIR_ABS, file);

    // Skip internal/documentation pages
    if (relPath.startsWith('internal/')) continue;

    const result = processFile(file, allPatterns);

    if (result.matches.length === 0) continue;

    filesWithMatches++;
    totalMatches += result.matches.length;

    // Display matches
    console.log(`${colors.cyan}${relPath}${colors.reset} (${result.matches.length} matches)`);
    for (const match of result.matches) {
      console.log(`  ${colors.green}+${colors.reset} L${match.line}: "${match.matchedText}" → <F e="${match.entity}" f="${match.factId}">`);
      if (VERBOSE) {
        const lines = result.originalContent.split('\n');
        const lineContent = lines[match.line - 1] || '';
        console.log(`    ${colors.dim}${lineContent.trim().slice(0, 120)}${colors.reset}`);
      }
    }

    // Apply if requested
    if (APPLY_MODE) {
      const modified = applyMatches(result.originalContent, result.matches);
      writeFileSync(file, modified);
      modifiedFiles.push(file);
      console.log(`  ${colors.green}✓${colors.reset} Saved`);
    }
  }

  // Log to edit log if changes were applied
  if (APPLY_MODE && modifiedFiles.length > 0) {
    logBulkFixes(modifiedFiles, {
      tool: 'crux-fix',
      agency: 'automated',
      note: 'Auto-wrapped hardcoded numbers with <F> fact components',
    });
  }

  // Summary
  console.log();
  console.log(`${colors.bold}Summary:${colors.reset}`);
  console.log(`  ${totalMatches} fact matches across ${filesWithMatches} files`);
  console.log(`  ${facts.length} canonical facts, ${allPatterns.length} search patterns`);

  if (!APPLY_MODE && totalMatches > 0) {
    console.log();
    console.log(`${colors.yellow}Run with --apply to apply changes${colors.reset}`);
  }

  if (APPLY_MODE && totalMatches > 0) {
    console.log();
    console.log(`${colors.green}✓ Applied ${totalMatches} wrappings to ${modifiedFiles.length} files${colors.reset}`);
    console.log(`${colors.dim}Run 'pnpm crux validate unified --rules=dollar-signs,comparison-operators --errors-only' to verify${colors.reset}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
