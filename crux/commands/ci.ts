/**
 * CI Command Handlers
 *
 * GitHub CI status checking and monitoring.
 * Hybrid pattern: script-based commands + direct handlers.
 */

import { buildCommands } from '../lib/cli.ts';
import { createLogger } from '../lib/output.ts';
import type { CommandOptions, CommandResult } from '../lib/command-types.ts';

const SCRIPTS = {
  status: {
    script: 'ci/ci-status.ts',
    description: 'Check GitHub CI check-run status',
    passthrough: ['ci', 'wait', 'sha'],
  },
  'pause-actions': {
    script: 'ci/ci-pause-actions.ts',
    description: 'Pause all automated GitHub Actions workflows',
    passthrough: ['ci'],
  },
  'resume-actions': {
    script: 'ci/ci-resume-actions.ts',
    description: 'Resume all automated GitHub Actions workflows',
    passthrough: ['ci'],
  },
};

// ── Direct handlers ──────────────────────────────────────────────────────────

/**
 * Check whether the main branch CI is passing or failing.
 *
 * Usage:
 *   crux ci main-status          Is main branch CI green or red?
 *   crux ci main-status --json   Machine-readable output
 */
async function mainStatus(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const json = Boolean(options.json);

  const { checkMainBranch } = await import('../lib/pr-analysis/index.ts');

  const status = await checkMainBranch();

  if (json) {
    return {
      output: JSON.stringify(status, null, 2) + '\n',
      exitCode: status.isRed ? 1 : 0,
    };
  }

  if (status.isRed) {
    let output = `${c.red}🔴 Main branch CI is RED${c.reset}\n`;
    output += `  Run ID: ${status.runId}\n`;
    output += `  SHA: ${status.sha.slice(0, 8)}\n`;
    output += `  URL: ${status.htmlUrl}\n`;
    return { output, exitCode: 1 };
  }

  return {
    output: `${c.green}✓ Main branch CI is green.${c.reset}\n`,
    exitCode: 0,
  };
}

// ── Merge script-based + direct commands ─────────────────────────────────────

const scriptCommands = buildCommands(SCRIPTS, 'status');

export const commands = {
  ...scriptCommands,
  'main-status': mainStatus,
};

export function getHelp() {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(22)} ${config.description}`)
    .join('\n');

  return `
CI Domain - GitHub CI status and monitoring

Commands:
${commandList}
  main-status            Check if main branch CI is passing or failing.

Options:
  --wait          Poll every 30s until all checks complete
  --sha=<sha>     Check a specific commit (default: HEAD)
  --ci            JSON output
  --json          JSON output (main-status)

Examples:
  crux ci status                  Show current CI status
  crux ci status --wait           Poll until all checks complete
  crux ci status --sha=abc123     Check a specific commit
  crux ci main-status             Is main branch CI green or red?
  crux ci main-status --json      Machine-readable output
  crux ci pause-actions            Pause all automated workflows
  crux ci resume-actions           Resume all automated workflows
`;
}
