/**
 * Claims Data Integrity Audit
 *
 * Queries the wiki-server /api/integrity/claims-audit endpoint to check
 * for data quality issues caused by past bugs (off-by-one in is_primary,
 * batch ordering, ANSI parsing, --force over-deletion, precision loss).
 *
 * Usage:
 *   crux claims audit           Run audit and report results
 *   crux claims audit --json    JSON output
 */

import { apiRequest } from '../lib/wiki-server/client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditCheck {
  name: string;
  description: string;
  status: 'pass' | 'warn' | 'fail';
  count: number;
  details?: string;
  sample?: Array<Record<string, unknown>>;
}

interface AuditResult {
  status: 'clean' | 'issues_found';
  checked_at: string;
  checks: AuditCheck[];
  summary: {
    total_claims: number;
    total_sources: number;
    checks_run: number;
    passed: number;
    warnings: number;
    failures: number;
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  const result = await apiRequest<AuditResult>('GET', '/api/integrity/claims-audit');

  if (!result.ok) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: result.error }, null, 2));
    } else {
      console.error(`\x1b[31m✗ Failed to run claims audit: ${result.error}\x1b[0m`);
      if (result.status) {
        console.error(`  HTTP ${result.status}`);
      }
    }
    process.exit(1);
  }

  const audit = result.data;

  if (jsonOutput) {
    console.log(JSON.stringify(audit, null, 2));
    process.exit(audit.summary.failures > 0 ? 1 : 0);
  }

  // Terminal output
  const c = {
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    reset: '\x1b[0m',
  };

  console.log(`${c.bold}Claims Data Integrity Audit${c.reset}`);
  console.log(`${c.dim}${audit.summary.total_claims} claims, ${audit.summary.total_sources} sources${c.reset}`);
  console.log();

  for (const check of audit.checks) {
    const icon =
      check.status === 'pass'
        ? `${c.green}✓${c.reset}`
        : check.status === 'warn'
          ? `${c.yellow}⚠${c.reset}`
          : `${c.red}✗${c.reset}`;

    const countStr = check.count > 0 ? ` (${check.count})` : '';
    console.log(`  ${icon} ${check.description}${countStr}`);

    if (check.details) {
      console.log(`    ${c.dim}${check.details}${c.reset}`);
    }

    if (check.sample && check.sample.length > 0) {
      for (const row of check.sample.slice(0, 5)) {
        console.log(`    ${c.dim}${JSON.stringify(row)}${c.reset}`);
      }
      if (check.sample.length > 5) {
        console.log(`    ${c.dim}...and ${check.sample.length - 5} more${c.reset}`);
      }
    }
  }

  console.log();
  const summaryColor =
    audit.summary.failures > 0
      ? c.red
      : audit.summary.warnings > 0
        ? c.yellow
        : c.green;
  console.log(
    `${summaryColor}${audit.summary.passed} passed, ${audit.summary.warnings} warnings, ${audit.summary.failures} failures${c.reset}`
  );

  process.exit(audit.summary.failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Claims audit failed:', err);
  process.exit(1);
});
