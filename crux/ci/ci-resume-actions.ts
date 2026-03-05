#!/usr/bin/env node

/**
 * Resume Actions — Delete the AUTOMATION_PAUSED repository variable.
 *
 * Removes the pause, allowing all 15 automated/scheduled workflows to run
 * normally again.
 *
 * Usage:
 *   crux ci resume-actions
 *
 * Requires GITHUB_TOKEN environment variable.
 */

import { getColors } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';

const CI_MODE = process.argv.includes('--ci') || process.env.CI === 'true';
const c = getColors(CI_MODE);

async function main() {
  try {
    await githubApi(`/repos/${REPO}/actions/variables/AUTOMATION_PAUSED`, {
      method: 'DELETE',
    });
    console.log(
      `${c.green}AUTOMATION_PAUSED deleted.${c.reset} All automated workflows are now active.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404') || msg.includes('Not Found')) {
      console.log(
        `${c.yellow}AUTOMATION_PAUSED was not set — actions are already active.${c.reset}`
      );
    } else {
      throw err;
    }
  }
}

main().catch((err) => {
  console.error(
    `${c.red}Failed to resume actions:${c.reset}`,
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
