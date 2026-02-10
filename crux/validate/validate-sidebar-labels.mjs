#!/usr/bin/env node

/**
 * Sidebar Label Validation Script
 *
 * Previously validated sidebar labels in the legacy static-site config.
 * In the Next.js app, sidebar navigation is managed by app/src/lib/wiki-nav.ts.
 * This script is no longer applicable and exits cleanly.
 *
 * Usage: node scripts/validate/validate-sidebar-labels.mjs [--ci]
 *
 * Exit codes:
 *   0 = Always (not applicable for Next.js)
 */

import { getColors } from '../lib/output.ts';

const CI_MODE = process.argv.includes('--ci');
const colors = getColors(CI_MODE);

function main() {
  if (CI_MODE) {
    console.log(JSON.stringify({
      skipped: true,
      reason: 'Sidebar labels are managed by wiki-nav.ts in the Next.js app',
      labelsChecked: 0,
      errors: 0,
      warnings: 0,
      issues: [],
    }, null, 2));
  } else {
    console.log(`${colors.dim}Skipping sidebar label check: sidebar is managed by wiki-nav.ts in the Next.js app${colors.reset}`);
  }
  process.exit(0);
}

main();
