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
  pipeline: {
    script: 'claims/pipeline.ts',
    description: 'Run unified extract → link → verify pipeline for a page',
    passthrough: ['dry-run', 'steps', 'model'],
    positional: true,
  },
  extract: {
    script: 'claims/extract.ts',
    description: 'Extract atomic claims from a wiki page using LLM',
    passthrough: ['dry-run', 'model', 'variant', 'page-type'],
    positional: true,
  },
  verify: {
    script: 'claims/verify.ts',
    description: 'Verify extracted claims against citation_content full text',
    passthrough: ['dry-run', 'model', 'fetch'],
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
  'evaluate-baseline': {
    script: 'claims/evaluate-baseline.ts',
    description: 'Evaluate extraction quality baseline across test pages',
    passthrough: ['from-logs', 'sample', 'variant', 'openrouter'],
    positional: false,
  },
  'run-experiments': {
    script: 'claims/run-experiments.ts',
    description: 'Run Sprint 2 extraction experiments across all variants and pages',
    passthrough: ['variant', 'evaluate-only', 'sample'],
    positional: false,
  },
  audit: {
    script: 'claims/audit.ts',
    description: 'Run data integrity audit on claims DB (checks for known bug artifacts)',
    passthrough: ['json'],
    positional: false,
  },
  synthesize: {
    script: 'claims/synthesize.ts',
    description: 'LLM-based gap analysis: compare stored claims against page content',
    passthrough: ['json', 'top', 'model'],
    positional: true,
  },
  'gap-analysis': {
    script: 'claims/gap-analysis.ts',
    description: 'Fast text-based gap analysis: find missing verified facts for a page',
    passthrough: ['json'],
    positional: true,
  },
  'backfill-from-citations': {
    script: 'claims/backfill-from-citations.ts',
    description: 'Backfill claims from citation_quotes by grouping on text similarity',
    passthrough: ['dry-run', 'page-id', 'limit'],
    positional: false,
  },
  'backfill-related-entities': {
    script: 'claims/backfill-related-entities.ts',
    description: 'Scan claim text for entity names and backfill relatedEntities field',
    passthrough: ['apply', 'limit', 'entity-id'],
    positional: false,
  },
  'migrate-footnotes': {
    script: 'claims/migrate-footnotes.ts',
    description: 'Migrate numbered footnotes to DB-driven references (claim refs + citations)',
    passthrough: ['apply'],
    positional: true,
  },
  'migrate-footnotes-batch': {
    script: 'claims/migrate-footnotes-batch.ts',
    description: 'Batch-migrate numbered footnotes across all pages to DB-driven references',
    passthrough: ['apply', 'batch-size', 'entity', 'path'],
    positional: false,
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
  --steps=S             Comma-separated steps to run: extract,link,verify (pipeline only)
  --json                JSON output (status, synthesize)
  --entity=E            Target entity filter (ingest-resource, from-resource)
  --limit=N             Max resources/URLs to process (backfill-from-citations: max quotes to load)
  --page-id=P           Restrict to a single wiki page (backfill-from-citations)
  --force               Re-ingest already-processed resources; clear existing claims (ingest-resource, ingest-batch)
  --batch=<file>        Process URLs from a file, one per line (from-resource)
  --no-auto-resource    Don't auto-create resource YAML for unknown URLs (from-resource)
  --apply               Write changes to database (backfill-related-entities, migrate-footnotes; default: dry-run)
  --entity-id=E         Filter to single entity (backfill-related-entities)
  --batch-size=N        Process N pages at a time (migrate-footnotes-batch; default: all)
  --path=P              Filter pages by relative path prefix (migrate-footnotes-batch)

Examples:
  crux claims pipeline kalshi                         Run full extract → link → verify pipeline
  crux claims pipeline kalshi --dry-run               Preview pipeline without storing
  crux claims pipeline kalshi --steps=extract,link    Run only extraction and linking steps
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
  Unified pipeline (Wave 2c):
  1. crux claims pipeline <page-id>    Extract + link + verify in one command
  2. crux claims status <page-id>      Check coverage

  Page-centric (Phase 1, individual steps):
  1. crux claims extract <page-id>     Extract claims from a wiki page
  2. crux claims verify <page-id>      Verify against citation sources
  3. crux claims status <page-id>      Check coverage

  Resource-centric (Phase 3):
  1. crux claims ingest-resource <resource-id>   Extract from a known resource
  2. crux claims ingest-batch                    Bulk-process all cited resources
  3. crux claims from-resource <url>             Extract from any URL (auto-routes)

  Claims synthesis (gap analysis):
  1. crux claims gap-analysis <page-id>            Fast text-based gap analysis (no LLM cost)
  2. crux claims gap-analysis <page-id> --json     Machine-readable output
  3. crux claims synthesize <page-id>              LLM-based semantic gap analysis
  4. crux content improve <page-id> --gap-analysis --apply   Inject missing verified facts into page

  Citation backfill (Wave 2b):
  1. crux claims backfill-from-citations --dry-run        Preview what would be created
  2. crux claims backfill-from-citations                  Run against all unlinked quotes
  3. crux claims backfill-from-citations --page-id=kalshi Run for a single page

  Entity backfill (relatedEntities):
  1. crux claims backfill-related-entities                Dry-run: scan claims for entity mentions
  2. crux claims backfill-related-entities --apply        Apply changes to database
  3. crux claims backfill-related-entities --entity-id=anthropic --apply  Single entity

  Footnote migration (DB-driven references):
  1. crux claims migrate-footnotes <page-id>          Dry-run: show what would change
  2. crux claims migrate-footnotes <page-id> --apply   Rewrite MDX + create DB entries
  3. crux claims migrate-footnotes-batch               Dry-run all pages with numbered footnotes
  4. crux claims migrate-footnotes-batch --batch-size=50 --apply   Process 50 pages
  5. crux claims migrate-footnotes-batch --entity=kalshi           Single entity
  6. crux claims migrate-footnotes-batch --path=knowledge-base/    Directory filter

Notes:
  - Extraction requires OPENROUTER_API_KEY or ANTHROPIC_API_KEY
  - Verification reads from local SQLite (.cache/knowledge.db) first, then PG
  - Claims are stored with entityType="wiki-page" in the claims table
  - from-resource auto-creates resource YAML entries (use --no-auto-resource to disable)
  - Deduplication runs automatically against existing claims per entity
  - Ingested resource state tracked in .cache/claims-ingest-state.json
`;
}
