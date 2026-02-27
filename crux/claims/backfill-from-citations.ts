/**
 * Backfill claims from citation_quotes data.
 *
 * Groups citation_quotes by text similarity, creates claims for each group,
 * links the citations to the claims via claim_id FK, and creates
 * claim_page_references for cross-page visibility.
 *
 * Usage:
 *   pnpm crux claims backfill-from-citations
 *   pnpm crux claims backfill-from-citations --dry-run
 *   pnpm crux claims backfill-from-citations --page-id=kalshi
 *   pnpm crux claims backfill-from-citations --limit=500
 */

import { fileURLToPath } from 'url';
import { parseCliArgs, parseIntOpt } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { apiRequest, isServerAvailable, BATCH_TIMEOUT_MS } from '../lib/wiki-server/client.ts';
import {
  insertClaim,
  getClaimsByEntity,
  addClaimPageReferencesBatch,
} from '../lib/wiki-server/claims.ts';
import { linkCitationsToClaimsBatch } from '../lib/wiki-server/citations.ts';
import { isClaimDuplicate, claimTypeToCategory, type ClaimTypeValue } from '../lib/claim-utils.ts';
import type { ClaimVerdict } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CitationQuote {
  id: number;
  pageId: string;
  footnote: number;
  url: string | null;
  resourceId: string | null;
  claimText: string;
  claimContext: string | null;
  sourceQuote: string | null;
  accuracyVerdict: string | null;
  accuracyScore: number | null;
  claimId: number | null;
  // Fields for claim_sources metadata (migration 0037)
  sourceTitle: string | null;
  sourceType: string | null;
  sourceLocation: string | null;
  // Fields for claim verdict enrichment
  accuracyIssues: string | null;
  accuracySupportingQuotes: string | null;
  verificationDifficulty: string | null;
}

interface QuotesAllResponse {
  quotes: CitationQuote[];
  total: number;
}

interface QuotesByPageResponse {
  quotes: CitationQuote[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Heuristic claim type detection from claim text.
 *
 * Tries to detect numeric, evaluative, causal, historical, and relational
 * claims based on surface patterns. Falls back to 'factual' when no pattern
 * matches. This replaces the previous blanket 'factual' default.
 */
function detectClaimType(text: string): ClaimTypeValue {
  const lower = text.toLowerCase();

  // Numeric: contains numbers with units, percentages, dollar amounts, or quantities
  if (/\$[\d,.]+|\d+%|\d[\d,.]*\s*(billion|million|thousand|trillion|percent|employees|users|people|dollars|usd|eur|gbp)/i.test(text)) {
    return 'numeric';
  }

  // Evaluative: subjective assessments, rankings, opinions
  if (/\b(best|worst|leading|top|most important|considered|regarded|viewed as|believed to|arguably|widely seen)\b/i.test(lower)) {
    return 'evaluative';
  }

  // Causal: cause-effect relationships
  if (/\b(caused|led to|resulted in|because|due to|as a result|contribut(ed|es|ing) to|impact(ed|s|ing) on)\b/i.test(lower)) {
    return 'causal';
  }

  // Historical: past events with dates or temporal markers
  if (/\b(in \d{4}|was founded|established|launched|published|released|announced|merged|acquired)\b/i.test(lower)) {
    return 'historical';
  }

  // Relational: relationships between entities
  if (/\b(partner(ed|ship)|collaborat|subsidiary|acquired by|funded by|member of|affiliated with|part of)\b/i.test(lower)) {
    return 'relational';
  }

  return 'factual';
}

/**
 * Map an accuracy verdict from citation_quotes to a claim verdict.
 */
function mapAccuracyToClaimVerdict(
  accuracyVerdict: string | null,
): ClaimVerdict | undefined {
  if (!accuracyVerdict) return undefined;
  switch (accuracyVerdict) {
    case 'accurate':        return 'verified';
    case 'inaccurate':      return 'disputed';
    case 'unsupported':     return 'unsupported';
    case 'minor_issues':    return 'verified'; // minor issues still count as verified
    case 'not_verifiable':  return 'unverified';
    default:                return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const pageIdFilter = typeof args['page-id'] === 'string' ? args['page-id'] : null;
  const limit = parseIntOpt(args.limit, 1000);
  const c = getColors(false);

  console.log(`\n${c.bold}${c.blue}Backfill claims from citation_quotes${c.reset}`);
  if (dryRun) console.log(`  ${c.yellow}[DRY RUN — no changes will be made]${c.reset}\n`);

  // Check server availability (unless dry-run)
  if (!dryRun) {
    const serverAvailable = await isServerAvailable();
    if (!serverAvailable) {
      console.error(`${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`);
      console.error(`  Use --dry-run to preview without storing.`);
      process.exit(1);
    }
  }

  // Step 1: Fetch citation quotes
  let allQuotes: CitationQuote[];

  if (pageIdFilter) {
    const url = `/api/citations/quotes?page_id=${encodeURIComponent(pageIdFilter)}&limit=${limit}`;
    const result = await apiRequest<QuotesByPageResponse>('GET', url, undefined, BATCH_TIMEOUT_MS);
    if (!result.ok) {
      console.error(`${c.red}Failed to fetch citation quotes: ${result.message}${c.reset}`);
      process.exit(1);
    }
    allQuotes = result.data.quotes;
  } else {
    const url = `/api/citations/quotes/all?limit=${limit}&offset=0`;
    const result = await apiRequest<QuotesAllResponse>('GET', url, undefined, BATCH_TIMEOUT_MS);
    if (!result.ok) {
      console.error(`${c.red}Failed to fetch citation quotes: ${result.message}${c.reset}`);
      process.exit(1);
    }
    allQuotes = result.data.quotes;
  }

  // Filter out already-linked quotes and those without claim text
  const unlinkedQuotes = allQuotes.filter(
    (q) => q.claimId == null && q.claimText && q.claimText.trim().length > 10,
  );

  console.log(`  Fetched ${allQuotes.length} quotes, ${c.bold}${unlinkedQuotes.length}${c.reset} unlinked`);

  if (unlinkedQuotes.length === 0) {
    console.log(`  ${c.green}Nothing to backfill — all quotes already linked.${c.reset}\n`);
    return;
  }

  // Step 2: Group quotes by page
  const byPage = new Map<string, CitationQuote[]>();
  for (const q of unlinkedQuotes) {
    if (!byPage.has(q.pageId)) byPage.set(q.pageId, []);
    byPage.get(q.pageId)!.push(q);
  }

  console.log(`  ${byPage.size} pages with unlinked quotes\n`);

  let totalClaimsCreated = 0;
  let totalLinked = 0;
  let totalPageRefs = 0;
  let totalSkippedDups = 0;
  let totalSkippedNoEntity = 0;
  let pagesProcessed = 0;

  // Step 3: Process each page
  for (const [pageId, quotes] of byPage) {
    console.log(`  ${c.blue}${pageId}${c.reset} — ${quotes.length} quotes`);
    pagesProcessed++;

    // Get existing claims for this entity to avoid duplicates.
    // If the entity has no claims table entry at all (404/error), skip this page —
    // the entityId might not exist in the entities table yet.
    const existingResult = await getClaimsByEntity(pageId);
    let existingTexts: string[] = [];

    if (!existingResult.ok) {
      // A bad_request (404) typically means no entity row — skip gracefully.
      // Other errors (unavailable, timeout) are transient — also skip with warning.
      if (existingResult.error === 'bad_request') {
        console.log(`    ${c.dim}  Skipping — entity not found in DB (${pageId})${c.reset}`);
        totalSkippedNoEntity += quotes.length;
        continue;
      }
      // For other errors just warn and continue with empty existing texts
      console.warn(`    ${c.yellow}  Warning: could not fetch existing claims (${existingResult.message}), proceeding cautiously${c.reset}`);
    } else {
      existingTexts = existingResult.data.claims.map((cl) => cl.claimText);
    }

    // Step 4: Group quotes within this page by text similarity
    const groups: CitationQuote[][] = [];
    const assigned = new Set<number>();

    for (const q of quotes) {
      if (assigned.has(q.id)) continue;

      const group: CitationQuote[] = [q];
      assigned.add(q.id);

      for (const other of quotes) {
        if (assigned.has(other.id)) continue;
        if (isClaimDuplicate(q.claimText, other.claimText, 0.6)) {
          group.push(other);
          assigned.add(other.id);
        }
      }
      groups.push(group);
    }

    console.log(`    Grouped into ${groups.length} claim group(s)`);

    // Step 5: For each group, create a claim (unless duplicate of existing)
    for (const group of groups) {
      // Pick the longest/most representative quote as the claim text
      const representative = group.reduce((best, q) =>
        q.claimText.length > best.claimText.length ? q : best,
      );

      // Check for duplicate against existing claims
      const isDup = existingTexts.some((t) =>
        isClaimDuplicate(representative.claimText, t, 0.7),
      );
      if (isDup) {
        console.log(`    ${c.dim}  Skipping dup: "${representative.claimText.slice(0, 60)}..."${c.reset}`);
        totalSkippedDups++;
        continue;
      }

      if (dryRun) {
        const refs = group.map((q) => q.footnote).join(', ');
        console.log(`    ${c.green}  + Would create: "${representative.claimText.slice(0, 75)}..." (${group.length} quotes, footnotes: ${refs})${c.reset}`);
        totalClaimsCreated++;
        totalLinked += group.length;
        totalPageRefs += new Set(group.map((q) => `${q.pageId}:${q.footnote}`)).size;
        // Add to local existingTexts so later groups in this page are checked against it
        existingTexts.push(representative.claimText);
        continue;
      }

      // Create the claim
      const claimVerdict = mapAccuracyToClaimVerdict(representative.accuracyVerdict);
      const detectedType = detectClaimType(representative.claimText);
      const claimResult = await insertClaim({
        entityId: pageId,
        entityType: 'wiki-page',
        claimType: detectedType,
        claimCategory: claimTypeToCategory(detectedType),
        claimText: representative.claimText,
        sourceQuote: representative.sourceQuote ?? null,
        section: representative.claimContext ?? null,
        footnoteRefs: group.map((q) => String(q.footnote)).join(','),
        // Map accuracy verdict to claim verdict if available
        ...(claimVerdict ? { claimVerdict } : {}),
        ...(representative.accuracyScore != null
          ? { claimVerdictScore: representative.accuracyScore }
          : {}),
        // Carry over verdict detail fields from citation_quotes
        ...(representative.accuracyIssues
          ? { claimVerdictIssues: representative.accuracyIssues }
          : {}),
        ...(representative.accuracySupportingQuotes
          ? { claimVerdictQuotes: representative.accuracySupportingQuotes }
          : {}),
        ...(representative.verificationDifficulty && ['easy', 'moderate', 'hard'].includes(representative.verificationDifficulty)
          ? { claimVerdictDifficulty: representative.verificationDifficulty as 'easy' | 'moderate' | 'hard' }
          : {}),
        // Inline source if a URL or resourceId is available
        ...(representative.url || representative.resourceId
          ? {
              sources: [{
                url: representative.url ?? null,
                resourceId: representative.resourceId ?? null,
                sourceQuote: representative.sourceQuote ?? null,
                isPrimary: true,
                sourceTitle: representative.sourceTitle ?? null,
                sourceType: representative.sourceType ?? null,
                sourceLocation: representative.sourceLocation ?? null,
              }],
            }
          : {}),
      });

      if (!claimResult.ok) {
        console.error(`    ${c.red}  Failed to create claim: ${claimResult.message}${c.reset}`);
        continue;
      }

      const claimId = claimResult.data.id;
      totalClaimsCreated++;
      console.log(`    ${c.green}  Created claim #${claimId}: "${representative.claimText.slice(0, 60)}..."${c.reset}`);

      // Add the new text to existingTexts so later groups are deduplicated against it
      existingTexts.push(representative.claimText);

      // Step 6: Link citation quotes to the claim via claim_id FK
      const linkItems = group.map((q) => ({ quoteId: q.id, claimId }));
      const linkResult = await linkCitationsToClaimsBatch(linkItems);
      if (linkResult.ok) {
        totalLinked += linkResult.data.linked;
      } else {
        console.warn(`    ${c.yellow}  Warning: link-citations failed: ${linkResult.message}${c.reset}`);
      }

      // Step 7: Create claim_page_references for each quote (deduplicated by pageId+footnote)
      const uniqueRefs = new Map<string, { pageId: string; footnote: number; section: string | null }>();
      for (const q of group) {
        const key = `${q.pageId}:${q.footnote}`;
        if (!uniqueRefs.has(key)) {
          uniqueRefs.set(key, {
            pageId: q.pageId,
            footnote: q.footnote,
            section: q.claimContext ?? null,
          });
        }
      }
      const refsArray = [...uniqueRefs.values()];

      const refsResult = await addClaimPageReferencesBatch(claimId, refsArray);
      if (refsResult.ok) {
        totalPageRefs += refsResult.data.inserted;
      } else {
        console.warn(`    ${c.yellow}  Warning: page-refs batch failed: ${refsResult.message}${c.reset}`);
      }
    }
  }

  // Summary
  console.log(`\n${c.bold}Summary:${c.reset}`);
  console.log(`  Pages processed:        ${pagesProcessed}`);
  console.log(`  Claims created:         ${c.green}${totalClaimsCreated}${c.reset}`);
  console.log(`  Citations linked:       ${c.green}${totalLinked}${c.reset}`);
  console.log(`  Page references added:  ${c.green}${totalPageRefs}${c.reset}`);
  if (totalSkippedDups > 0) {
    console.log(`  Duplicate groups skipped: ${c.dim}${totalSkippedDups}${c.reset}`);
  }
  if (totalSkippedNoEntity > 0) {
    console.log(`  Quotes skipped (no entity): ${c.dim}${totalSkippedNoEntity}${c.reset}`);
  }
  if (dryRun) {
    console.log(`\n  ${c.yellow}[DRY RUN — no actual changes made. Remove --dry-run to apply.]${c.reset}`);
  }
  console.log('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
