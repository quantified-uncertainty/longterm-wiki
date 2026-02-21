#!/usr/bin/env node

/**
 * Edit Log Validator
 *
 * Edit logs are stored exclusively in PostgreSQL (wiki-server).
 * This validator queries the server for stats and reports health metrics.
 *
 * When the wiki-server is unavailable (LONGTERMWIKI_SERVER_URL not set, or
 * connection refused), the check passes with a warning — server availability
 * is not required for CI to succeed.
 *
 * Usage:
 *   npx tsx crux/validate/validate-edit-logs.ts
 *   npx tsx crux/validate/validate-edit-logs.ts --ci
 */

import { fileURLToPath } from 'url';
import { getColors } from '../lib/output.ts';
import { getEditLogStats } from '../lib/wiki-server/edit-logs.ts';

const args: string[] = process.argv.slice(2);
const CI_MODE: boolean = args.includes('--ci') || process.env.CI === 'true';
const colors = getColors(CI_MODE);

async function validate(): Promise<{ passed: boolean; errors: number; warnings: number }> {
  const result = await getEditLogStats();

  if (!result.ok) {
    const note =
      result.error === 'unavailable'
        ? 'Wiki-server unavailable — edit log stats cannot be checked. Set LONGTERMWIKI_SERVER_URL to enable.'
        : `Wiki-server error (${result.error}): ${result.message}`;

    if (CI_MODE) {
      console.log(
        JSON.stringify({ errors: 0, warnings: 1, issues: [{ level: 'warning', message: note }] }, null, 2),
      );
    } else {
      console.log(`${colors.yellow}  ⚠ ${note}${colors.reset}`);
    }
    return { passed: true, errors: 0, warnings: 1 };
  }

  const { totalEntries, pagesWithLogs, byTool, byAgency } = result.data;

  if (CI_MODE) {
    console.log(
      JSON.stringify(
        {
          errors: 0,
          warnings: 0,
          issues: [],
          stats: { totalEntries, pagesWithLogs, byTool, byAgency },
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`${colors.green}  ✓ Edit log store healthy${colors.reset}`);
    console.log(`${colors.dim}    Total entries: ${totalEntries}  |  Pages with logs: ${pagesWithLogs}${colors.reset}`);

    const topTools = Object.entries(byTool)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);
    if (topTools.length > 0) {
      console.log(`${colors.dim}    By tool: ${topTools.map(([t, n]) => `${t}=${n}`).join(', ')}${colors.reset}`);
    }
    if (byAgency && Object.keys(byAgency).length > 0) {
      const agencySummary = Object.entries(byAgency)
        .map(([a, n]) => `${a}=${n}`)
        .join(', ');
      console.log(`${colors.dim}    By agency: ${agencySummary}${colors.reset}`);
    }
  }

  return { passed: true, errors: 0, warnings: 0 };
}

async function main(): Promise<void> {
  const result = await validate();
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export { validate as runCheck };
