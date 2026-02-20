/**
 * Citation Status — show verification results for a page
 *
 * Usage:
 *   pnpm crux citations status <page-id>
 *   pnpm crux citations status <page-id> --broken
 */

import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { readCitationArchive } from '../lib/citation-archive.ts';

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const ci = args.ci === true;
  const json = args.json === true;
  const broken = args.broken === true;
  const colors = getColors(ci || json);
  const c = colors;

  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!pageId) {
    console.error(`${c.red}Error: page ID required. Usage: crux citations status <page-id>${c.reset}`);
    process.exit(1);
  }

  const archive = readCitationArchive(pageId);

  if (!archive) {
    console.log(`${c.yellow}No citation archive for "${pageId}".${c.reset}`);
    console.log(`${c.dim}Run: pnpm crux citations verify ${pageId}${c.reset}`);
    process.exit(0);
  }

  if (json || ci) {
    const output = broken
      ? { ...archive, citations: archive.citations.filter(cit => cit.status === 'broken') }
      : archive;
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  console.log(`\n${c.bold}${c.blue}Citation Status: ${pageId}${c.reset}`);
  console.log(`  Verified at:     ${archive.verifiedAt}`);
  console.log(`  Total:           ${archive.totalCitations}`);
  console.log(`  ${c.green}Verified:${c.reset}        ${archive.verified}`);
  console.log(`  ${c.red}Broken:${c.reset}          ${archive.broken}`);
  console.log(`  ${c.yellow}Unverifiable:${c.reset}    ${archive.unverifiable}\n`);

  const displayCitations = broken
    ? archive.citations.filter(cit => cit.status === 'broken')
    : archive.citations;

  for (const cit of displayCitations) {
    const icon = cit.status === 'verified' ? `${c.green}✓${c.reset}` :
                 cit.status === 'broken' ? `${c.red}✗${c.reset}` :
                 `${c.yellow}?${c.reset}`;

    console.log(`  ${icon} [^${cit.footnote}] ${cit.url.slice(0, 70)}`);
    if (cit.linkText) console.log(`    ${c.dim}Link: "${cit.linkText}"${c.reset}`);
    if (cit.pageTitle) console.log(`    ${c.dim}Title: "${cit.pageTitle}"${c.reset}`);
    if (cit.status === 'broken') console.log(`    ${c.red}Error: ${cit.note || 'unknown'}${c.reset}`);
    if (cit.status === 'verified' && cit.contentSnippet) {
      console.log(`    ${c.dim}Snippet: "${cit.contentSnippet.slice(0, 80)}..."${c.reset}`);
    }
    console.log(`    ${c.dim}Claim: ${cit.claimContext.slice(0, 100)}${c.reset}`);
    console.log('');
  }

  process.exit(0);
}

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
