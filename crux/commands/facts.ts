/**
 * Facts Command Handlers
 *
 * Propose and apply new canonical fact entries from wiki page content.
 * Scans for volatile numbers that should be in data/facts/*.yaml but are not.
 *
 * Usage:
 *   crux facts extract <page-id>             Analyze page, propose facts (dry run)
 *   crux facts extract <page-id> --apply     Write proposed facts to YAML
 *   crux facts extract --all [--report]      Scan all knowledge-base pages
 *
 * Part of issue #202 (Pass 2: Fact Extraction).
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  extract: {
    script: 'facts/extract-facts.ts',
    description: 'Propose new canonical facts from page content',
    passthrough: ['apply', 'all', 'report', 'limit', 'json', 'ci'],
    positional: true,
  },
};

export const commands = buildCommands(SCRIPTS, 'extract');

export function getHelp(): string {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(12)} ${config.description}`)
    .join('\n');

  return `
Facts Domain - Propose new canonical facts from wiki page content

Commands:
${commandList}

Options:
  --apply           Write proposed facts to data/facts/<entity>.yaml
  --all             Scan all knowledge-base pages (default limit: 20)
  --report          Print summary report after scanning (with --all)
  --limit=N         Override page limit for --all (default: 20)
  --json            JSON output

Examples:
  crux facts extract openai                    Propose facts for openai.mdx (dry run)
  crux facts extract openai --apply            Write proposed facts to data/facts/openai.yaml
  crux facts extract anthropic --apply         Extract facts from anthropic.mdx
  crux facts extract --all --report            Scan all pages, show summary
  crux facts extract --all --limit=5 --apply   Process top 5 pages and apply
`;
}
