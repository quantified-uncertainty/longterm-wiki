/**
 * Report generation and output formatting for link check results.
 */

import type { CheckResult, LinkCheckReport } from './types.ts';

/** Generate a structured report from check results. */
export function generateReport(results: CheckResult[]): LinkCheckReport {
  const summary = {
    total_urls: results.length,
    checked: 0,
    healthy: 0,
    broken: 0,
    redirected: 0,
    unverifiable: 0,
    skipped: 0,
    errors: 0,
  };

  for (const r of results) {
    switch (r.status) {
      case 'healthy': summary.healthy++; summary.checked++; break;
      case 'broken': summary.broken++; summary.checked++; break;
      case 'redirected': summary.redirected++; summary.checked++; break;
      case 'unverifiable': summary.unverifiable++; break;
      case 'skipped': summary.skipped++; break;
      case 'error': summary.errors++; summary.checked++; break;
    }
  }

  const broken = results
    .filter(r => r.status === 'broken' || r.status === 'error')
    .map(r => ({
      url: r.url,
      status: r.httpStatus || 0,
      error: r.error,
      sources: r.sources.map(s => ({ file: s.file, line: s.line })),
      archive_url: r.archiveUrl,
      last_checked: new Date().toISOString().split('T')[0],
    }));

  const redirected = results
    .filter(r => r.status === 'redirected' && r.redirectUrl)
    .map(r => ({
      url: r.url,
      redirects_to: r.redirectUrl!,
      sources: r.sources.map(s => ({ file: s.file, line: s.line })),
    }));

  return {
    timestamp: new Date().toISOString(),
    summary,
    broken,
    redirected,
  };
}

/** Print a human-readable summary to stdout. */
export function printSummary(report: LinkCheckReport): void {
  const { summary } = report;

  console.log('\n' + '='.repeat(60));
  console.log('  Link Check Results');
  console.log('='.repeat(60));
  console.log(`  Total URLs:    ${summary.total_urls}`);
  console.log(`  Checked:       ${summary.checked}`);
  console.log(`  Healthy:       ${summary.healthy}`);
  console.log(`  Broken:        ${summary.broken}`);
  console.log(`  Redirected:    ${summary.redirected}`);
  console.log(`  Unverifiable:  ${summary.unverifiable}`);
  console.log(`  Skipped:       ${summary.skipped}`);
  console.log(`  Errors:        ${summary.errors}`);
  console.log('='.repeat(60));

  if (report.broken.length > 0) {
    console.log(`\n  Broken URLs (${report.broken.length}):\n`);
    for (const item of report.broken.slice(0, 50)) {
      const detail = item.error || `HTTP ${item.status}`;
      console.log(`  - ${item.url}`);
      console.log(`    Status: ${detail}`);
      for (const src of item.sources.slice(0, 3)) {
        const loc = src.line ? `${src.file}:${src.line}` : src.file;
        console.log(`    Source: ${loc}`);
      }
      if (item.sources.length > 3) {
        console.log(`    ... and ${item.sources.length - 3} more sources`);
      }
      if (item.archive_url) {
        console.log(`    Archive: ${item.archive_url}`);
      }
      console.log();
    }
    if (report.broken.length > 50) {
      console.log(`  ... and ${report.broken.length - 50} more broken URLs`);
    }
  }

  if (report.redirected.length > 0) {
    console.log(`\n  Redirected URLs (${report.redirected.length}):\n`);
    for (const item of report.redirected.slice(0, 20)) {
      console.log(`  - ${item.url}`);
      console.log(`    -> ${item.redirects_to}`);
    }
    if (report.redirected.length > 20) {
      console.log(`  ... and ${report.redirected.length - 20} more redirected URLs`);
    }
  }
}
