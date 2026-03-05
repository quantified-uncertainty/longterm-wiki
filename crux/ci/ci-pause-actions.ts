#!/usr/bin/env node

/**
 * Pause Actions — Set AUTOMATION_PAUSED repository variable to 'true'.
 *
 * When set, all 15 automated/scheduled workflows will skip their main jobs
 * and show a [PAUSED] indicator in the GitHub Actions run name.
 *
 * Usage:
 *   crux ci pause-actions
 *
 * Requires GITHUB_TOKEN environment variable.
 */

import { getColors } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';

const CI_MODE = process.argv.includes('--ci') || process.env.CI === 'true';
const c = getColors(CI_MODE);

async function main() {
  // Check if already paused
  try {
    const current = (await githubApi(
      `/repos/${REPO}/actions/variables/AUTOMATION_PAUSED`
    )) as { value: string };
    if (current.value === 'true') {
      console.log(
        `${c.yellow}AUTOMATION_PAUSED is already set to 'true'.${c.reset}`
      );
      return;
    }
    // Variable exists but isn't 'true' — update it
    await githubApi(`/repos/${REPO}/actions/variables/AUTOMATION_PAUSED`, {
      method: 'PATCH',
      body: { name: 'AUTOMATION_PAUSED', value: 'true' },
    });
  } catch {
    // Variable doesn't exist — create it
    await githubApi(`/repos/${REPO}/actions/variables`, {
      method: 'POST',
      body: { name: 'AUTOMATION_PAUSED', value: 'true' },
    });
  }

  console.log(
    `${c.green}AUTOMATION_PAUSED set to 'true'.${c.reset} All automated workflows are now paused.`
  );
  console.log(
    `Run ${c.cyan}pnpm crux ci resume-actions${c.reset} to resume.`
  );
}

main().catch((err) => {
  console.error(
    `${c.red}Failed to pause actions:${c.reset}`,
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
