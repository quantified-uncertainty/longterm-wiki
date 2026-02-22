/**
 * Enrich Command Handlers
 *
 * Standalone enrichment tools extracted from the improve pipeline.
 * These can run independently or be called from the agentic orchestrator.
 *
 * Usage:
 *   crux enrich entity-links <page-id>           Preview EntityLink insertions
 *   crux enrich entity-links <page-id> --apply   Write EntityLinks to file
 *   crux enrich entity-links --all [--limit=N]   Batch across wiki
 *
 *   crux enrich fact-refs <page-id>              Preview <F> tag insertions
 *   crux enrich fact-refs <page-id> --apply      Write <F> tags to file
 *   crux enrich fact-refs --all [--limit=N]      Batch across wiki
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  'entity-links': {
    script: 'enrich/enrich-entity-links.ts',
    description: 'Insert <EntityLink> tags for entity mentions',
    passthrough: ['apply', 'all', 'limit', 'json', 'ci'],
    positional: true,
  },
  'fact-refs': {
    script: 'enrich/enrich-fact-refs.ts',
    description: 'Wrap canonical numbers with <F> fact-ref tags',
    passthrough: ['apply', 'all', 'limit', 'json', 'ci'],
    positional: true,
  },
};

export const commands = buildCommands(SCRIPTS, 'entity-links');

export function getHelp(): string {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(14)} ${config.description}`)
    .join('\n');

  return `
Enrich Domain - Standalone enrichment tools for wiki content

Commands:
${commandList}

Options (entity-links):
  --apply           Write EntityLink insertions to MDX file
  --all             Scan all knowledge-base pages
  --limit=N         Limit pages when using --all
  --json            JSON output (one object per page)

Options (fact-refs):
  --apply           Write <F> tag insertions to MDX file
  --all             Scan all knowledge-base pages
  --limit=N         Limit pages when using --all
  --json            JSON output (one object per page)

Both tools are idempotent — running twice on the same page produces no extra changes.

Examples:
  crux enrich entity-links openai                 Preview EntityLinks for openai.mdx
  crux enrich entity-links openai --apply         Insert EntityLinks into openai.mdx
  crux enrich entity-links --all --limit=10       Preview for top 10 pages
  crux enrich entity-links --all --apply          Apply EntityLinks across wiki

  crux enrich fact-refs anthropic                 Preview <F> tags for anthropic.mdx
  crux enrich fact-refs anthropic --apply         Insert <F> tags into anthropic.mdx
  crux enrich fact-refs --all --limit=10 --apply  Apply <F> tags across 10 pages
`;
}
