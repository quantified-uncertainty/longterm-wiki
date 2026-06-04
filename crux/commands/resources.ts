/**
 * Resources Command Handlers
 *
 * Unified interface for resource management (wraps resource-manager.ts).
 * Enrichment commands (enrich-papers, enrich-forums, fetch-all, classify, deep-enrich)
 * are implemented directly in crux/resource-enrichment/.
 */

import type { CommandResult } from '../lib/cli.ts';
import { runScript, optionsToArgs } from '../lib/cli.ts';
import { enrichPapersCommand } from '../resource-enrichment/enrich-papers.ts';
import { enrichForumsCommand } from '../resource-enrichment/enrich-forums.ts';
import { fetchAllCommand } from '../resource-enrichment/fetch-all.ts';
import { classifyCommand } from '../resource-enrichment/classify.ts';
import { deepEnrichCommand } from '../resource-enrichment/enrich.ts';
import { crossReferenceCommand } from '../resource-enrichment/cross-reference.ts';
import { fetchWaybackCommand } from '../resource-enrichment/fetch-wayback.ts';
// archive-pdfs is lazy-loaded below: it pulls in @aws-sdk/client-s3 which
// is too heavy to bundle into the worker container (the worker never
// runs archive-pdfs, only the local CLI does). Static-importing it
// breaks crux.mjs load in the worker image with ERR_MODULE_NOT_FOUND.
import { enrichCrossrefCommand } from '../resource-enrichment/enrich-crossref.ts';
import { discoverForumsCommand } from '../resource-enrichment/discover-forums.ts';
import { enrichRandDatesCommand } from '../resource-enrichment/enrich-rand-dates.ts';
import { fixResourcesCommand } from '../resource-enrichment/fix-resources.ts';

interface ResourceCommandConfig {
  description: string;
  passthrough: string[];
  positional?: boolean;
}

/**
 * Command definitions (maps to resource-manager.ts subcommands)
 */
const COMMANDS: Record<string, ResourceCommandConfig> = {
  list: {
    description: 'List pages with unconverted links',
    passthrough: ['ci', 'limit', 'json'],
  },
  show: {
    description: 'Show unconverted links in a file',
    passthrough: [],
    positional: true,
  },
  process: {
    description: 'Convert links to <R> components',
    passthrough: ['apply', 'dryRun'],
    positional: true,
  },
  create: {
    description: 'Create a resource entry from URL',
    passthrough: [],
    positional: true,
  },
  metadata: {
    description: 'Extract metadata (arxiv|forum|scholar|web|all|stats)',
    passthrough: ['batch', 'limit'],
    positional: true,
  },
  'rebuild-citations': {
    description: 'Rebuild cited_by relationships',
    passthrough: [],
  },
  validate: {
    description: 'Validate resources (all|arxiv)',
    passthrough: ['limit'],
    positional: true,
  },
  'refresh-titles': {
    description: 'Fetch real page titles and fix bad ones',
    passthrough: ['apply', 'limit', 'domain', 'verbose', 'force-all'],
  },
  'classify-stance': {
    description: 'Classify resource stance via LLM (--page=<slug>)',
    passthrough: ['apply', 'limit', 'verbose', 'page'],
  },
};

/**
 * Create a command handler
 */
function createCommandHandler(
  name: string,
  config: ResourceCommandConfig,
): (args: string[], options: Record<string, unknown>) => Promise<CommandResult> {
  return async function (args: string[], options: Record<string, unknown>): Promise<CommandResult> {
    // Build the command args
    const cmdArgs: string[] = [name];

    // Add positional args
    if (config.positional) {
      const positionals = args.filter((a: string) => !a.startsWith('-'));
      cmdArgs.push(...positionals);
    }

    // Add passthrough options
    const optionArgs = optionsToArgs(options, ['help']);
    const filteredArgs = optionArgs.filter((arg: string) => {
      const key = arg.replace(/^--/, '').split('=')[0];
      const camelKey = key.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
      return config.passthrough.includes(camelKey) || config.passthrough.includes(key);
    });
    cmdArgs.push(...filteredArgs);

    const streamOutput = !options.ci && !options.json;

    const result = await runScript('resource-manager.ts', cmdArgs, {
      streamOutput,
    });

    if (options.ci || options.json) {
      return { output: result.stdout, exitCode: result.code };
    }

    return { output: '', exitCode: result.code };
  };
}

/**
 * Generate command handlers dynamically
 */
export const commands: Record<string, (args: string[], options: Record<string, unknown>) => Promise<CommandResult>> = {};
for (const [name, config] of Object.entries(COMMANDS)) {
  commands[name] = createCommandHandler(name, config);
}

// classify-stance: direct command (not routed through resource-manager.ts)
commands['classify-stance'] = async function (args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const { classifyStance } = await import('./resources/classify-stance.ts');
  const page = (options.page as string) || args[0];
  if (!page) {
    return { output: 'Usage: pnpm crux resources classify-stance --page=<slug>\n  Options: --apply, --limit=N, --verbose', exitCode: 1 };
  }
  let limit: number | undefined;
  if (options.limit !== undefined) {
    const parsedLimit = Number(options.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      return { output: '--limit must be a positive integer', exitCode: 1 };
    }
    limit = parsedLimit;
  }

  await classifyStance({
    page,
    apply: !!options.apply,
    limit,
    verbose: !!options.verbose,
  });
  return { output: '', exitCode: 0 };
};

// Direct enrichment command handlers (not routed through resource-manager.ts)
commands['enrich-papers'] = enrichPapersCommand;
commands['enrich-forums'] = enrichForumsCommand;
commands['fetch-all'] = fetchAllCommand;
commands['classify'] = classifyCommand;
commands['deep-enrich'] = deepEnrichCommand;

commands['cross-reference'] = crossReferenceCommand;
commands['fetch-wayback'] = fetchWaybackCommand;
commands['archive-pdfs'] = async (args, options) => {
  const { archivePdfsCommand } = await import('../resource-enrichment/archive-pdfs.ts');
  return archivePdfsCommand(args, options);
};
commands['enrich-crossref'] = enrichCrossrefCommand;
commands['discover-forums'] = discoverForumsCommand;
commands['enrich-rand-dates'] = enrichRandDatesCommand;
commands['fix'] = fixResourcesCommand;

// map-publications: match resource domains to known publications
commands['map-publications'] = async function (_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const { mapPublications } = await import('./resources/map-publications.ts');
  await mapPublications({
    apply: !!options.apply,
    top: options.top !== undefined ? Number(options.top) : undefined,
    verbose: !!options.verbose,
  });
  return { output: '', exitCode: 0 };
};

// Convenience aliases
commands['enrich-free'] = async (args, options) => {
  console.log('Running all free enrichment commands...\n');
  const results = [];
  results.push(await enrichPapersCommand(args, options));
  console.log();
  results.push(await enrichForumsCommand(args, options));
  console.log();
  results.push(await fetchAllCommand(args, options));
  const maxExit = Math.max(...results.map((r) => r.exitCode ?? 0));
  return { exitCode: maxExit, output: 'Free enrichment complete' };
};

// Default to list
commands.default = commands.list;

/**
 * Get help text
 */
export function getHelp(): string {
  const commandList = Object.entries(COMMANDS)
    .map(([name, config]) => `  ${name.padEnd(18)} ${config.description}`)
    .join('\n');

  return `
Resources Domain - External resource management

Commands:
${commandList}

Discovery:
  discover-forums   Bulk import posts from LW/EAF/AF (free GraphQL API)

Publication Mapping:
  map-publications  Match resource domains to publications.yaml (--apply --top=N)

Enrichment:
  enrich-papers     Enrich papers via Semantic Scholar API (→ resource_papers)
  enrich-crossref   Enrich papers via Crossref API (fills S2 gaps, no key needed)
  enrich-forums     Enrich forum posts via LW/AF/EAF GraphQL (→ resource_forum_posts)
  fetch-all         Fetch all resource URLs and extract meta tags
  fetch-wayback     Retry failed URLs via Wayback Machine (archive.org)
  archive-pdfs      Archive PDF files to DigitalOcean Spaces
  enrich-rand-dates Fill missing dates for RAND resources (scrapes meta tags)
  enrich-free       Run all free enrichment (papers + forums + fetch)
  fix               Validate + auto-fix title/author mismatches (--apply to write)
  classify          LLM classification via Anthropic Batch API (Haiku, ~\$15)
  deep-enrich       LLM deep enrichment via Anthropic Batch API (Sonnet, ~\$100)

Options:
  --limit=<n>       Limit results
  --batch=<n>       Batch size (metadata/fetch-all)
  --apply           Apply changes (process)
  --dry-run         Preview without changes
  --json            JSON output
  --verbose         Verbose output
  --concurrency=<n> Concurrency for fetch-all (default 5)
  --batch-id=<id>   Batch ID for classify/deep-enrich status/poll/download

Examples:
  crux resources list --limit 20
  crux resources show bioweapons
  crux resources process bioweapons --apply
  crux resources create "https://arxiv.org/abs/..."
  crux resources metadata arxiv --batch 50
  crux resources validate all
  crux resources classify-stance --page=sb-1047 --apply
  crux resources enrich-papers --limit 100 --verbose
  crux resources enrich-crossref --limit 50 --verbose --dry-run
  crux resources enrich-forums --limit 200
  crux resources fetch-all --batch 50 --concurrency 5
  crux resources classify submit --dry-run
  crux resources deep-enrich submit --limit 1000
  crux resources discover-forums --karma=30 --forums=lw,eaf,af
  crux resources discover-forums --karma=50 --after=2020-01-01 --apply
`;

}
