/**
 * Citations Command Handlers
 *
 * Verify, archive, and report on citation health across wiki pages.
 * Downloads cited URLs, stores metadata (title, content snippet, HTTP status),
 * and flags broken or suspicious citations.
 *
 * Usage:
 *   crux citations verify <page-id>         Verify citations for a page
 *   crux citations verify --all             Verify all pages with citations
 *   crux citations status <page-id>         Show verification status
 *   crux citations report                   Summary across all archived pages
 *
 * Part of the hallucination risk reduction initiative (issue #200).
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  verify: {
    script: 'citations/verify-citations.ts',
    description: 'Verify and archive citation URLs for a page',
    passthrough: ['ci', 'json', 'all', 'limit', 'recheck'],
    positional: true,
  },
  status: {
    script: 'citations/citation-status.ts',
    description: 'Show citation verification status',
    passthrough: ['ci', 'json', 'broken'],
    positional: true,
  },
  report: {
    script: 'citations/citation-report.ts',
    description: 'Summary report of citation verification across all pages',
    passthrough: ['ci', 'json', 'broken'],
  },
  'extract-quotes': {
    script: 'citations/extract-quotes.ts',
    description: 'Extract supporting quotes from cited sources',
    passthrough: ['ci', 'json', 'all', 'limit', 'recheck'],
    positional: true,
  },
  'quote-report': {
    script: 'citations/quote-report.ts',
    description: 'Report on quote extraction and verification coverage',
    passthrough: ['ci', 'json', 'broken'],
  },
  'verify-quotes': {
    script: 'citations/verify-quotes.ts',
    description: 'Re-verify stored quotes against fresh source content',
    passthrough: ['ci', 'json', 'all', 'limit', 'refetch'],
    positional: true,
  },
};

export const commands = buildCommands(SCRIPTS, 'report');

export function getHelp(): string {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(16)} ${config.description}`)
    .join('\n');

  return `
Citations Domain - Verify, archive, and report on citation health

Commands:
${commandList}

Options:
  --all             Process all pages with citations
  --limit=N         Limit number of pages to process (with --all)
  --recheck         Re-process already-handled pages
  --refetch         Re-fetch source URLs (verify-quotes only)
  --broken          Show only broken citations/quotes
  --json            JSON output
  --ci              JSON output for CI pipelines

Examples:
  crux citations verify existential-risk           Verify one page
  crux citations verify --all --limit=20           Verify top 20 pages
  crux citations status existential-risk           Show verification results
  crux citations report                            Summary across all pages
  crux citations report --broken                   List all broken citations
  crux citations extract-quotes existential-risk   Extract quotes for a page
  crux citations extract-quotes --all --limit=10   Batch extract quotes
  crux citations quote-report                      Quote coverage stats
  crux citations quote-report --broken             Show drifted/broken quotes
  crux citations verify-quotes existential-risk    Re-verify stored quotes
`;
}
