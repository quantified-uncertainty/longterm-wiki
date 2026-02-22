/**
 * Citation Audit Check — independent post-hoc verification CLI
 *
 * Stateless citation verification for a single wiki page. Extracts citations
 * from the page content, fetches source URLs (or uses the SQLite cache via the
 * source-fetcher module), and independently verifies each claim with a cheap
 * LLM call.
 *
 * Note: when --no-fetch is not set, fetched source content is cached in SQLite
 * (via source-fetcher) for cross-session reuse. Page content files are never
 * modified — this command only reads and reports.
 *
 * Unlike `crux citations audit` (which is a full extract→check→fix pipeline),
 * this command only verifies — it does not write fixes to any wiki page.
 *
 * Usage:
 *   pnpm crux citations audit-check <page-id>
 *   pnpm crux citations audit-check <page-id> --json
 *   pnpm crux citations audit-check <page-id> --no-fetch   # cache-only mode
 *   pnpm crux citations audit-check <page-id> --threshold=0.9
 *   pnpm crux citations audit-check <page-id> --model=google/gemini-flash-lite
 *   pnpm crux citations audit-check <page-id> --delay=500
 *
 * Requires: OPENROUTER_API_KEY
 * Optional: FIRECRAWL_KEY (improves source content extraction quality)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { auditCitations } from '../lib/citation-auditor.ts';
import type { CitationAudit } from '../lib/citation-auditor.ts';

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_DELAY_MS = 300;

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const json = args.json === true;
  const noFetch = args['no-fetch'] === true || args['no-fetch'] === 'true';
  const model = typeof args.model === 'string' ? args.model : undefined;

  // Validate threshold
  const rawThreshold = typeof args.threshold === 'string'
    ? parseFloat(args.threshold)
    : DEFAULT_THRESHOLD;
  if (isNaN(rawThreshold) || rawThreshold < 0 || rawThreshold > 1) {
    console.error(`Error: --threshold must be a number between 0 and 1 (e.g. --threshold=0.8)`);
    process.exit(1);
  }
  const threshold = rawThreshold;
  const thresholdPct = `${(threshold * 100).toFixed(0)}%`;

  // Validate delay
  const rawDelay = typeof args.delay === 'string'
    ? parseInt(args.delay, 10)
    : DEFAULT_DELAY_MS;
  const delayMs = isNaN(rawDelay) || rawDelay < 0 ? DEFAULT_DELAY_MS : rawDelay;

  const c = getColors(json);
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux citations audit-check <page-id>`);
    console.error(`         pnpm crux citations audit-check <page-id> --no-fetch`);
    console.error(`         pnpm crux citations audit-check <page-id> --threshold=0.9`);
    process.exit(1);
  }

  const filePath = findPageFile(pageId);
  if (!filePath) {
    console.error(`${c.red}Error: page "${pageId}" not found${c.reset}`);
    process.exit(1);
  }

  const content = readFileSync(filePath, 'utf-8');

  if (!json) {
    console.log(`\n${c.bold}${c.blue}Citation Audit Check: ${pageId}${c.reset}`);
    console.log(`  Mode: ${noFetch ? 'cache-only (--no-fetch)' : 'fetch missing sources'}`);
    console.log(`  Pass threshold: ${thresholdPct}\n`);
  }

  const result = await auditCitations({
    content,
    fetchMissing: !noFetch,
    passThreshold: threshold,
    model,
    delayMs,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.pass ? 0 : 1);
  }

  // ── Human-readable output ────────────────────────────────────────────────

  if (result.summary.total === 0) {
    console.log(`${c.dim}No citations found in ${pageId}${c.reset}\n`);
    process.exit(0);
  }

  // Per-citation results
  for (const cit of result.citations) {
    const icon = verdictIcon(cit.verdict, c);
    const label = verdictLabel(cit.verdict);
    console.log(`  ${icon} [^${cit.footnoteRef}] ${c.bold}${label}${c.reset}`);

    if (cit.claim) {
      const shortClaim = cit.claim.length > 100 ? cit.claim.slice(0, 100) + '…' : cit.claim;
      console.log(`    ${c.dim}Claim:${c.reset} ${shortClaim}`);
    }

    const shortUrl = cit.sourceUrl.length > 80 ? cit.sourceUrl.slice(0, 80) + '…' : cit.sourceUrl;
    console.log(`    ${c.dim}URL:${c.reset} ${shortUrl}`);

    if (cit.explanation) {
      console.log(`    ${c.dim}→${c.reset} ${cit.explanation}`);
    }

    if (cit.relevantQuote) {
      const shortQuote = cit.relevantQuote.length > 120
        ? cit.relevantQuote.slice(0, 120) + '…'
        : cit.relevantQuote;
      console.log(`    ${c.dim}Quote:${c.reset} "${shortQuote}"`);
    }

    console.log('');
  }

  // Summary
  console.log(`${c.bold}Summary${c.reset}`);
  console.log(`  Total citations:  ${result.summary.total}`);
  console.log(`  ${c.green}Verified:${c.reset}         ${result.summary.verified}`);
  if (result.summary.failed > 0) {
    console.log(`  ${c.red}Failed:${c.reset}           ${result.summary.failed}  (unsupported or misattributed)`);
  }
  if (result.summary.unchecked > 0) {
    console.log(`  ${c.dim}Unchecked:${c.reset}        ${result.summary.unchecked}  (url-dead, paywall, or no-fetch)`);
  }

  // Pass/fail verdict
  console.log('');
  if (result.pass) {
    console.log(`${c.green}${c.bold}PASS${c.reset} — citations meet the ${thresholdPct} threshold\n`);
  } else {
    const checkable = result.summary.verified + result.summary.failed;
    const pct = checkable > 0 ? (result.summary.verified / checkable * 100).toFixed(0) : '0';
    console.log(`${c.red}${c.bold}FAIL${c.reset} — ${pct}% verified (threshold: ${thresholdPct})\n`);
  }

  process.exit(result.pass ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function verdictIcon(
  verdict: CitationAudit['verdict'],
  c: ReturnType<typeof getColors>,
): string {
  switch (verdict) {
    case 'verified':      return `${c.green}✓${c.reset}`;
    case 'unsupported':   return `${c.red}✗${c.reset}`;
    case 'misattributed': return `${c.red}~${c.reset}`;
    case 'url-dead':      return `${c.red}✗${c.reset}`;
    case 'unchecked':     return `${c.dim}?${c.reset}`;
    default:              return '?';
  }
}

function verdictLabel(verdict: CitationAudit['verdict']): string {
  switch (verdict) {
    case 'verified':      return 'verified';
    case 'unsupported':   return 'unsupported';
    case 'misattributed': return 'misattributed';
    case 'url-dead':      return 'url-dead';
    case 'unchecked':     return 'unchecked';
    default:              return String(verdict);
  }
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Error:', msg);
    process.exit(1);
  });
}
