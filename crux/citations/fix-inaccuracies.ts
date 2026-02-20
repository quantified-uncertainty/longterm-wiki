/**
 * Citation Inaccuracy Auto-Fixer
 *
 * Reads flagged citations from the dashboard YAML, uses an LLM to generate
 * minimal targeted fixes, and applies them to MDX pages.
 *
 * Usage:
 *   pnpm crux citations fix-inaccuracies                        # Dry run all
 *   pnpm crux citations fix-inaccuracies --apply                 # Apply all
 *   pnpm crux citations fix-inaccuracies compute-governance      # One page
 *   pnpm crux citations fix-inaccuracies --verdict=inaccurate    # Filter by verdict
 *   pnpm crux citations fix-inaccuracies --max-score=0.5         # Only worst
 *
 * Requires: OPENROUTER_API_KEY
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT, CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { callOpenRouter, stripCodeFences, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { appendEditLog } from '../lib/edit-log.ts';
import type { FlaggedCitation } from './export-dashboard.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixProposal {
  footnote: number;
  original: string;
  replacement: string;
  explanation: string;
  fixType: string;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  details: Array<{
    footnote: number;
    status: 'applied' | 'not_found';
    explanation: string;
  }>;
}

// ---------------------------------------------------------------------------
// Dashboard YAML reader
// ---------------------------------------------------------------------------

const ACCURACY_DIR = join(PROJECT_ROOT, 'data', 'citation-accuracy');
const PAGES_DIR = join(ACCURACY_DIR, 'pages');

/** Read flagged citations from per-page YAML files (with fallback to old monolithic format). */
export function loadFlaggedCitations(opts: {
  pageId?: string;
  verdict?: string;
  maxScore?: number;
}): FlaggedCitation[] {
  let flagged: FlaggedCitation[] = [];

  // New split format: pages/<pageId>.yaml
  if (existsSync(PAGES_DIR)) {
    const files = readdirSync(PAGES_DIR).filter((f) => f.endsWith('.yaml'));

    // If filtering to one page, only read that file
    if (opts.pageId) {
      const pageFile = join(PAGES_DIR, `${opts.pageId}.yaml`);
      if (existsSync(pageFile)) {
        const raw = readFileSync(pageFile, 'utf-8');
        const parsed = yaml.load(raw);
        if (Array.isArray(parsed)) {
          flagged = parsed as FlaggedCitation[];
        }
      }
    } else {
      for (const f of files) {
        try {
          const raw = readFileSync(join(PAGES_DIR, f), 'utf-8');
          const parsed = yaml.load(raw);
          if (Array.isArray(parsed)) {
            flagged.push(...(parsed as FlaggedCitation[]));
          }
        } catch { /* skip malformed files */ }
      }
    }
  } else {
    // Fallback: old monolithic dashboard.yaml
    const oldPath = join(ACCURACY_DIR, 'dashboard.yaml');
    if (!existsSync(oldPath)) {
      throw new Error(
        `No citation accuracy data found. Run: pnpm crux citations export-dashboard`,
      );
    }
    const raw = readFileSync(oldPath, 'utf-8');
    const data = yaml.load(raw) as { flaggedCitations?: FlaggedCitation[] };
    flagged = data.flaggedCitations ?? [];

    if (opts.pageId) {
      flagged = flagged.filter((c) => c.pageId === opts.pageId);
    }
  }

  if (opts.verdict) {
    flagged = flagged.filter((c) => c.verdict === opts.verdict);
  }
  if (opts.maxScore !== undefined) {
    flagged = flagged.filter((c) => (c.score ?? 1) <= opts.maxScore!);
  }

  return flagged;
}

// ---------------------------------------------------------------------------
// Section context extraction
// ---------------------------------------------------------------------------

/**
 * Extract the section around a footnote reference for LLM context.
 * Returns ~20 lines centered around the first `[^N]` occurrence.
 */
export function extractSectionContext(body: string, footnoteNum: number): string {
  const marker = `[^${footnoteNum}]`;
  const idx = body.indexOf(marker);
  if (idx === -1) return '';

  const lines = body.split('\n');
  let lineIdx = 0;
  let charCount = 0;
  for (let i = 0; i < lines.length; i++) {
    charCount += lines[i].length + 1; // +1 for newline
    if (charCount > idx) {
      lineIdx = i;
      break;
    }
  }

  const start = Math.max(0, lineIdx - 10);
  const end = Math.min(lines.length, lineIdx + 11);
  return lines.slice(start, end).join('\n');
}

// ---------------------------------------------------------------------------
// LLM interaction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a wiki editor fixing citation inaccuracies. You receive flagged citations where the wiki text misrepresents or is unsupported by the cited source.

Your job is to generate MINIMAL, TARGETED fixes. Rules:

1. Make the SMALLEST change possible to fix the issue
2. Prefer softening language over removal ("X is Y" → "X may be Y", "X reportedly Y")
3. For wrong facts (dates, numbers): replace with correct value from the issue description
4. For unsupported claims: either soften with "reportedly" / "according to other sources" or remove the specific footnote reference [^N] if the claim itself is reasonable but the source doesn't support it
5. For fabricated details: remove the specific fabricated parts while keeping accurate parts
6. NEVER change footnote definitions (lines starting with [^N]:)
7. NEVER add new footnotes or alter MDX components like <EntityLink>
8. NEVER rewrite whole sections — fix only the specific problematic text
9. The "original" text must be an EXACT substring of the page content
10. Keep "original" as short as possible while being unique in the page

Return a JSON array of fix objects. If no fix is needed (e.g., the issue is with the source, not the wiki), return an empty array.

JSON format:
[
  {
    "footnote": 5,
    "original": "exact text from the page",
    "replacement": "fixed text",
    "explanation": "brief reason for the change",
    "fix_type": "soften|correct|remove_ref|remove_detail"
  }
]

Return ONLY valid JSON, no markdown fences.`;

function buildUserPrompt(
  pageId: string,
  flagged: FlaggedCitation[],
  pageContent: string,
): string {
  const body = stripFrontmatter(pageContent);
  const parts: string[] = [`Page: ${pageId}\n`];

  for (const c of flagged) {
    const context = extractSectionContext(body, c.footnote);
    parts.push(`--- Citation [^${c.footnote}] ---`);
    parts.push(`Verdict: ${c.verdict}`);
    parts.push(`Score: ${c.score}`);
    if (c.issues) {
      parts.push(`Issues: ${c.issues}`);
    }
    parts.push(`Source: ${c.sourceTitle ?? 'unknown'}`);
    if (context) {
      parts.push(`\nSection context:\n${context}`);
    }
    parts.push(`\nClaim text: ${c.claimText}\n`);
  }

  return parts.join('\n');
}

/** Parse LLM response into fix proposals. */
export function parseLLMFixResponse(content: string): FixProposal[] {
  const cleaned = stripCodeFences(content);
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (p: Record<string, unknown>) =>
          typeof p.original === 'string' &&
          typeof p.replacement === 'string' &&
          p.original.length > 0 &&
          p.original !== p.replacement,
      )
      .map((p: Record<string, unknown>) => ({
        footnote: typeof p.footnote === 'number' ? p.footnote : 0,
        original: p.original as string,
        replacement: p.replacement as string,
        explanation: typeof p.explanation === 'string' ? p.explanation : '',
        fixType: typeof p.fix_type === 'string' ? p.fix_type : 'unknown',
      }));
  } catch {
    return [];
  }
}

/** Generate fixes for all flagged citations on one page (single LLM call). */
export async function generateFixesForPage(
  pageId: string,
  flagged: FlaggedCitation[],
  pageContent: string,
  opts?: { model?: string },
): Promise<FixProposal[]> {
  const userPrompt = buildUserPrompt(pageId, flagged, pageContent);

  const response = await callOpenRouter(SYSTEM_PROMPT, userPrompt, {
    model: opts?.model,
    maxTokens: 4000,
    title: 'LongtermWiki Fix Inaccuracies',
  });

  return parseLLMFixResponse(response);
}

// ---------------------------------------------------------------------------
// Fix application
// ---------------------------------------------------------------------------

/**
 * Apply fix proposals to page content via string replacement.
 * Processes in reverse offset order to preserve positions.
 */
export function applyFixes(content: string, proposals: FixProposal[]): ApplyResult {
  const result: ApplyResult = { applied: 0, skipped: 0, details: [] };

  // Find offsets and sort descending
  const withOffsets = proposals.map((p) => ({
    ...p,
    offset: content.indexOf(p.original),
  }));

  // Sort by offset descending (bottom-to-top)
  withOffsets.sort((a, b) => b.offset - a.offset);

  let modified = content;

  for (const fix of withOffsets) {
    if (fix.offset === -1) {
      result.skipped++;
      result.details.push({
        footnote: fix.footnote,
        status: 'not_found',
        explanation: `Original text not found in page`,
      });
      continue;
    }

    // Verify the text at the expected offset still matches
    const atOffset = modified.slice(fix.offset, fix.offset + fix.original.length);
    if (atOffset !== fix.original) {
      result.skipped++;
      result.details.push({
        footnote: fix.footnote,
        status: 'not_found',
        explanation: `Text at offset ${fix.offset} no longer matches`,
      });
      continue;
    }

    modified =
      modified.slice(0, fix.offset) +
      fix.replacement +
      modified.slice(fix.offset + fix.original.length);
    result.applied++;
    result.details.push({
      footnote: fix.footnote,
      status: 'applied',
      explanation: fix.explanation,
    });
  }

  // Write back only if at least one fix applied
  if (result.applied > 0) {
    // The caller is responsible for writing the file
    // We just return the modified content via a side channel
    (result as ApplyResult & { content: string }).content = modified;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Page file lookup
// ---------------------------------------------------------------------------

function findPageFile(pageId: string): string | null {
  const allFiles = findMdxFiles(CONTENT_DIR_ABS);
  for (const f of allFiles) {
    const basename = f.split('/').pop()?.replace(/\.mdx?$/, '');
    if (basename === pageId) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const apply = args.apply === true;
  const json = args.json === true;
  const model = typeof args.model === 'string' ? args.model : undefined;
  const verdictFilter = typeof args.verdict === 'string' ? args.verdict : undefined;
  const maxScore = typeof args['max-score'] === 'string'
    ? parseFloat(args['max-score'])
    : undefined;

  const positional = args._positional as string[];
  const pageIdFilter = positional[0];

  const c = getColors(json);

  // Load flagged citations
  let flagged: FlaggedCitation[];
  try {
    flagged = loadFlaggedCitations({
      pageId: pageIdFilter,
      verdict: verdictFilter,
      maxScore,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${c.red}Error: ${msg}${c.reset}`);
    process.exit(1);
  }

  if (flagged.length === 0) {
    if (json) {
      console.log(JSON.stringify({ fixesProposed: 0, fixesApplied: 0, pages: [] }));
    } else {
      console.log(`${c.green}No flagged citations found matching filters.${c.reset}`);
    }
    process.exit(0);
  }

  // Group by page
  const byPage = new Map<string, FlaggedCitation[]>();
  for (const f of flagged) {
    if (!byPage.has(f.pageId)) byPage.set(f.pageId, []);
    byPage.get(f.pageId)!.push(f);
  }

  if (!json) {
    console.log(
      `\n${c.bold}${c.blue}Citation Inaccuracy Fixer${c.reset}${apply ? ` ${c.red}(APPLY MODE)${c.reset}` : ` ${c.dim}(dry run)${c.reset}`}\n`,
    );
    console.log(
      `  ${flagged.length} flagged citation${flagged.length === 1 ? '' : 's'} across ${byPage.size} page${byPage.size === 1 ? '' : 's'}`,
    );
    console.log(`  Model: ${model || DEFAULT_CITATION_MODEL}\n`);
  }

  const concurrency = Math.max(1, parseInt((args.concurrency as string) || '1', 10));
  if (!json && concurrency > 1) {
    console.log(`  Concurrency: ${concurrency}\n`);
  }

  interface PageResult {
    pageId: string;
    proposals: FixProposal[];
    applyResult?: ApplyResult;
  }

  const allResults: PageResult[] = [];
  const pageEntries = [...byPage.entries()];
  const verbose = !json && concurrency === 1;
  const runStart = Date.now();

  for (let i = 0; i < pageEntries.length; i += concurrency) {
    const batch = pageEntries.slice(i, i + concurrency);
    const batchStart = Date.now();

    const batchResults = await Promise.all(
      batch.map(async ([pageId, pageFlagged], batchIdx): Promise<PageResult | null> => {
        const globalIdx = i + batchIdx;

        if (!json) {
          console.log(
            `${c.dim}[${globalIdx + 1}/${pageEntries.length}]${c.reset} ${c.bold}${pageId}${c.reset} (${pageFlagged.length} flagged)`,
          );
        }

        // Find the page file
        const filePath = findPageFile(pageId);
        if (!filePath) {
          if (!json) {
            console.log(`  ${c.red}${pageId}: Page file not found — skipping${c.reset}`);
          }
          return null;
        }

        const pageContent = readFileSync(filePath, 'utf-8');

        // Generate fixes via LLM
        let proposals: FixProposal[];
        try {
          proposals = await generateFixesForPage(pageId, pageFlagged, pageContent, { model });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!json) {
            console.log(`  ${c.red}${pageId}: LLM error — ${msg.slice(0, 100)}${c.reset}`);
          }
          return null;
        }

        if (proposals.length === 0) {
          if (verbose) {
            console.log(`  ${c.dim}No fixes proposed${c.reset}`);
          } else if (!json) {
            console.log(`  ${c.dim}${pageId}: no fixes proposed${c.reset}`);
          }
          return { pageId, proposals: [] };
        }

        // Display proposals
        if (verbose) {
          for (const p of proposals) {
            console.log(`  ${c.yellow}[^${p.footnote}]${c.reset} ${p.fixType}: ${p.explanation}`);
            console.log(`    ${c.red}- ${truncate(p.original, 100)}${c.reset}`);
            console.log(`    ${c.green}+ ${truncate(p.replacement, 100)}${c.reset}`);
          }
        }

        // Apply if requested
        if (apply) {
          const applyResult = applyFixes(pageContent, proposals);
          const modifiedContent = (applyResult as ApplyResult & { content?: string }).content;

          if (applyResult.applied > 0 && modifiedContent) {
            writeFileSync(filePath, modifiedContent, 'utf-8');
            appendEditLog(pageId, {
              tool: 'crux-fix',
              agency: 'automated',
              note: `Fixed ${applyResult.applied} flagged citation inaccuracies`,
            });
          }

          if (!json) {
            const appliedStr = applyResult.applied > 0
              ? `${c.green}${applyResult.applied} applied${c.reset}`
              : `${c.dim}0 applied${c.reset}`;
            const skippedStr = applyResult.skipped > 0
              ? ` ${c.yellow}(${applyResult.skipped} skipped)${c.reset}`
              : '';
            console.log(`  ${pageId}: ${proposals.length} proposed, ${appliedStr}${skippedStr}`);
          }

          return { pageId, proposals, applyResult };
        }

        if (!verbose && !json) {
          console.log(`  ${c.green}${pageId}:${c.reset} ${proposals.length} fixes proposed`);
        }

        return { pageId, proposals };
      }),
    );

    for (const r of batchResults) {
      if (r) allResults.push(r);
    }

    // Timing + ETA
    if (!json && pageEntries.length > concurrency) {
      const pagesCompleted = Math.min(i + concurrency, pageEntries.length);
      const elapsed = (Date.now() - runStart) / 1000;
      const batchSec = (Date.now() - batchStart) / 1000;
      const avgPerPage = elapsed / pagesCompleted;
      const remaining = avgPerPage * (pageEntries.length - pagesCompleted);
      const etaStr = remaining > 0
        ? `ETA ${Math.ceil(remaining / 60)}m ${Math.round(remaining % 60)}s`
        : 'done';
      console.log(
        `${c.dim}  batch ${batchSec.toFixed(0)}s | elapsed ${Math.floor(elapsed / 60)}m ${Math.round(elapsed % 60)}s | ${etaStr}${c.reset}`,
      );
    }

    console.log('');
  }

  // Summary
  const totalProposed = allResults.reduce((s, r) => s + r.proposals.length, 0);
  const totalApplied = allResults.reduce((s, r) => s + (r.applyResult?.applied ?? 0), 0);

  if (json) {
    console.log(
      JSON.stringify(
        {
          fixesProposed: totalProposed,
          fixesApplied: totalApplied,
          pages: allResults.map((r) => ({
            pageId: r.pageId,
            proposed: r.proposals.length,
            applied: r.applyResult?.applied ?? 0,
            skipped: r.applyResult?.skipped ?? 0,
            fixes: r.proposals.map((p) => ({
              footnote: p.footnote,
              fixType: p.fixType,
              explanation: p.explanation,
            })),
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`${c.bold}Summary${c.reset}`);
    console.log(`  Proposed: ${totalProposed}`);
    if (apply) {
      console.log(`  Applied:  ${totalApplied}`);
    }

    if (apply && totalApplied > 0) {
      console.log(`\n${c.dim}Next steps:${c.reset}`);
      console.log(`  1. pnpm crux fix escaping`);
      console.log(`  2. pnpm crux validate unified --rules=comparison-operators,dollar-signs --errors-only`);
      console.log(`  3. Re-run check-accuracy on fixed pages to verify`);
    } else if (!apply && totalProposed > 0) {
      console.log(`\n${c.dim}Run with --apply to write changes.${c.reset}`);
    }
    console.log('');
  }

  process.exit(0);
}

function truncate(s: string, maxLen: number): string {
  const oneLine = s.replace(/\n/g, ' ');
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '...' : oneLine;
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
