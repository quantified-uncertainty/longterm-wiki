/**
 * Statements Command Handlers
 *
 * Extract, verify, and review structured statements from wiki pages.
 * Statements are the successor to claims — richer structured data with
 * properties from the controlled vocabulary, typed values, and citations.
 *
 * Usage:
 *   crux statements extract <page-id> [--apply]    Extract statements from a page (LLM)
 *   crux statements verify <page-id> [--apply]     Verify statements against cited sources
 *   crux statements quality <page-id>              Coverage and quality report
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  extract: {
    script: 'statements/extract.ts',
    description: 'Extract structured statements from a wiki page using LLM',
    passthrough: ['apply', 'model', 'dry-run'],
    positional: true,
  },
  verify: {
    script: 'statements/verify.ts',
    description: 'Verify statements against cited source text',
    passthrough: ['apply', 'model', 'fetch'],
    positional: true,
  },
  quality: {
    script: 'statements/quality.ts',
    description: 'Coverage and quality report for page statements',
    passthrough: ['json'],
    positional: true,
  },
  score: {
    script: 'statements/score.ts',
    description: 'Score statements for quality across 10 dimensions',
    passthrough: ['json', 'dry-run'],
    positional: true,
  },
};

export const commands = buildCommands(SCRIPTS, 'quality');

export function getHelp(): string {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(18)} ${config.description}`)
    .join('\n');

  return `
Statements Domain — Extract and verify structured statements from wiki pages

Commands:
${commandList}

Options:
  --apply               Write results to database (default: dry-run preview)
  --model=M             LLM model override (default: google/gemini-2.0-flash-001)
  --fetch               Fetch missing sources from web (verify only)
  --json                JSON output (quality/score)
  --dry-run             Preview scores without storing (score only)

Examples:
  crux statements extract anthropic                Extract statements (dry run)
  crux statements extract anthropic --apply        Extract + store in DB
  crux statements verify anthropic --apply         Verify against sources
  crux statements quality anthropic                Coverage report
  crux statements quality anthropic --json         Machine-readable output
  crux statements score anthropic                  Score all statements (10 dimensions)
  crux statements score anthropic --dry-run        Preview scores without storing

Workflow:
  1. crux statements extract <page-id> --apply     Extract statements from page
  2. crux statements verify <page-id> --apply      Verify against cited sources
  3. crux statements score <page-id>               Score statement quality
  4. crux statements quality <page-id>             Review coverage and quality
`;
}
