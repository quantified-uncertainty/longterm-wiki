/**
 * Quote Report Script
 *
 * Shows statistics about citation quote extraction and verification
 * across all processed pages.
 *
 * Usage:
 *   pnpm crux citations quote-report
 *   pnpm crux citations quote-report --json
 */

import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { citationQuotes, getDb } from '../lib/knowledge-db.ts';

interface PageStats {
  page_id: string;
  total: number;
  with_quotes: number;
  verified: number;
  avg_score: number | null;
  accuracy_checked: number;
  accurate: number;
  inaccurate: number;
}

function getPageStats(): PageStats[] {
  return getDb()
    .prepare(
      `
    SELECT
      page_id,
      COUNT(*) as total,
      SUM(CASE WHEN source_quote IS NOT NULL AND source_quote != '' THEN 1 ELSE 0 END) as with_quotes,
      SUM(CASE WHEN quote_verified = 1 THEN 1 ELSE 0 END) as verified,
      AVG(CASE WHEN verification_score IS NOT NULL THEN verification_score END) as avg_score,
      SUM(CASE WHEN accuracy_verdict IS NOT NULL THEN 1 ELSE 0 END) as accuracy_checked,
      SUM(CASE WHEN accuracy_verdict = 'accurate' THEN 1 ELSE 0 END) as accurate,
      SUM(CASE WHEN accuracy_verdict IN ('inaccurate', 'unsupported') THEN 1 ELSE 0 END) as inaccurate
    FROM citation_quotes
    GROUP BY page_id
    ORDER BY total DESC
  `,
    )
    .all() as PageStats[];
}

interface SourceTypeStats {
  source_type: string;
  count: number;
  with_quotes: number;
}

function getSourceTypeStats(): SourceTypeStats[] {
  return getDb()
    .prepare(
      `
    SELECT
      COALESCE(source_type, 'unknown') as source_type,
      COUNT(*) as count,
      SUM(CASE WHEN source_quote IS NOT NULL AND source_quote != '' THEN 1 ELSE 0 END) as with_quotes
    FROM citation_quotes
    GROUP BY source_type
    ORDER BY count DESC
  `,
    )
    .all() as SourceTypeStats[];
}

interface BrokenQuote {
  page_id: string;
  footnote: number;
  url: string | null;
  claim_text: string;
  verification_score: number | null;
}

function getBrokenQuotes(): BrokenQuote[] {
  return getDb()
    .prepare(
      `
    SELECT page_id, footnote, url, claim_text, verification_score
    FROM citation_quotes
    WHERE source_quote IS NOT NULL
      AND source_quote != ''
      AND quote_verified = 0
      AND verification_score IS NOT NULL
      AND verification_score < 0.4
    ORDER BY verification_score ASC
  `,
    )
    .all() as BrokenQuote[];
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const ci = args.ci === true;
  const json = args.json === true;
  const broken = args.broken === true;
  const colors = getColors(ci || json);
  const c = colors;

  const stats = citationQuotes.stats();
  const pageStats = getPageStats();
  const sourceTypeStats = getSourceTypeStats();

  if (json || ci) {
    const totalChecked = pageStats.reduce((s, p) => s + p.accuracy_checked, 0);
    const totalAccurate = pageStats.reduce((s, p) => s + p.accurate, 0);
    const totalInaccurate = pageStats.reduce((s, p) => s + p.inaccurate, 0);
    const data: Record<string, unknown> = {
      ...stats,
      accuracyChecked: totalChecked,
      accuracyAccurate: totalAccurate,
      accuracyInaccurate: totalInaccurate,
      pageStats,
      sourceTypeStats,
    };
    if (broken) {
      data.brokenQuotes = getBrokenQuotes();
    }
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
  }

  console.log(`\n${c.bold}${c.blue}Citation Quote Report${c.reset}\n`);

  // Overall stats
  console.log(`${c.bold}Overall:${c.reset}`);
  console.log(`  Total citations tracked:  ${stats.totalQuotes}`);
  console.log(
    `  ${c.green}With quotes:${c.reset}            ${stats.withQuotes} (${stats.totalQuotes > 0 ? ((stats.withQuotes / stats.totalQuotes) * 100).toFixed(0) : 0}%)`,
  );
  console.log(
    `  ${c.green}Verified:${c.reset}               ${stats.verified} (${stats.withQuotes > 0 ? ((stats.verified / stats.withQuotes) * 100).toFixed(0) : 0}%)`,
  );
  console.log(
    `  ${c.yellow}Unverified:${c.reset}             ${stats.unverified}`,
  );
  console.log(`  Pages processed:          ${stats.totalPages}`);
  if (stats.averageScore !== null) {
    console.log(
      `  Average verification:     ${(stats.averageScore * 100).toFixed(0)}%`,
    );
  }

  // Accuracy stats (if any accuracy checks have been run)
  const totalChecked = pageStats.reduce((s, p) => s + p.accuracy_checked, 0);
  if (totalChecked > 0) {
    const totalAccurate = pageStats.reduce((s, p) => s + p.accurate, 0);
    const totalInaccurate = pageStats.reduce((s, p) => s + p.inaccurate, 0);
    const totalMinorOrOther = totalChecked - totalAccurate - totalInaccurate;
    console.log(`\n${c.bold}Accuracy (second pass):${c.reset}`);
    console.log(`  Claims checked:           ${totalChecked}`);
    console.log(`  ${c.green}Accurate:${c.reset}               ${totalAccurate} (${totalChecked > 0 ? ((totalAccurate / totalChecked) * 100).toFixed(0) : 0}%)`);
    if (totalInaccurate > 0) {
      console.log(`  ${c.red}Inaccurate/unsupported:${c.reset} ${totalInaccurate} (${((totalInaccurate / totalChecked) * 100).toFixed(0)}%)`);
    }
    if (totalMinorOrOther > 0) {
      console.log(`  ${c.yellow}Minor/other:${c.reset}            ${totalMinorOrOther}`);
    }
  }

  // Source type breakdown
  if (sourceTypeStats.length > 0) {
    console.log(`\n${c.bold}By Source Type:${c.reset}`);
    for (const st of sourceTypeStats) {
      const pct =
        st.count > 0
          ? ` (${((st.with_quotes / st.count) * 100).toFixed(0)}% with quotes)`
          : '';
      console.log(
        `  ${st.source_type.padEnd(12)} ${String(st.count).padStart(4)} citations, ${String(st.with_quotes).padStart(4)} with quotes${pct}`,
      );
    }
  }

  // Per-page stats
  if (pageStats.length > 0) {
    console.log(`\n${c.bold}Top Pages:${c.reset}`);
    const topPages = pageStats.slice(0, 15);
    for (const p of topPages) {
      const scoreStr =
        p.avg_score !== null ? ` avg:${(p.avg_score * 100).toFixed(0)}%` : '';
      console.log(
        `  ${p.page_id.padEnd(40)} ${String(p.total).padStart(3)} total, ${String(p.with_quotes).padStart(3)} quoted, ${String(p.verified).padStart(3)} verified${scoreStr}`,
      );
    }
    if (pageStats.length > 15) {
      console.log(
        `  ${c.dim}... and ${pageStats.length - 15} more pages${c.reset}`,
      );
    }
  }

  // Broken quotes
  if (broken) {
    const brokenQuotes = getBrokenQuotes();
    if (brokenQuotes.length > 0) {
      console.log(
        `\n${c.red}${c.bold}Broken Quotes (extracted but not found in source):${c.reset}`,
      );
      for (const bq of brokenQuotes) {
        const scoreStr =
          bq.verification_score !== null
            ? ` (${(bq.verification_score * 100).toFixed(0)}%)`
            : '';
        console.log(
          `  [^${bq.footnote}] ${bq.page_id}${scoreStr}`,
        );
        console.log(
          `    ${c.dim}${bq.claim_text.slice(0, 100)}${c.reset}`,
        );
        if (bq.url) {
          console.log(`    ${c.dim}${bq.url.slice(0, 80)}${c.reset}`);
        }
      }
    } else {
      console.log(
        `\n${c.green}No broken quotes found.${c.reset}`,
      );
    }
  }

  console.log('');
  process.exit(0);
}

main().catch((err: Error) => {
  console.error('Error:', err.message);
  process.exit(1);
});
