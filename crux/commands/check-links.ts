/**
 * Check-Links Command Handler
 *
 * Runs the link rot detection script as a CLI domain.
 * Delegates to crux/check-links.ts via subprocess.
 */

import type { CommandResult } from '../lib/cli.ts';
import { runScript, optionsToArgs } from '../lib/cli.ts';

const PASSTHROUGH_OPTIONS = [
  'source',
  'report',
  'fix',
  'limit',
  'verbose',
  'clear-cache',
  'clearCache',
];

async function runCheckLinks(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const quiet = options.ci || options.json;

  const optionArgs = optionsToArgs(options, ['help']);
  const filteredArgs = optionArgs.filter((arg: string) => {
    const key = arg.replace(/^--/, '').split('=')[0];
    const camelKey = key.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    return PASSTHROUGH_OPTIONS.includes(camelKey) || PASSTHROUGH_OPTIONS.includes(key);
  });

  const result = await runScript('link-checker/index.ts', filteredArgs, {
    streamOutput: !quiet,
  });

  if (quiet) {
    return { output: result.stdout, exitCode: result.code };
  }

  return { output: '', exitCode: result.code };
}

export const commands: Record<
  string,
  (args: string[], options: Record<string, unknown>) => Promise<CommandResult>
> = {
  default: runCheckLinks,
  check: runCheckLinks,
};

export function getHelp(): string {
  return `
Check-Links Domain - External URL health checking

Usage:
  crux check-links                         Check all URLs across all sources
  crux check-links --source=resources      Only check data/resources/*.yaml
  crux check-links --source=external       Only check data/external-links.yaml
  crux check-links --source=content        Only check MDX content URLs
  crux check-links --report                Generate JSON report
  crux check-links --fix                   Suggest archive.org replacements

Options:
  --source=<type>   Filter by source: resources, external, content, all (default: all)
  --report          Generate JSON report to .cache/link-check-report.json
  --fix             Query archive.org for dead links and suggest replacements
  --limit=<n>       Limit number of URLs to check (for testing)
  --verbose         Show detailed per-URL output
  --clear-cache     Clear the link check cache before running

Examples:
  crux check-links --limit=100             Quick test with 100 URLs
  crux check-links --source=resources --report --fix
  crux check-links --verbose               Detailed output for all checks
`;
}
