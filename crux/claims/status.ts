/**
 * Claims Status — show claim count and verification breakdown for a page
 *
 * Usage:
 *   pnpm crux claims status <page-id>
 *   pnpm crux claims status <page-id> --json
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { getClaimsByEntity } from '../lib/wiki-server/claims.ts';

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const json = args.json === true;
  const c = getColors(json);
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux claims status <page-id>`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`);
    process.exit(1);
  }

  const result = await getClaimsByEntity(pageId);
  if (!result.ok) {
    console.error(`${c.red}Could not fetch claims for ${pageId}${c.reset}`);
    process.exit(1);
  }

  const claims = result.data.claims;

  if (claims.length === 0) {
    if (json) {
      console.log(JSON.stringify({ pageId, total: 0, message: 'No claims found. Run: pnpm crux claims extract ' + pageId }));
    } else {
      console.log(`${c.yellow}No claims found for ${pageId}${c.reset}`);
      console.log(`  Run: pnpm crux claims extract ${pageId}`);
    }
    process.exit(0);
  }

  // Count by type and confidence
  const byType: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  const bySection: Record<string, number> = {};
  const sourced = claims.filter(c => c.unit && c.unit.length > 0).length;

  for (const claim of claims) {
    byType[claim.claimType] = (byType[claim.claimType] ?? 0) + 1;
    const conf = claim.confidence ?? 'unverified';
    byConfidence[conf] = (byConfidence[conf] ?? 0) + 1;
    const section = claim.value ?? 'Unknown';
    bySection[section] = (bySection[section] ?? 0) + 1;
  }

  if (json) {
    console.log(JSON.stringify({
      pageId,
      total: claims.length,
      sourced,
      unsourced: claims.length - sourced,
      byType,
      byConfidence,
      bySection,
      claims: claims.map(cl => ({
        id: cl.id,
        claimText: cl.claimText,
        claimType: cl.claimType,
        section: cl.value,
        footnoteRefs: cl.unit ? cl.unit.split(',') : [],
        confidence: cl.confidence,
      })),
    }, null, 2));
    return;
  }

  console.log(`\n${c.bold}${c.blue}Claims Status: ${pageId}${c.reset}\n`);
  console.log(`  Total claims:   ${c.bold}${claims.length}${c.reset}`);
  console.log(`  Sourced:        ${sourced} (have footnote refs)`);
  console.log(`  Unsourced:      ${claims.length - sourced}`);

  console.log(`\n${c.bold}By Confidence:${c.reset}`);
  const confOrder = ['verified', 'unverified', 'unsourced'];
  const confColors: Record<string, string> = {
    verified: c.green,
    unverified: c.yellow,
    unsourced: c.red,
  };
  for (const conf of [...confOrder, ...Object.keys(byConfidence).filter(k => !confOrder.includes(k))]) {
    if (byConfidence[conf] !== undefined) {
      const col = confColors[conf] ?? c.dim;
      console.log(`  ${col}${conf.padEnd(12)}${c.reset}  ${byConfidence[conf]}`);
    }
  }

  console.log(`\n${c.bold}By Claim Type:${c.reset}`);
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(14)}  ${count}`);
  }

  console.log(`\n${c.bold}By Section:${c.reset}`);
  for (const [section, count] of Object.entries(bySection).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${section.slice(0, 40).padEnd(40)}  ${count}`);
  }

  // Show a sample of unverified claims
  const unverified = claims.filter(cl => cl.confidence === 'unverified');
  if (unverified.length > 0 && byConfidence['verified'] === undefined) {
    console.log(`\n${c.yellow}No claims verified yet. Run:${c.reset}`);
    console.log(`  pnpm crux claims verify ${pageId}`);
  } else if (unverified.length > 0) {
    console.log(`\n${c.yellow}${unverified.length} unverified claim(s). Run:${c.reset}`);
    console.log(`  pnpm crux claims verify ${pageId}`);
  }

  console.log('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Claims status failed:', err);
    process.exit(1);
  });
}
