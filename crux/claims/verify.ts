/**
 * Claims Verify — verify extracted claims against citation_content full text
 *
 * Reads claims stored in PG for a page, looks up source text from SQLite
 * (local, fast) then PG (cross-machine), and verifies each claim using an LLM.
 * Updates the stored claims with verification results (confidence field).
 *
 * Usage:
 *   pnpm crux claims verify <page-id>
 *   pnpm crux claims verify <page-id> --model=google/gemini-2.0-flash-001
 *   pnpm crux claims verify <page-id> --dry-run   # report only, no DB writes
 *
 * Requires: OPENROUTER_API_KEY or ANTHROPIC_API_KEY
 * Optional: LONGTERMWIKI_SERVER_URL (for PG fallback when SQLite is empty)
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { callOpenRouter, stripCodeFences, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { citationContent } from '../lib/knowledge-db.ts';
import { getCitationContentByUrl } from '../lib/wiki-server/citations.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  getClaimsByEntity,
  clearClaimsForEntity,
  insertClaimBatch,
  type ClaimRow,
  type InsertClaimItem,
} from '../lib/wiki-server/claims.ts';
import { extractCitationsFromContent } from '../lib/citation-archive.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { getResourceById } from '../lib/resource-lookup.ts';
import { readFileSync } from 'fs';

const MIN_SOURCE_LENGTH = 100;
const MAX_SOURCE_CHARS = 80_000;

// ---------------------------------------------------------------------------
// Source resolution — SQLite first, then PG (no network calls)
// ---------------------------------------------------------------------------

async function getSourceText(url: string): Promise<string | null> {
  // Tier 1: SQLite local cache (fast, no network)
  try {
    const row = citationContent.getByUrl(url);
    if (row?.full_text && row.full_text.length > MIN_SOURCE_LENGTH) {
      return row.full_text.slice(0, MAX_SOURCE_CHARS);
    }
  } catch {
    // SQLite unavailable
  }

  // Tier 2: PostgreSQL cache (cross-machine)
  try {
    const result = await getCitationContentByUrl(url);
    if (result.ok && result.data.fullText && result.data.fullText.length > MIN_SOURCE_LENGTH) {
      return result.data.fullText.slice(0, MAX_SOURCE_CHARS);
    }
  } catch {
    // PG unavailable
  }

  return null;
}

// ---------------------------------------------------------------------------
// URL lookup from citation archive for a page
// ---------------------------------------------------------------------------

/**
 * Build a map of citation ref → URL from the page MDX.
 * Handles both [^N] footnote references and <R id="HASH"> resource references.
 */
function buildCitationUrlMap(pageId: string): Map<string, string> {
  const map = new Map<string, string>();
  const filePath = findPageFile(pageId);
  if (!filePath) return map;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const body = stripFrontmatter(raw);

    // Standard [^N] footnotes
    const citations = extractCitationsFromContent(body);
    for (const cit of citations) {
      map.set(String(cit.footnote), cit.url);
    }

    // <R id="HASH"> resource references → mapped as "R:HASH"
    const rPattern = /<R\s+id="([^"]+)">/g;
    let match;
    while ((match = rPattern.exec(raw)) !== null) {
      const resourceId = match[1];
      if (map.has(`R:${resourceId}`)) continue;
      const resource = getResourceById(resourceId);
      if (resource?.url) {
        map.set(`R:${resourceId}`, resource.url);
      }
    }
  } catch {
    // Page not found or parse error — return empty map
  }

  return map;
}

// ---------------------------------------------------------------------------
// LLM claim verification
// ---------------------------------------------------------------------------

type VerificationResult = 'verified' | 'unsupported' | 'unsourced';

const VERIFY_SYSTEM_PROMPT = `You are a fact-checking assistant. Given a claim from a wiki article and the full text of its cited source, determine whether the source supports the claim.

Verdicts:
- "verified": the source clearly and directly supports the claim
- "unsupported": the source does not contain relevant information to support this claim

Rules:
- Be strict: specific numbers, dates, and names must match exactly
- Return "unsupported" only if you've checked the full source
- Keep the explanation concise (1-2 sentences)

Respond ONLY with JSON:
{"verdict": "verified", "relevantQuote": "exact text from source", "explanation": "reason"}`;

async function verifyClaim(
  claimText: string,
  sourceText: string,
  opts: { model?: string } = {},
): Promise<{ verdict: VerificationResult; quote: string; explanation: string }> {
  const truncated = sourceText.slice(0, MAX_SOURCE_CHARS);
  const userPrompt = `CLAIM: ${claimText}\n\nSOURCE TEXT:\n${truncated}\n\nReturn JSON only.`;

  try {
    const raw = await callOpenRouter(VERIFY_SYSTEM_PROMPT, userPrompt, {
      model: opts.model ?? DEFAULT_CITATION_MODEL,
      maxTokens: 400,
      title: 'LongtermWiki Claim Verification',
    });

    const json = stripCodeFences(raw);
    const parsed = JSON.parse(json) as { verdict?: string; relevantQuote?: string; explanation?: string };
    const verdict = parsed.verdict === 'verified' ? 'verified' : 'unsupported';

    return {
      verdict,
      quote: typeof parsed.relevantQuote === 'string' ? parsed.relevantQuote : '',
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
    };
  } catch {
    return { verdict: 'unsupported', quote: '', explanation: 'Failed to parse verification response.' };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const model = typeof args.model === 'string' ? args.model : undefined;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux claims verify <page-id>`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`);
    process.exit(1);
  }

  // Fetch stored claims
  const claimsResult = await getClaimsByEntity(pageId);
  if (!claimsResult.ok) {
    console.error(`${c.red}Could not fetch claims for ${pageId}. Run extract first.${c.reset}`);
    console.error(`  pnpm crux claims extract ${pageId}`);
    process.exit(1);
  }

  const claims = claimsResult.data.claims;
  if (claims.length === 0) {
    console.log(`${c.yellow}No claims found for ${pageId}. Run extract first.${c.reset}`);
    console.log(`  pnpm crux claims extract ${pageId}`);
    process.exit(0);
  }

  console.log(`\n${c.bold}${c.blue}Claims Verify: ${pageId}${c.reset}\n`);
  console.log(`  Claims to verify: ${claims.length}`);
  if (dryRun) {
    console.log(`  ${c.yellow}DRY RUN — results not stored${c.reset}`);
  }
  console.log('');

  // Build footnote → URL map from the page
  const footnoteUrlMap = buildCitationUrlMap(pageId);
  console.log(`  Citation URLs mapped: ${footnoteUrlMap.size}`);

  // Verify each claim
  const updatedClaims: Array<ClaimRow & { newConfidence: string; newSourceQuote: string }> = [];

  let verified = 0;
  let unsupported = 0;
  let unsourced = 0;
  let noSource = 0;

  for (const claim of claims) {
    const footnoteRefs = claim.unit ? claim.unit.split(',').map(s => s.trim()) : [];

    // If no footnote refs, mark as unsourced
    if (footnoteRefs.length === 0) {
      unsourced++;
      updatedClaims.push({ ...claim, newConfidence: 'unsourced', newSourceQuote: '' });
      process.stdout.write(`  ${c.yellow}○${c.reset} [unsourced] ${claim.claimText.slice(0, 60)}...\n`);
      continue;
    }

    // Find source text for the first available footnote ref
    let sourceText: string | null = null;
    let sourceUrl = '';
    for (const ref of footnoteRefs) {
      const url = footnoteUrlMap.get(ref);
      if (url) {
        sourceText = await getSourceText(url);
        if (sourceText) { sourceUrl = url; break; }
      }
    }

    if (!sourceText) {
      noSource++;
      updatedClaims.push({ ...claim, newConfidence: 'unverified', newSourceQuote: '' });
      process.stdout.write(`  ${c.dim}? [no-source] ${claim.claimText.slice(0, 60)}...\n`);
      continue;
    }

    // Verify with LLM
    const result = await verifyClaim(claim.claimText, sourceText, { model });

    if (result.verdict === 'verified') {
      verified++;
      updatedClaims.push({ ...claim, newConfidence: 'verified', newSourceQuote: result.quote });
      process.stdout.write(`  ${c.green}✓${c.reset} [verified] ${claim.claimText.slice(0, 60)}...\n`);
    } else {
      unsupported++;
      updatedClaims.push({ ...claim, newConfidence: 'unverified', newSourceQuote: '' });
      process.stdout.write(`  ${c.red}✗${c.reset} [unsupported] ${claim.claimText.slice(0, 60)}...\n`);
    }
  }

  console.log(`\n${c.bold}Verification Summary:${c.reset}`);
  console.log(`  ${c.green}Verified:${c.reset}    ${verified}`);
  console.log(`  ${c.red}Unsupported:${c.reset} ${unsupported}`);
  console.log(`  ${c.yellow}Unsourced:${c.reset}   ${unsourced}`);
  console.log(`  ${c.dim}No source:${c.reset}   ${noSource}`);

  if (dryRun) {
    console.log(`\n${c.green}Dry run complete. Remove --dry-run to store results.${c.reset}\n`);
    return;
  }

  // Store updated claims: clear + re-insert with updated confidence
  console.log(`\n  Storing updated claims...`);

  const cleared = await clearClaimsForEntity(pageId);
  if (!cleared.ok) {
    console.error(`${c.red}Failed to clear existing claims${c.reset}`);
    process.exit(1);
  }

  const BATCH_SIZE = 50;
  let inserted = 0;

  for (let i = 0; i < updatedClaims.length; i += BATCH_SIZE) {
    const batch = updatedClaims.slice(i, i + BATCH_SIZE);
    const items: InsertClaimItem[] = batch.map(claim => ({
      entityId: claim.entityId,
      entityType: claim.entityType,
      claimType: claim.claimType,
      claimText: claim.claimText,
      value: claim.value,
      unit: claim.unit,
      confidence: claim.newConfidence,
      sourceQuote: claim.newSourceQuote || null,
    }));

    const result = await insertClaimBatch(items);
    if (result.ok) inserted += result.data.inserted;
  }

  console.log(`  ${c.green}Updated ${inserted} claims${c.reset}`);
  console.log(`\n  Run 'pnpm crux claims status ${pageId}' to see the full breakdown.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Claims verify failed:', err);
    process.exit(1);
  });
}
