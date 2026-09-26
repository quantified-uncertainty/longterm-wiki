/**
 * Enrich Command Handlers
 *
 * Standalone enrichment tools extracted from the improve pipeline.
 * These can run independently or be called from the agentic orchestrator.
 *
 * Usage:
 *   crux w enrich entity-links <page-id>           Preview EntityLink insertions
 *   crux w enrich entity-links <page-id> --apply   Write EntityLinks to file
 *   crux w enrich entity-links --all [--limit=N]   Batch across wiki
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  'entity-links': {
    script: 'enrich/enrich-entity-links.ts',
    description: 'Insert <EntityLink> tags for entity mentions',
    passthrough: ['apply', 'all', 'limit', 'json', 'ci'],
    positional: true,
  },
  // Note: 'fact-refs' was removed — enrichFactRefs() is a no-op since the
  // data/facts/*.yaml pipeline was retired (still called by the improve pipeline).
  // Note: 'references' was removed — References are now auto-generated at build
  // time via pageResources in build-data.mjs. The CLI command is no longer needed.
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

All tools are idempotent — running twice on the same page produces no extra changes.

Examples:
  crux w enrich entity-links openai                 Preview EntityLinks for openai.mdx
  crux w enrich entity-links openai --apply         Insert EntityLinks into openai.mdx
  crux w enrich entity-links --all --limit=10       Preview for top 10 pages
  crux w enrich entity-links --all --apply          Apply EntityLinks across wiki

Note: References are now auto-generated at build time (build-data.mjs → pageResources).
The 'crux w enrich references' command has been removed.
`;
}
