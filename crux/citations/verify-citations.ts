/**
 * Citation Verification Script
 *
 * Fetches and verifies all citation URLs for a wiki page (or all pages).
 * Downloads each cited URL, extracts title + content snippet, and stores
 * the results in data/citation-archive/<page-id>.yaml.
 *
 * Usage:
 *   pnpm crux citations verify <page-id>        Verify one page
 *   pnpm crux citations verify --all             Verify all pages with citations
 *   pnpm crux citations verify --all --limit=50  Verify up to 50 pages
 *
 * Part of the hallucination risk reduction initiative (issue #200).
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';
import {
  verifyCitationsForPage,
  extractCitationsFromContent,
  readCitationArchive,
  type CitationArchiveFile,
} from '../lib/citation-archive.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findPageFile(pageId: string): string | null {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  for (const f of files) {
    if (basename(f, '.mdx') === pageId) return f;
  }
  return null;
}

function findPagesWithCitations(): Array<{ pageId: string; path: string; citationCount: number }> {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  const results: Array<{ pageId: string; path: string; citationCount: number }> = [];

  for (const f of files) {
    // Only knowledge-base pages
    if (!f.includes('/knowledge-base/')) continue;
    if (basename(f).startsWith('index.')) continue;

    try {
      const raw = readFileSync(f, 'utf-8');
      const body = stripFrontmatter(raw);
      const citations = extractCitationsFromContent(body);
      if (citations.length > 0) {
        results.push({
          pageId: basename(f, '.mdx'),
          path: f,
          citationCount: citations.length,
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return results.sort((a, b) => b.citationCount - a.citationCount);
}

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
  const colors = getColors(ci || json);
  const c = colors;

  // Get page ID from positional args
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!all && !pageId) {
    console.log(`${c.red}Error: provide a page ID or use --all${c.reset}`);
    console.log(`  Usage: pnpm crux citations verify <page-id>`);
    console.log(`         pnpm crux citations verify --all [--limit=50]`);
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
    console.log(`${c.red}Error: page "${pageId}" not found${c.reset}`);
    process.exit(1);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const body = stripFrontmatter(raw);
  const citations = extractCitationsFromContent(body);

  if (citations.length === 0) {
    console.log(`${c.dim}No citations found in ${pageId}${c.reset}`);
    process.exit(0);
  }

  console.log(`\n${c.bold}${c.blue}Citation Verification: ${pageId}${c.reset}`);
  console.log(`  ${citations.length} citations to verify\n`);

  const archive = await verifyCitationsForPage(pageId, body, { verbose: true });

  if (json || ci) {
    console.log(JSON.stringify(archive, null, 2));
    process.exit(0);
  }

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

  process.exit(archive.broken > 0 ? 1 : 0);
}

main().catch((err: Error) => {
  console.error('Error:', err.message);
  process.exit(1);
});
