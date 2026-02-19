/**
 * Facts Command Handlers
 *
 * Propose and apply new canonical fact entries from wiki page content (Pass 2),
 * and wrap derived quantities with <Calc> components (Pass 3).
 *
 * Usage:
 *   crux facts extract <page-id>             Analyze page, propose facts (dry run)
 *   crux facts extract <page-id> --apply     Write proposed facts to YAML
 *   crux facts extract --all [--report]      Scan all knowledge-base pages
 *
 *   crux facts calc <page-id>                Preview Calc replacements (dry run)
 *   crux facts calc <page-id> --apply        Write changes to MDX file
 *   crux facts calc --all [--limit=N]        Run across multiple pages
 *
 * Part of issues #202 (Pass 2: Fact Extraction) and #203 (Pass 3: Calc Derivation).
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  extract: {
    script: 'facts/extract-facts.ts',
    description: 'Propose new canonical facts from page content',
    passthrough: ['apply', 'all', 'report', 'limit', 'json', 'ci'],
    positional: true,
  },
  calc: {
    script: 'facts/calc-derive.ts',
    description: 'Wrap derived quantities with <Calc> expressions',
    passthrough: ['apply', 'all', 'limit', 'json', 'ci'],
    positional: true,
  },
};

export const commands = buildCommands(SCRIPTS, 'extract');

export function getHelp(): string {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(12)} ${config.description}`)
    .join('\n');

  return `
Facts Domain - Propose new canonical facts and wrap derived quantities

Commands:
${commandList}

Options (extract):
  --apply           Write proposed facts to data/facts/<entity>.yaml
  --all             Scan all knowledge-base pages (default limit: 20)
  --report          Print summary report after scanning (with --all)
  --limit=N         Override page limit for --all (default: 20)
  --json            JSON output

Options (calc):
  --apply           Write <Calc> replacements to MDX files
  --all             Scan all knowledge-base pages (default limit: 10)
  --limit=N         Override page limit for --all (default: 10)

Examples:
  crux facts extract openai                    Propose facts for openai.mdx (dry run)
  crux facts extract openai --apply            Write proposed facts to data/facts/openai.yaml
  crux facts extract anthropic --apply         Extract facts from anthropic.mdx
  crux facts extract --all --report            Scan all pages, show summary
  crux facts extract --all --limit=5 --apply   Process top 5 pages and apply

  crux facts calc anthropic-valuation          Preview <Calc> replacements (dry run)
  crux facts calc anthropic-valuation --apply  Apply replacements to anthropic-valuation.mdx
  crux facts calc --all --limit=5 --apply      Process top 5 pages
`;
}
