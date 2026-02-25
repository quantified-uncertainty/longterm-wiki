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
 *   crux claims from-resource <url>  Extract claims from a URL (fetch, route, extract)
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
  'ingest-resource': {
    script: 'claims/ingest-resource.ts',
    description: 'Extract claims from an external resource and link to cited entities',
    passthrough: ['dry-run', 'model', 'entity', 'force'],
    positional: true,
  },
  'ingest-batch': {
    script: 'claims/ingest-batch.ts',
    description: 'Bulk-ingest claims from all resources with cited_by entries',
    passthrough: ['dry-run', 'model', 'entity', 'limit', 'force'],
    positional: false,
  },
  'from-resource': {
    script: 'claims/from-resource.ts',
    description: 'Extract claims from a URL — fetch, route to entities, deduplicate',
    passthrough: ['dry-run', 'model', 'entity', 'no-auto-resource', 'batch', 'limit'],
    positional: true,
  },
};

export const commands = buildCommands(SCRIPTS, 'status');

export function getHelp(): string {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(18)} ${config.description}`)
    .join('\n');

  return `
Claims Domain - Extract and verify atomic factual claims from wiki pages

Commands:
${commandList}

Options:
  --dry-run             Preview without storing to database
  --model=M             LLM model override (default: google/gemini-2.0-flash-001)
  --json                JSON output (status only)
  --entity=E            Target entity filter (ingest-resource, from-resource)
  --limit=N             Max resources/URLs to process
  --force               Re-ingest already-processed resources; clear existing claims (ingest-resource, ingest-batch)
  --batch=<file>        Process URLs from a file, one per line (from-resource)
  --no-auto-resource    Don't auto-create resource YAML for unknown URLs (from-resource)

Examples:
  crux claims extract kalshi                          Extract claims from the Kalshi page
  crux claims extract kalshi --dry-run                Preview without storing
  crux claims verify kalshi                           Verify claims against citation sources
  crux claims status kalshi                           Show verification breakdown
  crux claims status kalshi --json                    JSON output
  crux claims ingest-resource a039c6ec78c7a344        Ingest resource into its cited entities
  crux claims ingest-resource a039c6ec78c7a344 --entity=kalshi  Target specific entity
  crux claims ingest-batch --limit=10                 Ingest 10 un-ingested resources
  crux claims from-resource https://example.com/article  Extract from a URL
  crux claims from-resource https://example.com/article --entity=kalshi  Target specific entity
  crux claims from-resource https://example.com/article --dry-run  Preview extraction
  crux claims from-resource --batch urls.txt --limit=5   Batch-process URLs from file

Workflow:
  Page-centric (Phase 1):
  1. crux claims extract <page-id>     Extract claims from a wiki page
  2. crux claims verify <page-id>      Verify against citation sources
  3. crux claims status <page-id>      Check coverage

  Resource-centric (Phase 3):
  1. crux claims ingest-resource <resource-id>   Extract from a known resource
  2. crux claims ingest-batch                    Bulk-process all cited resources
  3. crux claims from-resource <url>             Extract from any URL (auto-routes)

Notes:
  - Extraction requires OPENROUTER_API_KEY or ANTHROPIC_API_KEY
  - Verification reads from local SQLite (.cache/knowledge.db) first, then PG
  - Claims are stored with entityType="wiki-page" in the claims table
  - from-resource auto-creates resource YAML entries (use --no-auto-resource to disable)
  - Deduplication runs automatically against existing claims per entity
  - Ingested resource state tracked in .cache/claims-ingest-state.json
`;
}
