/**
 * Claims–Citations Coverage Audit
 *
 * Queries the wiki-server /api/integrity/claims-citations-coverage endpoint
 * to show how much of citation_quotes has been consolidated into the claims system.
 *
 * Usage:
 *   crux claims coverage-audit          Human-readable report
 *   crux claims coverage-audit --json   JSON output
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { apiRequest, isServerAvailable } from '../lib/wiki-server/client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CoverageResult {
  checked_at: string;
  citation_quotes: {
    total: number;
    linked_to_claims: number;
    unlinked: number;
    field_coverage: Record<string, number>;
  };
  claims_system: {
    total_claims: number;
    total_sources: number;
    total_page_refs: number;
    distinct_entities: number;
  };
  page_breakdown: {
    only_citation_quotes: number;
    only_claims: number;
    both: number;
    neither: number;
  };
  backfill_readiness: {
    ready: number;
    not_ready: number;
  };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

function renderReport(data: CoverageResult): void {
  const c = getColors(false);
  const cq = data.citation_quotes;
  const cl = data.claims_system;
  const pb = data.page_breakdown;
  const br = data.backfill_readiness;

  console.log(`\n${c.bold}${c.blue}Claims ↔ Citations Coverage Audit${c.reset}`);
  console.log(`  ${c.dim}${data.checked_at}${c.reset}\n`);

  // Citation quotes summary
  console.log(`${c.bold}citation_quotes${c.reset}`);
  console.log(`  Total:              ${cq.total}`);
  console.log(`  Linked to claims:   ${c.green}${cq.linked_to_claims}${c.reset} (${pct(cq.linked_to_claims, cq.total)})`);
  console.log(`  Unlinked:           ${cq.unlinked > 0 ? c.yellow : c.green}${cq.unlinked}${c.reset} (${pct(cq.unlinked, cq.total)})`);

  // Field coverage
  console.log(`\n  ${c.dim}Field coverage:${c.reset}`);
  for (const [field, count] of Object.entries(cq.field_coverage)) {
    const label = field.replace(/_/g, ' ').padEnd(20);
    console.log(`    ${label} ${count.toString().padStart(5)} (${pct(count, cq.total)})`);
  }

  // Claims system
  console.log(`\n${c.bold}claims system${c.reset}`);
  console.log(`  Claims:             ${cl.total_claims}`);
  console.log(`  Sources:            ${cl.total_sources}`);
  console.log(`  Page refs:          ${cl.total_page_refs}`);
  console.log(`  Distinct entities:  ${cl.distinct_entities}`);

  // Page breakdown
  console.log(`\n${c.bold}Page overlap${c.reset}`);
  console.log(`  Only citation_quotes: ${pb.only_citation_quotes}`);
  console.log(`  Only claims:          ${pb.only_claims}`);
  console.log(`  Both:                 ${pb.both}`);
  console.log(`  Neither:              ${pb.neither}`);

  // Backfill readiness
  console.log(`\n${c.bold}Backfill readiness${c.reset} (unlinked quotes)`);
  console.log(`  Ready:     ${c.green}${br.ready}${c.reset}`);
  console.log(`  Not ready: ${c.dim}${br.not_ready}${c.reset} (missing/short claim text)`);

  // Progress bar
  const totalPages = pb.only_citation_quotes + pb.only_claims + pb.both + pb.neither;
  const coveredPages = pb.only_claims + pb.both;
  const barWidth = 30;
  const filled = totalPages > 0 ? Math.round((coveredPages / totalPages) * barWidth) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  console.log(`\n  Claims coverage: [${bar}] ${pct(coveredPages, totalPages)} of pages`);

  const consolidation = cq.total > 0 ? pct(cq.linked_to_claims, cq.total) : '100%';
  const cBar = cq.total > 0 ? Math.round((cq.linked_to_claims / cq.total) * barWidth) : barWidth;
  const consolidationBar = '█'.repeat(cBar) + '░'.repeat(barWidth - cBar);
  console.log(`  Consolidation:   [${consolidationBar}] ${consolidation} of quotes linked\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const jsonOutput = args.json === true;
  const c = getColors(false);

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`);
    process.exit(1);
  }

  const result = await apiRequest<CoverageResult>('GET', '/api/integrity/claims-citations-coverage');
  if (!result.ok) {
    console.error(`${c.red}Failed to fetch coverage data: ${result.message}${c.reset}`);
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result.data, null, 2));
  } else {
    renderReport(result.data);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
