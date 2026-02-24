/**
 * Claims Command Handlers
 *
 * Extract, verify, and report on atomic factual claims from wiki pages.
 * Claims are stored in PostgreSQL for transparency display on wiki page Data tabs.
 *
 * Usage:
 *   crux claims extract <page-id>    Extract atomic claims from a page (LLM)
 *   crux claims verify <page-id>     Verify claims against citation_content full text
 *   crux claims status <page-id>     Show claim count and verification breakdown
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  extract: {
    script: 'claims/extract.ts',
    description: 'Extract atomic claims from a wiki page using LLM',
    passthrough: ['dry-run', 'model'],
    positional: true,
  },
  verify: {
    script: 'claims/verify.ts',
    description: 'Verify extracted claims against citation_content full text',
    passthrough: ['dry-run', 'model'],
    positional: true,
  },
  status: {
    script: 'claims/status.ts',
    description: 'Show claim count and verification breakdown for a page',
    passthrough: ['json'],
    positional: true,
  },
};

export const commands = buildCommands(SCRIPTS, 'status');

export function getHelp(): string {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(12)} ${config.description}`)
    .join('\n');

  return `
Claims Domain - Extract and verify atomic factual claims from wiki pages

Commands:
${commandList}

Options:
  --dry-run     Preview without storing to database
  --model=M     LLM model override (default: google/gemini-2.0-flash-001)
  --json        JSON output (status only)

Examples:
  crux claims extract kalshi                   Extract claims from the Kalshi page
  crux claims extract kalshi --dry-run         Preview without storing
  crux claims verify kalshi                    Verify claims against citation sources
  crux claims status kalshi                    Show verification breakdown
  crux claims status kalshi --json             JSON output

Workflow:
  1. crux claims extract <page-id>             Extract and store claims in PG
  2. crux claims verify <page-id>              Verify against citation_content (SQLite/PG)
  3. crux claims status <page-id>              Check coverage

Notes:
  - Extraction requires OPENROUTER_API_KEY
  - Verification reads from local SQLite (.cache/knowledge.db) first, then PG
  - Claims are stored with entityType="wiki-page" in the claims table
`;
}
