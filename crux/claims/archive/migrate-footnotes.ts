/**
 * Migrate numbered footnotes to DB-driven references.
 *
 * For each [^N] in the page:
 * 1. Parse the footnote definition to extract URL and title
 * 2. Check citation_quotes table for matching (pageId, footnote) entries
 * 3. If match with linked claimId → create claim_page_reference with referenceId → use [^cr-XXXX]
 * 4. If no match or no claim link → create page_citation with referenceId → use [^rc-XXXX]
 * 5. Remove the [^N]: definitions from the bottom
 *
 * Usage:
 *   pnpm crux claims migrate-footnotes <page-id>           # dry-run
 *   pnpm crux claims migrate-footnotes <page-id> --apply   # write changes
 */

import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { parseFootnotes, type ParsedFootnote } from '../lib/footnote-parser.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { createClaimReference, createCitationsBatch } from '../lib/wiki-server/references.ts';
import type { ClaimPageReferenceInsert, PageCitationInsert } from '../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Citation quote row from the DB, including the claimId FK that isn't in the TS type */
interface CitationQuoteWithClaim {
  id: number;
  pageId: string;
  footnote: number;
  url: string | null;
  resourceId: string | null;
  claimText: string;
  claimContext: string | null;
  sourceQuote: string | null;
  sourceTitle: string | null;
  claimId: number | null;
  accuracyVerdict: string | null;
}

interface MigrationEntry {
  footnoteNumber: number;
  referenceId: string;
  type: 'claim' | 'citation';
  /** For claim refs: the claim ID in the DB */
  claimId: number | null;
  /** Parsed footnote data */
  footnote: ParsedFootnote;
  /** Matching citation_quote row, if any */
  quoteRow: CitationQuoteWithClaim | null;
}

interface MigrationResult {
  pageId: string;
  totalFootnotes: number;
  claimRefs: number;
  citations: number;
  entries: MigrationEntry[];
  modifiedContent: string | null;
  applied: boolean;
}

// ---------------------------------------------------------------------------
// Reference ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a short, stable reference ID from input data.
 * Format: prefix-XXXX where XXXX is 4 hex chars from a SHA-256 hash.
 */
export function generateReferenceId(
  prefix: 'cr' | 'rc',
  data: string,
  existingIds: Set<string>,
): string {
  const hash = createHash('sha256').update(data).digest('hex');
  // Try 4-char slices until we find a unique one
  for (let offset = 0; offset < hash.length - 4; offset++) {
    const candidate = `${prefix}-${hash.slice(offset, offset + 4)}`;
    if (!existingIds.has(candidate)) {
      existingIds.add(candidate);
      return candidate;
    }
  }
  // Fallback: use 8 chars (extremely unlikely to collide)
  const fallback = `${prefix}-${hash.slice(0, 8)}`;
  existingIds.add(fallback);
  return fallback;
}

// ---------------------------------------------------------------------------
// Fetch citation quotes (with claimId) for a page
// ---------------------------------------------------------------------------

async function fetchQuotesWithClaimId(
  pageId: string,
): Promise<CitationQuoteWithClaim[]> {
  // Use a large limit to get all quotes — Kalshi has ~100 footnotes
  const result = await apiRequest<{ quotes: CitationQuoteWithClaim[] }>(
    'GET',
    `/api/citations/quotes?page_id=${encodeURIComponent(pageId)}&limit=500`,
  );
  if (!result.ok) {
    return [];
  }
  return result.data.quotes;
}

// ---------------------------------------------------------------------------
// Core migration logic
// ---------------------------------------------------------------------------

export async function migratePageFootnotes(
  pageId: string,
  options: { apply?: boolean } = {},
): Promise<MigrationResult> {
  const { apply = false } = options;

  // 1. Find and read the MDX file
  const filePath = findPageFile(pageId);
  if (!filePath) {
    throw new Error(`Page file not found for ID: ${pageId}`);
  }
  const content = readFileSync(filePath, 'utf-8');

  // 2. Parse footnote definitions
  const footnotes = parseFootnotes(content);
  if (footnotes.length === 0) {
    return {
      pageId,
      totalFootnotes: 0,
      claimRefs: 0,
      citations: 0,
      entries: [],
      modifiedContent: null,
      applied: false,
    };
  }

  // 3. Fetch citation_quotes from DB for this page
  const quoteRows = await fetchQuotesWithClaimId(pageId);
  const quoteByFootnote = new Map<number, CitationQuoteWithClaim>();
  for (const q of quoteRows) {
    quoteByFootnote.set(q.footnote, q);
  }

  // 4. Build migration entries
  const usedIds = new Set<string>();
  const entries: MigrationEntry[] = [];

  for (const fn of footnotes) {
    const quoteRow = quoteByFootnote.get(fn.number) ?? null;
    const hasLinkedClaim = quoteRow !== null && quoteRow.claimId !== null;

    if (hasLinkedClaim) {
      // Claim-backed reference
      const refId = generateReferenceId(
        'cr',
        `claim:${quoteRow!.claimId}:${pageId}:${fn.number}`,
        usedIds,
      );
      entries.push({
        footnoteNumber: fn.number,
        referenceId: refId,
        type: 'claim',
        claimId: quoteRow!.claimId,
        footnote: fn,
        quoteRow,
      });
    } else {
      // Regular citation
      const refId = generateReferenceId(
        'rc',
        `cite:${pageId}:${fn.number}:${fn.url ?? fn.rawText}`,
        usedIds,
      );
      entries.push({
        footnoteNumber: fn.number,
        referenceId: refId,
        type: 'citation',
        claimId: null,
        footnote: fn,
        quoteRow,
      });
    }
  }

  // 5. Rewrite the MDX content
  let modified = content;

  // Replace inline references: [^N] → [^cr-XXXX] or [^rc-XXXX]
  // We process in reverse order of footnote number to avoid offset issues
  // when replacing shorter numbers with longer reference IDs.
  const sortedEntries = [...entries].sort(
    (a, b) => b.footnoteNumber - a.footnoteNumber,
  );

  for (const entry of sortedEntries) {
    const fnNum = entry.footnoteNumber;
    // Replace inline references [^N] (but NOT the definition lines [^N]:)
    // Pattern: [^N] that is NOT followed by ]:
    const inlinePattern = new RegExp(
      `\\[\\^${fnNum}\\](?!:)`,
      'g',
    );
    modified = modified.replace(inlinePattern, `[^${entry.referenceId}]`);
  }

  // Remove footnote definition lines [^N]: ...
  // Handle multi-line definitions (continuation lines indented by 2+ spaces)
  const lines = modified.split('\n');
  const filteredLines: string[] = [];
  let inFootnoteDef = false;

  for (const line of lines) {
    const fnDefMatch = line.match(/^\[\^(\d+)\]:\s*/);
    if (fnDefMatch) {
      inFootnoteDef = true;
      continue; // Skip footnote definition line
    }
    if (inFootnoteDef && /^[\t ]{2,}/.test(line)) {
      continue; // Skip continuation line
    }
    inFootnoteDef = false;
    filteredLines.push(line);
  }

  // Clean up trailing blank lines that were around the footnote block
  while (
    filteredLines.length > 0 &&
    filteredLines[filteredLines.length - 1].trim() === ''
  ) {
    filteredLines.pop();
  }
  // Ensure file ends with a single newline
  modified = filteredLines.join('\n') + '\n';

  const claimRefs = entries.filter((e) => e.type === 'claim').length;
  const citations = entries.filter((e) => e.type === 'citation').length;

  // 6. Apply changes if requested
  if (apply) {
    // Write modified MDX
    writeFileSync(filePath, modified, 'utf-8');

    // Create DB entries for claim references
    for (const entry of entries) {
      if (entry.type === 'claim' && entry.claimId) {
        const insert: ClaimPageReferenceInsert = {
          claimId: entry.claimId,
          pageId,
          footnote: entry.footnoteNumber,
          quoteText: entry.quoteRow?.claimText ?? null,
          referenceId: entry.referenceId,
        };
        const result = await createClaimReference(insert);
        if (!result.ok) {
          console.error(
            `  Warning: failed to create claim ref ${entry.referenceId}: ${result.error}`,
          );
        }
      }
    }

    // Create DB entries for regular citations (batch)
    const citationInserts: PageCitationInsert[] = entries
      .filter((e) => e.type === 'citation')
      .map((entry) => ({
        referenceId: entry.referenceId,
        pageId,
        title: entry.footnote.title ?? undefined,
        url: entry.footnote.url ?? undefined,
        note: entry.footnote.rawText,
        resourceId: entry.quoteRow?.resourceId ?? undefined,
      }));

    if (citationInserts.length > 0) {
      // Batch in groups of 200 (API limit)
      for (let i = 0; i < citationInserts.length; i += 200) {
        const batch = citationInserts.slice(i, i + 200);
        const result = await createCitationsBatch(batch);
        if (!result.ok) {
          console.error(
            `  Warning: failed to create citation batch: ${result.error}`,
          );
        }
      }
    }
  }

  return {
    pageId,
    totalFootnotes: footnotes.length,
    claimRefs,
    citations,
    entries,
    modifiedContent: modified,
    applied: apply,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];
  const apply = args.apply === true;

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux claims migrate-footnotes <page-id>`);
    console.error(`  Usage: pnpm crux claims migrate-footnotes <page-id> --apply`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(
      `${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`,
    );
    process.exit(1);
  }

  console.log(
    `\n${c.bold}${c.blue}Footnote Migration: ${pageId}${c.reset}${apply ? '' : ` ${c.dim}(dry-run)${c.reset}`}\n`,
  );

  try {
    const result = await migratePageFootnotes(pageId, { apply });

    if (result.totalFootnotes === 0) {
      console.log(`${c.yellow}No footnotes found in ${pageId}${c.reset}`);
      return;
    }

    // Print summary
    console.log(`  Total footnotes:    ${c.bold}${result.totalFootnotes}${c.reset}`);
    console.log(
      `  Claim-backed refs:  ${c.green}${result.claimRefs}${c.reset} (have linked claim in citation_quotes)`,
    );
    console.log(
      `  Regular citations:  ${c.cyan}${result.citations}${c.reset} (no claim link)`,
    );

    // Detail table
    console.log(`\n${c.bold}Migration Plan:${c.reset}\n`);
    console.log(
      `  ${'#'.padStart(3)}  ${'RefId'.padEnd(10)}  ${'Type'.padEnd(9)}  ${'ClaimId'.padEnd(8)}  Source`,
    );
    console.log(`  ${'─'.repeat(3)}  ${'─'.repeat(10)}  ${'─'.repeat(9)}  ${'─'.repeat(8)}  ${'─'.repeat(40)}`);

    for (const entry of result.entries) {
      const num = String(entry.footnoteNumber).padStart(3);
      const refId = entry.referenceId.padEnd(10);
      const type = entry.type === 'claim'
        ? `${c.green}claim${c.reset}    `
        : `${c.cyan}citation${c.reset} `;
      const claimId = entry.claimId
        ? String(entry.claimId).padEnd(8)
        : `${c.dim}—${c.reset}`.padEnd(8 + c.dim.length + c.reset.length);
      const source = entry.footnote.url
        ? truncate(entry.footnote.url, 60)
        : truncate(entry.footnote.rawText, 60);
      console.log(`  ${num}  ${refId}  ${type}  ${claimId}  ${c.dim}${source}${c.reset}`);
    }

    // Show sample of modified content
    if (!apply) {
      console.log(`\n${c.yellow}Dry run — no changes written.${c.reset}`);
      console.log(`Run with ${c.bold}--apply${c.reset} to write changes.\n`);

      // Show a snippet of what the modified MDX would look like
      if (result.modifiedContent) {
        // Find first line that contains a reference
        const refLine = result.modifiedContent
          .split('\n')
          .find((line) => /\[\^(cr|rc)-[a-f0-9]+\]/.test(line));
        if (refLine) {
          console.log(`${c.dim}Sample transformed line:${c.reset}`);
          console.log(`  ${truncate(refLine.trim(), 120)}\n`);
        }
      }
    } else {
      console.log(`\n${c.green}Applied!${c.reset}`);
      console.log(`  MDX file updated with new reference IDs`);
      console.log(`  ${result.claimRefs} claim_page_references created`);
      console.log(`  ${result.citations} page_citations created\n`);
    }
  } catch (err) {
    console.error(`${c.red}Migration failed:${c.reset}`, err);
    process.exit(1);
  }
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + '...' : s;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Footnote migration failed:', err);
    process.exit(1);
  });
}
