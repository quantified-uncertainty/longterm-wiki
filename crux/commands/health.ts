/**
 * Health Command Handlers
 *
 * Run comprehensive system wellness checks against the wiki-server,
 * GitHub Actions, and optionally the public frontend.
 *
 * Mirrors the checks performed by .github/workflows/wellness-check.yml
 * so the same checks can be run locally during development or debugging.
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  check: {
    script: 'health/health-check.ts',
    description: 'Run all wellness checks',
    passthrough: ['ci', 'json', 'check'],
  },
};

export const commands = buildCommands(SCRIPTS, 'check');

export function getHelp() {
  return `
Health Domain — System wellness checks

Commands:
  check           Run all wellness checks (default)

Options:
  --check=<name>  Run only a specific check:
                    server    Server & DB health
                    api       API smoke tests
                    actions   GitHub Actions workflow health
                    frontend  Public frontend availability
                    freshness Data freshness
  --json          JSON output (all results as structured data)

Environment:
  LONGTERMWIKI_SERVER_URL        Wiki-server URL (required for most checks)
  LONGTERMWIKI_SERVER_API_KEY    API key for authenticated endpoints
  GITHUB_TOKEN                   GitHub token (required for actions check)
  WIKI_PUBLIC_URL                Public wiki URL (optional, enables frontend check)

Examples:
  crux health                    Run all wellness checks
  crux health --check=server     Check server & DB only
  crux health --check=actions    Check GitHub Actions workflows only
  crux health --json             JSON output for scripting
`;
}
