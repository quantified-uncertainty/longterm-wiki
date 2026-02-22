/**
 * Citation Verification Script
 *
 * Fetches and verifies all citation URLs for a wiki page (or all pages).
 * Downloads each cited URL, extracts title + content snippet, and stores
 * the results in data/citation-archive/<page-id>.yaml.
 *
 * Usage:
 *   pnpm crux citations verify <page-id>                    Verify one page
 *   pnpm crux citations verify <page-id> --content-verify   Also check claim support
 *   pnpm crux citations verify --all                        Verify all pages with citations
 *   pnpm crux citations verify --all --limit=50             Verify up to 50 pages
 *
 * Part of the hallucination risk reduction initiative (issue #200).
 */

import { readFileSync } from 'fs';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';
import {
  verifyCitationsForPage,
  extractCitationsFromContent,
  readCitationArchive,
  type CitationArchiveFile,
} from '../lib/citation-archive.ts';
import { fetchAndVerifyClaim } from '../lib/source-fetcher.ts';
import { findPagesWithCitations } from './shared.ts';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const ci = args.ci === true;
  const json = args.json === true;
  const all = args.all === true;
  const limit = parseInt((args.limit as string) || '0', 10);
  const recheck = args.recheck === true;
  const contentVerify = args['content-verify'] === true;
  const colors = getColors(ci || json);
  const c = colors;

  // Get page ID from positional args
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!all && !pageId) {
    console.error(`${c.red}Error: provide a page ID or use --all${c.reset}`);
    console.error(`  Usage: pnpm crux citations verify <page-id>`);
    console.error(`         pnpm crux citations verify --all [--limit=50]`);
    process.exit(1);
  }

  if (all) {
    // Verify all pages with citations
    let pages = findPagesWithCitations();
    console.log(`\n${c.bold}${c.blue}Citation Verification — All Pages${c.reset}\n`);
    console.log(`  Found ${pages.length} pages with citations\n`);

    // Skip already-verified pages unless --recheck
    if (!recheck) {
      pages = pages.filter(p => {
        const existing = readCitationArchive(p.pageId);
        return !existing;
      });
      console.log(`  ${pages.length} pages need verification (use --recheck to re-verify all)\n`);
    }

    if (limit > 0) {
      pages = pages.slice(0, limit);
      console.log(`  Processing first ${pages.length} pages (--limit=${limit})\n`);
    }

    const allResults: CitationArchiveFile[] = [];

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      console.log(`${c.dim}[${i + 1}/${pages.length}]${c.reset} ${c.bold}${page.pageId}${c.reset} (${page.citationCount} citations)`);

      try {
        const raw = readFileSync(page.path, 'utf-8');
        const body = stripFrontmatter(raw);
        const archive = await verifyCitationsForPage(page.pageId, body, { verbose: true });
        allResults.push(archive);

        const brokenCount = archive.broken;
        if (brokenCount > 0) {
          console.log(`  ${c.red}${brokenCount} broken citation(s)${c.reset}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${c.red}Error: ${msg}${c.reset}`);
      }

      console.log('');
    }

    // Summary
    const totalCitations = allResults.reduce((s, a) => s + a.totalCitations, 0);
    const totalVerified = allResults.reduce((s, a) => s + a.verified, 0);
    const totalBroken = allResults.reduce((s, a) => s + a.broken, 0);
    const totalUnverifiable = allResults.reduce((s, a) => s + a.unverifiable, 0);

    if (json || ci) {
      console.log(JSON.stringify({
        pagesProcessed: allResults.length,
        totalCitations,
        verified: totalVerified,
        broken: totalBroken,
        unverifiable: totalUnverifiable,
        brokenPages: allResults.filter(a => a.broken > 0).map(a => ({
          pageId: a.pageId,
          broken: a.broken,
          brokenUrls: a.citations.filter(c => c.status === 'broken').map(c => c.url),
        })),
      }, null, 2));
    } else {
      console.log(`${c.bold}${c.blue}Summary${c.reset}`);
      console.log(`  Pages processed:   ${allResults.length}`);
      console.log(`  Total citations:   ${totalCitations}`);
      console.log(`  ${c.green}Verified:${c.reset}          ${totalVerified}`);
      console.log(`  ${c.red}Broken:${c.reset}            ${totalBroken}`);
      console.log(`  ${c.yellow}Unverifiable:${c.reset}      ${totalUnverifiable}`);

      if (totalBroken > 0) {
        console.log(`\n${c.red}${c.bold}Broken citations found!${c.reset} Review with:`);
        console.log(`  pnpm crux citations report --broken`);
      }
    }

    process.exit(totalBroken > 0 ? 1 : 0);
  }

  // Single page verification
  const filePath = findPageFile(pageId);
  if (!filePath) {
    console.error(`${c.red}Error: page "${pageId}" not found${c.reset}`);
    process.exit(1);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const body = stripFrontmatter(raw);
  const citations = extractCitationsFromContent(body);

  if (citations.length === 0) {
    if (json || ci) {
      console.log(JSON.stringify({
        pageId,
        totalCitations: 0,
        verified: 0,
        broken: 0,
        unverifiable: 0,
        citations: [],
      }, null, 2));
    } else {
      console.log(`${c.dim}No citations found in ${pageId}${c.reset}`);
    }
    process.exit(0);
  }

  // In JSON/CI mode, skip human-readable output and disable verbose progress
  if (json || ci) {
    const archive = await verifyCitationsForPage(pageId, body, { verbose: false });
    console.log(JSON.stringify(archive, null, 2));
    process.exit(archive.broken > 0 ? 1 : 0);
  }

  console.log(`\n${c.bold}${c.blue}Citation Verification: ${pageId}${c.reset}`);
  console.log(`  ${citations.length} citations to verify\n`);

  const archive = await verifyCitationsForPage(pageId, body, { verbose: true });

  // Display results
  console.log(`\n${c.bold}Results:${c.reset}`);
  console.log(`  ${c.green}Verified:${c.reset}      ${archive.verified}`);
  console.log(`  ${c.red}Broken:${c.reset}        ${archive.broken}`);
  console.log(`  ${c.yellow}Unverifiable:${c.reset}  ${archive.unverifiable}`);

  // Show broken citations in detail
  const broken = archive.citations.filter(cit => cit.status === 'broken');
  if (broken.length > 0) {
    console.log(`\n${c.red}${c.bold}Broken Citations:${c.reset}`);
    for (const b of broken) {
      console.log(`  [^${b.footnote}] ${b.url}`);
      console.log(`    ${c.dim}HTTP ${b.httpStatus || 'error'}: ${b.note || 'unknown error'}${c.reset}`);
      console.log(`    ${c.dim}Link text: ${b.linkText || '(none)'}${c.reset}`);
      console.log(`    ${c.dim}Context: ${b.claimContext.slice(0, 100)}...${c.reset}`);
    }
  }

  // Show verified citations with title match check
  const verified = archive.citations.filter(cit => cit.status === 'verified');
  if (verified.length > 0) {
    console.log(`\n${c.green}${c.bold}Verified Citations:${c.reset}`);
    for (const v of verified) {
      const titleMatch = v.linkText && v.pageTitle &&
        (v.pageTitle.toLowerCase().includes(v.linkText.toLowerCase().slice(0, 20)) ||
         v.linkText.toLowerCase().includes(v.pageTitle.toLowerCase().slice(0, 20)));

      const matchIcon = titleMatch ? `${c.green}✓${c.reset}` : `${c.yellow}?${c.reset}`;
      console.log(`  [^${v.footnote}] ${matchIcon} ${v.url.slice(0, 70)}`);
      console.log(`    ${c.dim}Link text:  "${v.linkText}"${c.reset}`);
      console.log(`    ${c.dim}Page title: "${v.pageTitle || '(none)'}"${c.reset}`);
      if (!titleMatch && v.pageTitle) {
        console.log(`    ${c.yellow}Title mismatch — verify manually${c.reset}`);
      }
    }
  }

  console.log(`\n${c.dim}Archive saved to data/citation-archive/${pageId}.yaml${c.reset}\n`);

  // Optional content verification: check if source actually supports each claim
  if (contentVerify && verified.length > 0) {
    console.log(`\n${c.bold}${c.blue}Content Verification (--content-verify):${c.reset}`);
    console.log(`  Fetching source content and checking claim support...\n`);

    let supported = 0;
    let unsupported = 0;
    let unreachable = 0;

    for (const v of verified) {
      process.stdout.write(`  [^${v.footnote}] ${v.url.slice(0, 60)}...`);
      const { source, hasSupport } = await fetchAndVerifyClaim(v.url, v.claimContext);

      if (source.status === 'ok' && hasSupport) {
        console.log(` ${c.green}✓ supported${c.reset}`);
        if (source.relevantExcerpts.length > 0) {
          console.log(`    ${c.dim}Excerpt: "${source.relevantExcerpts[0].slice(0, 120)}..."${c.reset}`);
        }
        supported++;
      } else if (source.status === 'ok' && !hasSupport) {
        console.log(` ${c.yellow}? no match${c.reset}`);
        console.log(`    ${c.dim}Content fetched but no relevant excerpts found for claim context${c.reset}`);
        unsupported++;
      } else if (source.status === 'paywall') {
        console.log(` ${c.yellow}⊘ paywall${c.reset}`);
        unreachable++;
      } else {
        console.log(` ${c.red}✗ ${source.status}${c.reset}`);
        unreachable++;
      }
    }

    console.log(`\n  ${c.green}Supported:${c.reset}   ${supported}`);
    console.log(`  ${c.yellow}No match:${c.reset}    ${unsupported}`);
    console.log(`  ${c.dim}Unreachable:${c.reset} ${unreachable}`);

    if (unsupported > 0) {
      console.log(`\n  ${c.yellow}${c.bold}${unsupported} citation(s) may not directly support their claim.${c.reset}`);
      console.log(`  Run ${c.dim}pnpm crux citations check-accuracy ${pageId}${c.reset} for a deeper LLM-based analysis.`);
    }
  }

  process.exit(archive.broken > 0 ? 1 : 0);
}

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
