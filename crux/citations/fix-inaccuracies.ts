/**
 * Citation Inaccuracy Auto-Fixer
 *
 * Reads flagged citations from the dashboard YAML (for discovery), then
 * enriches each with full source text from SQLite before generating fixes.
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
import { citationQuotes, citationContent } from '../lib/knowledge-db.ts';
import { checkAccuracyForPage } from './check-accuracy.ts';
import { extractQuotesForPage } from './extract-quotes.ts';
import { exportDashboardData } from './export-dashboard.ts';
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
// SQLite enrichment — pull full source text for better fix generation
// ---------------------------------------------------------------------------

export interface EnrichedFlaggedCitation extends FlaggedCitation {
  fullClaimText: string | null;
  sourceQuote: string | null;
  supportingQuotes: string | null;
  sourceFullText: string | null;
}

/**
 * Enrich flagged citations with full data from SQLite.
 * Falls back gracefully if SQLite is unavailable (e.g., on Vercel).
 */
export function enrichFromSqlite(flagged: FlaggedCitation[]): EnrichedFlaggedCitation[] {
  try {
    return flagged.map((f) => {
      const row = citationQuotes.get(f.pageId, f.footnote);
      let sourceFullText: string | null = null;
      if (f.url) {
        const cached = citationContent.getByUrl(f.url);
        if (cached?.full_text) {
          sourceFullText = cached.full_text;
        }
      }
      return {
        ...f,
        fullClaimText: row?.claim_text ?? null,
        sourceQuote: row?.source_quote ?? null,
        supportingQuotes: row?.accuracy_supporting_quotes ?? null,
        sourceFullText,
      };
    });
  } catch {
    // SQLite unavailable — return with null enrichments
    return flagged.map((f) => ({
      ...f,
      fullClaimText: null,
      sourceQuote: null,
      supportingQuotes: null,
      sourceFullText: null,
    }));
  }
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

You are given:
- The wiki section context around each flagged citation
- The issue description explaining what's wrong
- Source evidence: passages from the cited source showing what it actually says

Generate fixes that make the wiki text accurately reflect the cited source. Rules:

1. Use the SOURCE EVIDENCE to determine what's correct. Replace wrong facts, names, numbers, and dates with the correct values from the source. Do NOT guess — use the exact values the source provides.
2. If the source says something substantially different from the wiki, rewrite the claim to match the source. Larger rewrites are fine when the original is substantially wrong.
3. For unsupported claims (source doesn't address the topic at all): either remove the footnote reference [^N] if the claim might still be true from other sources, or remove/rewrite the claim if it appears fabricated.
4. For overclaims: tone down the language to match what the source actually supports.
5. Keep accurate parts of claims intact — only change what's wrong.
6. NEVER change footnote definitions (lines starting with [^N]:)
7. NEVER add new footnotes or alter MDX components like <EntityLink>
8. The "original" text must be an EXACT substring of the page content
9. Keep "original" as short as possible while being unique in the page

Return a JSON array of fix objects. If no fix is needed (e.g., the issue is with the source, not the wiki), return an empty array.

JSON format:
[
  {
    "footnote": 5,
    "original": "exact text from the page",
    "replacement": "fixed text",
    "explanation": "brief reason for the change",
    "fix_type": "rewrite|correct|soften|remove_ref|remove_detail"
  }
]

Return ONLY valid JSON, no markdown fences.`;

/** Max source text chars to include in the fixer prompt per citation. */
const MAX_SOURCE_PER_CITATION = 8_000;

function buildUserPrompt(
  pageId: string,
  flagged: EnrichedFlaggedCitation[],
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

    // Use full claim text from SQLite when available (YAML version is truncated)
    const claimText = c.fullClaimText || c.claimText;
    parts.push(`\nClaim text: ${claimText}`);

    if (context) {
      parts.push(`\nSection context:\n${context}`);
    }

    // Include source evidence so the LLM can determine the correct values
    const sourceEvidence = buildSourceEvidence(c);
    if (sourceEvidence) {
      parts.push(`\nSource evidence (use this to determine correct values):\n${sourceEvidence}`);
    }

    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Build source evidence string from enriched citation data.
 * Prioritizes: supporting quotes > extracted quote > truncated full text.
 */
function buildSourceEvidence(c: EnrichedFlaggedCitation): string | null {
  const parts: string[] = [];

  // Supporting quotes from accuracy check (most targeted)
  if (c.supportingQuotes) {
    parts.push('Key passages from source:');
    parts.push(c.supportingQuotes);
  }

  // Extracted quote from the source
  if (c.sourceQuote && !c.supportingQuotes?.includes(c.sourceQuote.slice(0, 50))) {
    parts.push('Extracted quote:');
    parts.push(c.sourceQuote);
  }

  // If we have supporting quotes, that's usually enough
  if (parts.length > 0) return parts.join('\n');

  // Fall back to truncated full source text
  if (c.sourceFullText) {
    const truncated = c.sourceFullText.length > MAX_SOURCE_PER_CITATION
      ? c.sourceFullText.slice(0, MAX_SOURCE_PER_CITATION) + '\n[... truncated ...]'
      : c.sourceFullText;
    parts.push('Full source text:');
    parts.push(truncated);
  }

  return parts.length > 0 ? parts.join('\n') : null;
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
  flagged: FlaggedCitation[] | EnrichedFlaggedCitation[],
  pageContent: string,
  opts?: { model?: string },
): Promise<FixProposal[]> {
  // Enrich if not already enriched
  const enriched: EnrichedFlaggedCitation[] = 'fullClaimText' in (flagged[0] ?? {})
    ? (flagged as EnrichedFlaggedCitation[])
    : enrichFromSqlite(flagged);

  const userPrompt = buildUserPrompt(pageId, enriched, pageContent);

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

  // Load flagged citations from YAML, then enrich with SQLite source data
  let enriched: EnrichedFlaggedCitation[];
  try {
    const flagged = loadFlaggedCitations({
      pageId: pageIdFilter,
      verdict: verdictFilter,
      maxScore,
    });
    enriched = enrichFromSqlite(flagged);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${c.red}Error: ${msg}${c.reset}`);
    process.exit(1);
  }

  if (enriched.length === 0) {
    if (json) {
      console.log(JSON.stringify({ fixesProposed: 0, fixesApplied: 0, pages: [] }));
    } else {
      console.log(`${c.green}No flagged citations found matching filters.${c.reset}`);
    }
    process.exit(0);
  }

  // Count how many have source evidence
  const withSource = enriched.filter(
    (e) => e.supportingQuotes || e.sourceQuote || e.sourceFullText,
  ).length;

  // Group by page
  const byPage = new Map<string, EnrichedFlaggedCitation[]>();
  for (const f of enriched) {
    if (!byPage.has(f.pageId)) byPage.set(f.pageId, []);
    byPage.get(f.pageId)!.push(f);
  }

  if (!json) {
    console.log(
      `\n${c.bold}${c.blue}Citation Inaccuracy Fixer${c.reset}${apply ? ` ${c.red}(APPLY MODE)${c.reset}` : ` ${c.dim}(dry run)${c.reset}`}\n`,
    );
    console.log(
      `  ${enriched.length} flagged citation${enriched.length === 1 ? '' : 's'} across ${byPage.size} page${byPage.size === 1 ? '' : 's'}`,
    );
    console.log(`  Source evidence: ${withSource}/${enriched.length} citations have source text`);
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

  // Re-verify fixed pages to confirm improvements
  const pagesWithAppliedFixes = allResults
    .filter((r) => r.applyResult && r.applyResult.applied > 0)
    .map((r) => r.pageId);

  interface ReVerifyResult {
    pageId: string;
    before: { inaccurate: number; unsupported: number };
    after: { inaccurate: number; unsupported: number; accurate: number };
  }
  const reVerifyResults: ReVerifyResult[] = [];

  if (apply && pagesWithAppliedFixes.length > 0) {
    if (!json) {
      console.log(`${c.bold}${c.blue}Re-verifying fixed pages...${c.reset}\n`);
    }

    for (const pageId of pagesWithAppliedFixes) {
      const pageFlagged = byPage.get(pageId) || [];
      const beforeInaccurate = pageFlagged.filter((f) => f.verdict === 'inaccurate').length;
      const beforeUnsupported = pageFlagged.filter((f) => f.verdict === 'unsupported').length;

      try {
        if (!json) {
          process.stdout.write(`  ${pageId}: re-extracting claims... `);
        }

        // Re-extract claims from the updated page to update claim_text in SQLite
        const filePath = findPageFile(pageId);
        if (filePath) {
          const updatedRaw = readFileSync(filePath, 'utf-8');
          const updatedBody = stripFrontmatter(updatedRaw);
          await extractQuotesForPage(pageId, updatedBody, { verbose: false, recheck: true });
        }

        if (!json) {
          process.stdout.write(`re-checking... `);
        }
        const result = await checkAccuracyForPage(pageId, {
          verbose: false,
          recheck: true,
        });
        reVerifyResults.push({
          pageId,
          before: { inaccurate: beforeInaccurate, unsupported: beforeUnsupported },
          after: {
            inaccurate: result.inaccurate,
            unsupported: result.unsupported,
            accurate: result.accurate,
          },
        });

        if (!json) {
          const beforeTotal = beforeInaccurate + beforeUnsupported;
          const afterTotal = result.inaccurate + result.unsupported;
          const improved = beforeTotal - afterTotal;
          if (improved > 0) {
            console.log(`${c.green}${improved} fixed${c.reset} (${beforeTotal} → ${afterTotal} flagged)`);
          } else if (improved === 0) {
            console.log(`${c.yellow}unchanged${c.reset} (${afterTotal} flagged)`);
          } else {
            console.log(`${c.red}regression${c.reset} (${beforeTotal} → ${afterTotal} flagged)`);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!json) {
          console.log(`${c.red}error: ${msg.slice(0, 80)}${c.reset}`);
        }
      }
    }

    // Re-export dashboard data with updated verdicts
    exportDashboardData();

    if (!json) console.log('');
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          fixesProposed: totalProposed,
          fixesApplied: totalApplied,
          reVerification: reVerifyResults,
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

    if (reVerifyResults.length > 0) {
      const totalBefore = reVerifyResults.reduce(
        (s, r) => s + r.before.inaccurate + r.before.unsupported, 0,
      );
      const totalAfter = reVerifyResults.reduce(
        (s, r) => s + r.after.inaccurate + r.after.unsupported, 0,
      );
      const improved = totalBefore - totalAfter;
      console.log(
        `  Re-verified: ${improved > 0 ? c.green : c.yellow}${improved} citations improved${c.reset} (${totalBefore} → ${totalAfter} flagged)`,
      );
    }

    if (!apply && totalProposed > 0) {
      console.log(`\n${c.dim}Run with --apply to write changes and auto-re-verify.${c.reset}`);
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
