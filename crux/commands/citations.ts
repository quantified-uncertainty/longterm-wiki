/**
 * Citations Command Handlers
 *
 * Verify, archive, and report on citation health across wiki pages.
 * Downloads cited URLs, stores metadata (title, content snippet, HTTP status),
 * and flags broken or suspicious citations.
 *
 * Usage:
 *   crux w citations verify <page-id>         Verify citations for a page
 *   crux w citations verify --all             Verify all pages with citations
 *   crux w citations status <page-id>         Show source-check status
 *   crux w citations report                   Summary across all archived pages
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
    description: 'Show citation checking status',
    passthrough: ['ci', 'json', 'broken'],
    positional: true,
  },
  report: {
    script: 'citations/citation-report.ts',
    description: 'Summary report of citation checking across all pages',
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
    description: 'Report on quote extraction and source-check coverage',
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
    passthrough: ['json', 'local-only'],
  },
  'backfill-resource-ids': {
    script: 'citations/backfill-resource-ids.ts',
    description: 'Backfill resource_id for existing citation quotes',
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
  'audit-check': {
    script: 'citations/audit-check.ts',
    description: 'Independent post-hoc check: check claims against source content',
    passthrough: ['json', 'no-fetch', 'threshold', 'model', 'delay'],
    positional: true,
  },
  'content-coverage': {
    script: 'citations/citation-content-coverage.ts',
    description: 'Show citation content coverage stats (PostgreSQL)',
    passthrough: ['json'],
  },
  'register-resources': {
    script: 'citations/register-resources.ts',
    description: 'Auto-create resource YAML entries for unregistered footnote URLs',
    passthrough: ['dry-run', 'all', 'limit', 'json'],
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
  crux w citations verify existential-risk                    Verify one page
  crux w citations verify existential-risk --content-verify  Also check claim support
  crux w citations verify --all --limit=20                   Verify top 20 pages
  crux w citations status existential-risk           Show source-check results
  crux w citations report                            Summary across all pages
  crux w citations report --broken                   List all broken citations
  crux w citations extract-quotes existential-risk   Extract quotes for a page
  crux w citations extract-quotes --all --limit=10   Batch extract quotes
  crux w citations quote-report                      Quote coverage stats
  crux w citations quote-report --broken             Show drifted/broken quotes
  crux w citations verify-quotes existential-risk    Re-verify stored quotes
  crux w citations check-accuracy existential-risk   Check claim accuracy vs sources
  crux w citations check-accuracy --all              Batch accuracy check
  crux w citations normalize-footnotes                Report footnote format issues
  crux w citations normalize-footnotes --fix          Auto-fix to [Title](URL) format
  crux w citations normalize-footnotes --fix <id>     Fix one page
  crux w citations export-dashboard                  Export data for web dashboard (prefers PG)
  crux w citations export-dashboard --local-only     Force local data only (skip wiki-server)
  crux w citations backfill-resource-ids               Backfill resource_id for existing quotes
  crux w citations backfill-resource-ids --dry-run    Preview matches without writing
  crux w citations fix-inaccuracies                   Dry-run fix proposals for all flagged
  crux w citations fix-inaccuracies --apply           Apply fixes to pages
  crux w citations fix-inaccuracies <id>              Fix one page
  crux w citations fix-inaccuracies --max-score=0.5   Only worst citations
  crux w citations audit existential-risk             Full audit pipeline for one page
  crux w citations audit existential-risk --apply     Audit and auto-fix one page
  crux w citations audit-check existential-risk       Independent check (no DB, no fixes)
  crux w citations audit-check existential-risk --no-fetch  Use cached sources only
  crux w citations audit-check existential-risk --threshold=0.9  Require 90% verified
  crux w citations audit-check existential-risk --model=google/gemini-flash-lite  Use a different model
  crux w citations audit-check existential-risk --delay=500  Slow down between LLM calls
`;
}
