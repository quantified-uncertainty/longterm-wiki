/**
 * QA Sweep Command Handlers
 *
 * Adversarial quality assurance — deterministic checks for bugs,
 * broken references, data integrity issues, and regressions.
 *
 * The `/qa-sweep` Claude Code skill calls this for automated checks,
 * then adds LLM-driven agents on top (production site audit, code review).
 *
 * Schedule with: /loop 24h /qa-sweep
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  run: {
    script: 'qa-sweep/sweep.ts',
    description: 'Full QA sweep (recent changes + automated checks)',
    passthrough: ['json'],
  },
  recent: {
    script: 'qa-sweep/sweep.ts',
    description: 'Show recent changes to prioritize',
    defaultArgs: ['recent'],
    passthrough: ['json'],
  },
  checks: {
    script: 'qa-sweep/sweep.ts',
    description: 'Run automated checks only (fast)',
    defaultArgs: ['checks'],
    passthrough: ['json'],
  },
};

export const commands = buildCommands(SCRIPTS, 'run');

export function getHelp() {
  return `
QA Sweep — Adversarial quality assurance

Commands:
  run             Full sweep: recent changes + all checks (default)
  recent          Show recent PRs and changed files only
  checks          Run automated checks only (no change listing)

Options:
  --json          JSON output for scripting

Automated checks:
  - Duplicate numericIds across YAML + MDX
  - References to deleted/merged entities
  - NEEDS CITATION markers in content
  - TODO markers in content
  - Wrong domain references (longterm.wiki, longtermwiki.org)
  - Content gate validation (full mode only)
  - Test suite status (full mode only)

Usage with Claude Code:
  /qa-sweep                Run full adversarial audit (crux checks + LLM agents)
  /loop 24h /qa-sweep      Schedule daily runs using your subscription

Examples:
  crux qa-sweep                  Full report
  crux qa-sweep checks           Fast checks only
  crux qa-sweep checks --json    JSON output for CI
  crux qa-sweep recent           What changed recently
`;
}
