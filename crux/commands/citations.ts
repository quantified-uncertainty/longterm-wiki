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
    passthrough: ['ci', 'json', 'all', 'limit', 'recheck', 'content-verify'],
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
    passthrough: ['ci', 'json', 'all', 'limit', 'recheck', 'concurrency', 'dry-run'],
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
  'check-accuracy': {
    script: 'citations/check-accuracy.ts',
    description: 'Check if wiki claims accurately represent cited sources',
    passthrough: ['ci', 'json', 'all', 'limit', 'recheck', 'concurrency', 'dry-run'],
    positional: true,
  },
  'normalize-footnotes': {
    script: 'citations/normalize-footnotes.ts',
    description: 'Report/fix inconsistent footnote formats across pages',
    passthrough: ['json', 'fix'],
    positional: true,
  },
  'export-dashboard': {
    script: 'citations/export-dashboard.ts',
    description: 'Export accuracy data as YAML for the internal dashboard',
    passthrough: ['json', 'from-db'],
  },
  'migrate-accuracy': {
    script: 'citations/migrate-accuracy-to-db.ts',
    description: 'Migrate citation accuracy data from SQLite to PostgreSQL',
    passthrough: ['dry-run'],
  },
  'fix-inaccuracies': {
    script: 'citations/fix-inaccuracies.ts',
    description: 'Fix flagged citation inaccuracies using LLM-generated corrections',
    passthrough: ['apply', 'verdict', 'max-score', 'model', 'json', 'concurrency', 'escalate'],
    positional: true,
  },
  audit: {
    script: 'citations/audit.ts',
    description: 'Full pipeline: extract quotes, check accuracy, fix issues for one page',
    passthrough: ['json', 'apply', 'recheck', 'model', 'escalate', 'second-opinion'],
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
  --concurrency=N   Process N pages in parallel (default: 1)
  --dry-run         Show what would be processed without running
  --recheck         Re-process already-handled pages
  --refetch         Re-fetch source URLs (verify-quotes only)
  --broken          Show only broken citations/quotes
  --content-verify  (verify only) Also check if source content supports each claim
  --json            JSON output
  --ci              JSON output for CI pipelines

Examples:
  crux citations verify existential-risk                    Verify one page
  crux citations verify existential-risk --content-verify  Also check claim support
  crux citations verify --all --limit=20                   Verify top 20 pages
  crux citations status existential-risk           Show verification results
  crux citations report                            Summary across all pages
  crux citations report --broken                   List all broken citations
  crux citations extract-quotes existential-risk   Extract quotes for a page
  crux citations extract-quotes --all --limit=10   Batch extract quotes
  crux citations quote-report                      Quote coverage stats
  crux citations quote-report --broken             Show drifted/broken quotes
  crux citations verify-quotes existential-risk    Re-verify stored quotes
  crux citations check-accuracy existential-risk   Check claim accuracy vs sources
  crux citations check-accuracy --all              Batch accuracy check
  crux citations normalize-footnotes                Report footnote format issues
  crux citations normalize-footnotes --fix          Auto-fix to [Title](URL) format
  crux citations normalize-footnotes --fix <id>     Fix one page
  crux citations export-dashboard                  Export data for web dashboard
  crux citations export-dashboard --from-db        Export from PostgreSQL instead of SQLite
  crux citations migrate-accuracy                   Migrate accuracy data to PostgreSQL
  crux citations migrate-accuracy --dry-run         Preview migration
  crux citations fix-inaccuracies                   Dry-run fix proposals for all flagged
  crux citations fix-inaccuracies --apply           Apply fixes to pages
  crux citations fix-inaccuracies <id>              Fix one page
  crux citations fix-inaccuracies --max-score=0.5   Only worst citations
  crux citations audit existential-risk             Full audit pipeline for one page
  crux citations audit existential-risk --apply     Audit and auto-fix one page
`;
}
