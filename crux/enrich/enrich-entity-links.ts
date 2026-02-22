/**
 * EntityLink Enrichment Tool
 *
 * Standalone tool to insert `<EntityLink id="E##">name</EntityLink>` tags
 * for entity mentions in MDX page content.
 *
 * Features:
 * - Idempotent: skips text already inside <EntityLink> or other JSX tags
 * - Works at section-level and page-level
 * - Uses Haiku (cheap) for LLM disambiguation with exact-match fast path
 * - Never double-links: exact-match deduplication is enforced
 *
 * Usage (CLI):
 *   pnpm crux enrich entity-links <page-id>           # Preview (dry run)
 *   pnpm crux enrich entity-links <page-id> --apply   # Write to file
 *   pnpm crux enrich entity-links --all [--limit=N]   # Batch across wiki
 *
 * Usage (library):
 *   import { enrichEntityLinks } from './enrich-entity-links.ts';
 *   const result = await enrichEntityLinks(content, { root: ROOT });
 */

import { readFileSync, writeFileSync } from 'fs';
import { CONTENT_DIR_ABS, PROJECT_ROOT } from '../lib/content-types.ts';
import { findMdxFiles, findPageFile } from '../lib/file-utils.ts';
import { buildEntityLookupForContent } from '../lib/entity-lookup.ts';
import { createClient, MODELS, callClaude, parseJsonResponse } from '../lib/anthropic.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { NUMERIC_ID_RE } from '../lib/patterns.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityLinkReplacement {
  /** The exact text to replace (as it appears in the content) */
  searchText: string;
  /** The numeric entity ID, e.g. "E22" */
  entityId: string;
  /** The display name for the EntityLink tag */
  displayName: string;
}

export interface EntityLinkEnrichResult {
  /** The enriched content */
  content: string;
  /** Number of EntityLink tags inserted */
  insertedCount: number;
  /** The proposed replacements (whether or not --apply was used) */
  replacements: EntityLinkReplacement[];
}

interface LlmEntityLinkResponse {
  replacements?: Array<{
    searchText?: string;
    entityId?: string;
    displayName?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Core logic (exportable library functions)
// ---------------------------------------------------------------------------

/**
 * Build a set of text spans that are already inside JSX/EntityLink tags,
 * so we don't try to link them again.
 */
function buildAlreadyLinkedSet(content: string): Set<string> {
  const linked = new Set<string>();
  // Find all existing EntityLink display texts
  const entityLinkFull = /<EntityLink\s[^>]*>([\s\S]*?)<\/EntityLink>/g;
  for (const match of content.matchAll(entityLinkFull)) {
    linked.add(match[1].trim());
  }
  return linked;
}

/**
 * Check if a position in the content is inside a JSX tag, EntityLink, or code block.
 * Returns true if the position should be skipped for replacement.
 */
function buildSkipRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // Skip content inside <EntityLink>...</EntityLink>
  const entityLinkFull = /<EntityLink\s[\s\S]*?<\/EntityLink>/g;
  for (const match of content.matchAll(entityLinkFull)) {
    if (match.index !== undefined) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  // Skip content inside JSX attribute values (id="...", etc.)
  const jsxAttr = /=["'][^"']*["']/g;
  for (const match of content.matchAll(jsxAttr)) {
    if (match.index !== undefined) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  // Skip code blocks (```...``` and inline `...`)
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

  // Skip HTML/JSX tag attributes (not just attribute values)
  const jsxOpenTag = /<[A-Z][a-zA-Z0-9]*\s[^>]*>/g;
  for (const match of content.matchAll(jsxOpenTag)) {
    if (match.index !== undefined) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  // Skip markdown links [display text](url) — both display text and URL.
  // Handles one level of nested parens in URLs (e.g. Wikipedia links like /wiki/Foo_(bar)).
  const markdownLink = /!?\[[^\]]*\]\((?:[^()]*|\([^()]*\))*\)/g;
  for (const match of content.matchAll(markdownLink)) {
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
 * Apply a list of replacements to content, skipping positions inside JSX/code.
 * Links the FIRST valid (non-skip-range) occurrence of each searchText to maintain
 * idempotency and the first-mention linking convention.
 */
export function applyEntityLinkReplacements(
  content: string,
  replacements: EntityLinkReplacement[],
): { content: string; applied: number; appliedReplacements: EntityLinkReplacement[] } {
  const skipRanges = buildSkipRanges(content);
  let result = content;
  let applied = 0;
  let offset = 0;
  const appliedReplacements: EntityLinkReplacement[] = [];

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
        const replacement = `<EntityLink id="${r.entityId}">${r.displayName}</EntityLink>`;
        result = result.slice(0, searchIdx) + replacement + result.slice(searchIdx + r.searchText.length);
        offset += replacement.length - r.searchText.length;
        applied++;
        appliedReplacements.push(r);
        break; // Only link the first valid occurrence per entity
      }

      // This occurrence is in a skip range — advance past it and try next
      searchStart = searchIdx + r.searchText.length;
    }
  }

  return { content: result, applied, appliedReplacements };
}

/**
 * Call LLM to identify entity mentions and produce replacement instructions.
 */
async function callLlmForEntityLinks(
  content: string,
  entityLookup: string,
  alreadyLinked: Set<string>,
): Promise<EntityLinkReplacement[]> {
  const client = createClient();

  const alreadyLinkedList = alreadyLinked.size > 0
    ? `Already linked (SKIP these, do not re-link):\n${[...alreadyLinked].map(t => `  - "${t}"`).join('\n')}`
    : 'Nothing linked yet.';

  const systemPrompt = `You are an entity linker for an AI safety wiki. Your task is to identify entity mentions in wiki content and return structured replacement instructions.

Rules:
1. ONLY link entities that are in the provided entity lookup table
2. NEVER re-link text already inside <EntityLink> tags (see already-linked list)
3. Link the FIRST unlinked mention of each entity on the page — do not link every occurrence
4. Use exact text from the content — no paraphrasing or normalization
5. Do NOT link entities in code blocks, import statements, frontmatter, or JSX attributes
6. Do NOT link very short entity names (< 3 chars) that are ambiguous
7. Prefer specific entity matches over generic ones (e.g., "Anthropic" → anthropic, not a category)
8. Return JSON only — no prose

Return a JSON object with this shape:
{
  "replacements": [
    { "searchText": "exact text in content", "entityId": "E22", "displayName": "Anthropic" }
  ]
}

If no replacements are needed, return: { "replacements": [] }`;

  const userPrompt = `## Entity Lookup Table
${entityLookup}

## Already Linked
${alreadyLinkedList}

## Content to Enrich
\`\`\`mdx
${content.slice(0, 6000)}${content.length > 6000 ? '\n... [truncated]' : ''}
\`\`\`

Identify entity mentions and return replacement instructions as JSON.`;

  const result = await callClaude(client, {
    model: MODELS.haiku,
    systemPrompt,
    userPrompt,
    maxTokens: 2000,
    temperature: 0,
  });

  const parsed = parseJsonResponse<LlmEntityLinkResponse>(result.text);
  if (!parsed?.replacements || !Array.isArray(parsed.replacements)) return [];

  return parsed.replacements
    .filter(r => r.searchText && r.entityId && r.displayName)
    .map(r => ({
      searchText: r.searchText!,
      entityId: r.entityId!,
      displayName: r.displayName!,
    }));
}

/**
 * Main enrichment function. Takes MDX content and returns enriched content.
 *
 * @param content - The MDX content to enrich
 * @param options.root - Project root path (defaults to PROJECT_ROOT)
 * @param options.useLlm - Whether to use LLM for disambiguation (default: true)
 */
export async function enrichEntityLinks(
  content: string,
  options: {
    root?: string;
    useLlm?: boolean;
  } = {},
): Promise<EntityLinkEnrichResult> {
  const root = options.root ?? PROJECT_ROOT;
  const useLlm = options.useLlm ?? true;

  const entityLookup = buildEntityLookupForContent(content, root);
  if (!entityLookup.trim()) {
    return { content, insertedCount: 0, replacements: [] };
  }

  const alreadyLinked = buildAlreadyLinkedSet(content);

  let replacements: EntityLinkReplacement[] = [];

  if (useLlm) {
    replacements = await callLlmForEntityLinks(content, entityLookup, alreadyLinked);
  }

  // Filter out replacements for already-linked text
  replacements = replacements.filter(r => !alreadyLinked.has(r.displayName));

  // Validate all entityIds are in E## format
  replacements = replacements.filter(r => NUMERIC_ID_RE.test(r.entityId));

  const { content: enriched, applied, appliedReplacements } = applyEntityLinkReplacements(content, replacements);

  return {
    content: enriched,
    insertedCount: applied,
    replacements: appliedReplacements,
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
    console.log(`${colors.dim}Usage: crux enrich entity-links <page-id> [--apply]${colors.reset}`);
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

    const result = await enrichEntityLinks(content, {
      useLlm: true,
    });

    if (result.insertedCount === 0) continue;

    pagesChanged++;
    totalInserted += result.insertedCount;

    if (parsed.json) {
      console.log(JSON.stringify({ pageId: filePageId, insertedCount: result.insertedCount, replacements: result.replacements }));
    } else {
      console.log(`\n${colors.bold}${filePageId}${colors.reset} — ${colors.green}+${result.insertedCount} EntityLink(s)${colors.reset}`);
      for (const r of result.replacements) {
        console.log(`  ${colors.dim}${r.entityId}${colors.reset} "${r.searchText}" → <EntityLink id="${r.entityId}">${r.displayName}</EntityLink>`);
      }
    }

    if (APPLY_MODE) {
      writeFileSync(filePath, result.content, 'utf-8');
    }
  }

  if (!parsed.json) {
    if (ALL_MODE || files.length > 1) {
      console.log(`\n${colors.bold}Total:${colors.reset} ${totalInserted} EntityLinks across ${pagesChanged} pages`);
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
