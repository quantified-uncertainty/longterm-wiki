/**
 * Health Command Handlers
 *
 * Run comprehensive system wellness checks against the wiki-server,
 * GitHub Actions, and optionally the public frontend.
 *
 * Mirrors the checks performed by the focused health workflows:
 *   .github/workflows/server-api-health.yml
 *   .github/workflows/frontend-data-health.yml
 *   .github/workflows/ci-pr-health.yml
 * so the same checks can be run locally during development or debugging.
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  check: {
    script: 'health/health-check.ts',
    description: 'Run all wellness checks',
    passthrough: ['ci', 'json', 'check', 'report', 'auto-issue', 'cleanup-labels'],
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
                    server       Server & DB health
                    api          API smoke tests
                    actions      GitHub Actions workflow health
                    frontend     Public frontend availability
                    freshness    Data freshness
                    job-queue    Job queue health
                    pr-quality   PR & issue quality
  --json          JSON output (all results as structured data)
  --report        Aggregate markdown report to stdout
  --auto-issue    Manage GitHub wellness issue (create/update/close)
  --cleanup-labels Auto-remove stale working labels (>8 hours)

Environment:
  LONGTERMWIKI_SERVER_URL        Wiki-server URL (required for most checks)
  LONGTERMWIKI_SERVER_API_KEY    API key for authenticated endpoints
  GITHUB_TOKEN                   GitHub token (required for actions, pr-quality checks)
  WIKI_PUBLIC_URL                Public wiki URL (optional, enables frontend check)

Examples:
  crux health                    Run all wellness checks
  crux health --check=server     Check server & DB only
  crux health --check=actions    Check GitHub Actions workflows only
  crux health --check=job-queue  Check job queue health
  crux health --json             JSON output for scripting
  crux health --report           Full markdown report
  crux health --report --auto-issue --cleanup-labels   CI mode (full report + issue management)
`;
}
