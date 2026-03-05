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

export const commands = buildCommands(SCRIPTS, 'status');

export function getHelp() {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(22)} ${config.description}`)
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
  crux ci pause-actions            Pause all automated workflows
  crux ci resume-actions           Resume all automated workflows
`;
}
