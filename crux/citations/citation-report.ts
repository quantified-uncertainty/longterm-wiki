/**
 * Citation Report — summary of citation verification across all pages
 *
 * Usage:
 *   pnpm crux citations report
 *   pnpm crux citations report --broken
 *   pnpm crux citations report --json
 */

import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { readCitationArchive, listArchivedPages } from '../lib/citation-archive.ts';

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const ci = args.ci === true;
  const json = args.json === true;
  const brokenOnly = args.broken === true;
  const colors = getColors(ci || json);
  const c = colors;

  const pageIds = listArchivedPages();

  if (pageIds.length === 0) {
    console.log(`${c.dim}No citation archives found.${c.reset}`);
    console.log(`${c.dim}Run: pnpm crux citations verify <page-id>${c.reset}`);
    process.exit(0);
  }

  // Load all archives
  let totalCitations = 0;
  let totalVerified = 0;
  let totalBroken = 0;
  let totalUnverifiable = 0;
  let pagesWithBroken = 0;

  interface PageSummary {
    pageId: string;
    total: number;
    verified: number;
    broken: number;
    unverifiable: number;
    verifiedAt: string;
    brokenUrls: Array<{ footnote: number; url: string; linkText: string; note: string | null }>;
  }

  const summaries: PageSummary[] = [];

  for (const pageId of pageIds) {
    const archive = readCitationArchive(pageId);
    if (!archive) continue;

    totalCitations += archive.totalCitations;
    totalVerified += archive.verified;
    totalBroken += archive.broken;
    totalUnverifiable += archive.unverifiable;
    if (archive.broken > 0) pagesWithBroken++;

    summaries.push({
      pageId,
      total: archive.totalCitations,
      verified: archive.verified,
      broken: archive.broken,
      unverifiable: archive.unverifiable,
      verifiedAt: archive.verifiedAt,
      brokenUrls: archive.citations
        .filter(cit => cit.status === 'broken')
        .map(cit => ({ footnote: cit.footnote, url: cit.url, linkText: cit.linkText, note: cit.note })),
    });
  }

  // Sort: pages with most broken citations first
  summaries.sort((a, b) => b.broken - a.broken || b.total - a.total);

  if (json || ci) {
    const output = {
      summary: {
        pagesArchived: pageIds.length,
        totalCitations,
        verified: totalVerified,
        broken: totalBroken,
        unverifiable: totalUnverifiable,
        pagesWithBroken,
        verificationRate: totalCitations > 0 ? Math.round((totalVerified / totalCitations) * 100) : 0,
      },
      pages: brokenOnly ? summaries.filter(s => s.broken > 0) : summaries,
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  // Human-readable output
  console.log(`\n${c.bold}${c.blue}Citation Verification Report${c.reset}\n`);
  console.log(`  Pages archived:    ${c.bold}${pageIds.length}${c.reset}`);
  console.log(`  Total citations:   ${totalCitations}`);
  console.log(`  ${c.green}Verified:${c.reset}          ${totalVerified} (${totalCitations > 0 ? Math.round((totalVerified / totalCitations) * 100) : 0}%)`);
  console.log(`  ${c.red}Broken:${c.reset}            ${totalBroken}`);
  console.log(`  ${c.yellow}Unverifiable:${c.reset}      ${totalUnverifiable}`);
  console.log(`  Pages with broken: ${pagesWithBroken}\n`);

  const display = brokenOnly ? summaries.filter(s => s.broken > 0) : summaries;

  if (display.length === 0) {
    console.log(`${c.green}No broken citations found!${c.reset}\n`);
    process.exit(0);
  }

  // Table header
  console.log(`${c.bold}${'Verified'.padEnd(10)} ${'Broken'.padEnd(8)} ${'Total'.padEnd(7)} ${'Checked'.padEnd(12)} Page${c.reset}`);
  console.log(`${c.dim}${'─'.repeat(65)}${c.reset}`);

  for (const s of display) {
    const brokenColor = s.broken > 0 ? c.red : '';
    console.log(
      `${c.green}${String(s.verified).padEnd(10)}${c.reset}` +
      `${brokenColor}${String(s.broken).padEnd(8)}${c.reset}` +
      `${String(s.total).padEnd(7)}` +
      `${s.verifiedAt.padEnd(12)} ` +
      `${s.pageId}`
    );

    // Show broken URLs inline if --broken
    if (brokenOnly && s.brokenUrls.length > 0) {
      for (const b of s.brokenUrls) {
        console.log(`  ${c.red}[^${b.footnote}]${c.reset} ${c.dim}${b.url.slice(0, 60)}${c.reset}`);
        if (b.note) console.log(`         ${c.dim}${b.note}${c.reset}`);
      }
    }
  }

  console.log(`\n${c.dim}Use --broken to show only pages with broken citations${c.reset}\n`);

  process.exit(0);
}

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
