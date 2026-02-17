/**
 * CI Command Handlers
 *
 * GitHub CI status checking and monitoring.
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  status: {
    script: 'ci/ci-status.ts',
    description: 'Check GitHub CI check-run status',
    passthrough: ['ci', 'wait', 'sha'],
  },
};

export const commands = buildCommands(SCRIPTS, 'status');

export function getHelp() {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(14)} ${config.description}`)
    .join('\n');

  return `
CI Domain - GitHub CI status and monitoring

Commands:
${commandList}

Options:
  --wait          Poll every 30s until all checks complete
  --sha=<sha>     Check a specific commit (default: HEAD)
  --ci            JSON output

Examples:
  crux ci status                  Show current CI status
  crux ci status --wait           Poll until all checks complete
  crux ci status --sha=abc123     Check a specific commit
`;
}
