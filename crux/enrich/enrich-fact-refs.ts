/**
 * Fact Reference Enrichment Tool
 *
 * Standalone tool to wrap hardcoded numbers in MDX content with
 * `<F e="entity" f="hashId">display</F>` canonical fact tags.
 *
 * Features:
 * - Idempotent: skips numbers already inside <F> tags
 * - Works at section-level and page-level
 * - Uses LLM (Haiku) to verify semantic match before wrapping
 * - Handles approximate matching ($30B vs $30 billion vs 30000000000)
 *
 * Usage (CLI):
 *   pnpm crux enrich fact-refs <page-id>           # Preview (dry run)
 *   pnpm crux enrich fact-refs <page-id> --apply   # Write to file
 *   pnpm crux enrich fact-refs --all [--limit=N]   # Batch across wiki
 *
 * Usage (library):
 *   import { enrichFactRefs } from './enrich-fact-refs.ts';
 *   const result = await enrichFactRefs(content, { pageId, root: ROOT });
 */

import { readFileSync, writeFileSync } from 'fs';
import { CONTENT_DIR_ABS, PROJECT_ROOT } from '../lib/content-types.ts';
import { findMdxFiles, findPageFile } from '../lib/file-utils.ts';
import { buildFactLookupForContent } from '../lib/fact-lookup.ts';
import { createClient, MODELS, callClaude, parseJsonResponse } from '../lib/anthropic.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FactRefReplacement {
  /** The exact text to replace (as it appears in the content) */
  searchText: string;
  /** The entity ID, e.g. "anthropic" */
  entityId: string;
  /** The fact hash ID, e.g. "5b0663a0" */
  factId: string;
  /** The display text to show inside the F tag (usually same as searchText) */
  displayText: string;
}

export interface FactRefEnrichResult {
  /** The enriched content */
  content: string;
  /** Number of <F> tags inserted */
  insertedCount: number;
  /** The proposed replacements */
  replacements: FactRefReplacement[];
}

interface LlmFactRefResponse {
  replacements?: Array<{
    searchText?: string;
    entityId?: string;
    factId?: string;
    displayText?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Core logic (exportable library functions)
// ---------------------------------------------------------------------------

/**
 * Build skip ranges for positions inside <F>...</F> tags, code blocks, etc.
 */
function buildSkipRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // Skip content inside <F>...</F> tags (already wrapped)
  const fTagFull = /<F\s[^>]*>[\s\S]*?<\/F>/g;
  for (const match of content.matchAll(fTagFull)) {
    if (match.index !== undefined) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  // Skip self-closing <F /> tags
  const fTagSelf = /<F\s[^>]*\/>/g;
  for (const match of content.matchAll(fTagSelf)) {
    if (match.index !== undefined) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  // Skip <Calc> components
  const calcTag = /<Calc\s[^>]*\/>/g;
  for (const match of content.matchAll(calcTag)) {
    if (match.index !== undefined) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  // Skip code blocks
  const codeBlock = /```[\s\S]*?```/g;
  for (const match of content.matchAll(codeBlock)) {
    if (match.index !== undefined) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  const inlineCode = /`[^`]+`/g;
  for (const match of content.matchAll(inlineCode)) {
    if (match.index !== undefined) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  // Skip frontmatter
  const frontmatterMatch = content.match(/^---[\s\S]*?---\n/);
  if (frontmatterMatch) {
    ranges.push([0, frontmatterMatch[0].length]);
  }

  // Skip import statements
  const importLines = /^import\s[^\n]+\n/gm;
  for (const match of content.matchAll(importLines)) {
    if (match.index !== undefined) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  // Skip JSX attribute values
  const jsxAttr = /=["'][^"']*["']/g;
  for (const match of content.matchAll(jsxAttr)) {
    if (match.index !== undefined) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  return ranges.sort((a, b) => a[0] - b[0]);
}

function isInSkipRange(pos: number, end: number, ranges: Array<[number, number]>): boolean {
  for (const [start, rangeEnd] of ranges) {
    if (pos < rangeEnd && end > start) return true;
    if (start > end) break;
  }
  return false;
}

/**
 * Apply fact-ref replacements to content, skipping positions inside F/code/etc.
 * Wraps the FIRST valid (non-skip-range) occurrence of each searchText (idempotency).
 */
export function applyFactRefReplacements(
  content: string,
  replacements: FactRefReplacement[],
): { content: string; applied: number } {
  const skipRanges = buildSkipRanges(content);
  let result = content;
  let applied = 0;
  let offset = 0;

  // Sort by position of first occurrence in original content
  const positioned = replacements.map(r => {
    const idx = content.indexOf(r.searchText);
    return { ...r, firstIdx: idx };
  }).filter(r => r.firstIdx !== -1)
    .sort((a, b) => a.firstIdx - b.firstIdx);

  for (const r of positioned) {
    // Scan through occurrences to find the first one not in a skip range.
    let searchStart = 0;
    while (true) {
      const searchIdx = result.indexOf(r.searchText, searchStart);
      if (searchIdx === -1) break;

      // Map back to original content position for skip-range check
      const origPos = searchIdx - offset;
      const origEnd = origPos + r.searchText.length;

      if (!isInSkipRange(origPos, origEnd, skipRanges)) {
        const replacement = `<F e="${r.entityId}" f="${r.factId}">${r.displayText}</F>`;
        result = result.slice(0, searchIdx) + replacement + result.slice(searchIdx + r.searchText.length);
        offset += replacement.length - r.searchText.length;
        applied++;
        break; // Only wrap the first valid occurrence
      }

      // This occurrence is in a skip range — advance past it and try next
      searchStart = searchIdx + r.searchText.length;
    }
  }

  return { content: result, applied };
}

/**
 * Call LLM to identify hardcoded numbers that match canonical facts.
 */
async function callLlmForFactRefs(
  content: string,
  factLookup: string,
): Promise<FactRefReplacement[]> {
  const client = createClient();

  const systemPrompt = `You are a fact-ref tagger for an AI safety wiki. Your task is to identify hardcoded numbers in wiki content that match canonical facts in the provided lookup table, and return structured replacement instructions.

Rules:
1. ONLY tag numbers that are in the provided fact lookup table
2. NEVER re-tag numbers already inside <F>...</F> or <F /> tags — check the content carefully
3. NEVER tag numbers inside code blocks (\`\`\`...\`\`\`), inline code (\`...\`), or JSX attributes
4. Match approximately: "$30 billion", "$30B", and "30,000,000,000" can all match a $30B fact
5. Only wrap when the SEMANTIC meaning matches — e.g., "$1B" could be revenue OR valuation. Use the fact's note to confirm. If ambiguous, skip.
6. Use the EXACT text as it appears in the content for searchText (including escaped chars like \\$)
7. Use the displayText from the original content (same as searchText usually)
8. The factId must be the exact 8-char hex hash from the lookup table
9. Return JSON only — no prose

Return a JSON object:
{
  "replacements": [
    {
      "searchText": "exact text in content including escaped chars",
      "entityId": "anthropic",
      "factId": "5b0663a0",
      "displayText": "exact text in content"
    }
  ]
}

If no replacements are needed, return: { "replacements": [] }`;

  const userPrompt = `## Fact Lookup Table
${factLookup}

## Content to Enrich
\`\`\`mdx
${content.slice(0, 6000)}${content.length > 6000 ? '\n... [truncated]' : ''}
\`\`\`

Identify hardcoded numbers matching canonical facts and return replacement instructions as JSON.`;

  const result = await callClaude(client, {
    model: MODELS.haiku,
    systemPrompt,
    userPrompt,
    maxTokens: 2000,
    temperature: 0,
  });

  const parsed = parseJsonResponse<LlmFactRefResponse>(result.text);
  if (!parsed?.replacements || !Array.isArray(parsed.replacements)) return [];

  return parsed.replacements
    .filter(r => r.searchText && r.entityId && r.factId && r.displayText)
    .map(r => ({
      searchText: r.searchText!,
      entityId: r.entityId!,
      factId: r.factId!,
      displayText: r.displayText!,
    }));
}

/**
 * Main enrichment function. Takes MDX content and returns enriched content.
 *
 * @param content - The MDX content to enrich
 * @param options.pageId - Page ID for fact lookup relevance filtering
 * @param options.root - Project root path (defaults to PROJECT_ROOT)
 * @param options.useLlm - Whether to use LLM for disambiguation (default: true)
 */
export async function enrichFactRefs(
  content: string,
  options: {
    pageId?: string;
    root?: string;
    useLlm?: boolean;
  } = {},
): Promise<FactRefEnrichResult> {
  const root = options.root ?? PROJECT_ROOT;
  const pageId = options.pageId ?? '';
  const useLlm = options.useLlm ?? true;

  const factLookup = buildFactLookupForContent(pageId, content, root);
  if (!factLookup.trim()) {
    return { content, insertedCount: 0, replacements: [] };
  }

  let replacements: FactRefReplacement[] = [];

  if (useLlm) {
    replacements = await callLlmForFactRefs(content, factLookup);
  }

  // Validate factIds are 8-char hex
  const hexRe = /^[0-9a-f]{8}$/i;
  replacements = replacements.filter(r => hexRe.test(r.factId));

  const { content: enriched, applied } = applyFactRefReplacements(content, replacements);

  return {
    content: enriched,
    insertedCount: applied,
    replacements,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  const positional = parsed._positional as string[];
  const colors = getColors(!!parsed.ci || !!parsed.json);

  const APPLY_MODE = parsed.apply === true;
  const ALL_MODE = parsed.all === true;
  const LIMIT = parseInt(String(parsed.limit || '0'), 10);
  const pageId = positional[0];

  if (!pageId && !ALL_MODE) {
    console.error(`${colors.red}Error: Provide a page-id or --all${colors.reset}`);
    console.log(`${colors.dim}Usage: crux enrich fact-refs <page-id> [--apply]${colors.reset}`);
    process.exit(1);
  }

  let files: string[] = [];

  if (ALL_MODE) {
    files = findMdxFiles(CONTENT_DIR_ABS);
    if (LIMIT > 0) files = files.slice(0, LIMIT);
  } else {
    const filePath = findPageFile(pageId);
    if (!filePath) {
      console.error(`${colors.red}Page not found: ${pageId}${colors.reset}`);
      process.exit(1);
    }
    files = [filePath];
  }

  let totalInserted = 0;
  let pagesChanged = 0;

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const filePageId = filePath.replace(/^.*\//, '').replace(/\.mdx$/, '');

    if (!parsed.ci && !parsed.json) {
      process.stdout.write(`${colors.dim}Processing ${filePageId}...${colors.reset}\r`);
    }

    const result = await enrichFactRefs(content, {
      pageId: filePageId,
      useLlm: true,
    });

    if (result.insertedCount === 0) continue;

    pagesChanged++;
    totalInserted += result.insertedCount;

    if (parsed.json) {
      console.log(JSON.stringify({ pageId: filePageId, insertedCount: result.insertedCount, replacements: result.replacements }));
    } else {
      console.log(`\n${colors.bold}${filePageId}${colors.reset} — ${colors.green}+${result.insertedCount} <F> tag(s)${colors.reset}`);
      for (const r of result.replacements) {
        console.log(`  ${colors.dim}${r.entityId}.${r.factId}${colors.reset} "${r.searchText}" → <F e="${r.entityId}" f="${r.factId}">${r.displayText}</F>`);
      }
    }

    if (APPLY_MODE) {
      writeFileSync(filePath, result.content, 'utf-8');
    }
  }

  if (!parsed.json) {
    if (ALL_MODE || files.length > 1) {
      console.log(`\n${colors.bold}Total:${colors.reset} ${totalInserted} <F> tags across ${pagesChanged} pages`);
    }
    if (!APPLY_MODE && totalInserted > 0) {
      console.log(`${colors.dim}Run with --apply to write changes.${colors.reset}`);
    }
  }
}

import { fileURLToPath as _fileURLToPath } from 'url';
if (process.argv[1] === _fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
