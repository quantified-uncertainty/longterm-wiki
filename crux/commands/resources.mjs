/**
 * Resources Command Handlers
 *
 * Unified interface for resource management (wraps resource-manager.mjs).
 */

import { createLogger } from '../lib/output.ts';
import { runScript, optionsToArgs } from '../lib/cli.ts';

/**
 * Command definitions (maps to resource-manager.mjs subcommands)
 */
const COMMANDS = {
  list: {
    description: 'List pages with unconverted links',
    passthrough: ['limit', 'json'],
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
};

/**
 * Create a command handler
 */
function createCommandHandler(name, config) {
  return async function (args, options) {
    const log = createLogger(options.ci || options.json);

    // Build the command args
    const cmdArgs = [name];

    // Add positional args
    if (config.positional) {
      const positionals = args.filter((a) => !a.startsWith('-'));
      cmdArgs.push(...positionals);
    }

    // Add passthrough options
    const optionArgs = optionsToArgs(options, ['help']);
    const filteredArgs = optionArgs.filter((arg) => {
      const key = arg.replace(/^--/, '').split('=')[0];
      const camelKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return config.passthrough.includes(camelKey) || config.passthrough.includes(key);
    });
    cmdArgs.push(...filteredArgs);

    const streamOutput = !options.ci && !options.json;

    const result = await runScript('resource-manager.mjs', cmdArgs, {
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
export const commands = {};
for (const [name, config] of Object.entries(COMMANDS)) {
  commands[name] = createCommandHandler(name, config);
}

// Default to list
commands.default = commands.list;

/**
 * Get help text
 */
export function getHelp() {
  const commandList = Object.entries(COMMANDS)
    .map(([name, config]) => `  ${name.padEnd(18)} ${config.description}`)
    .join('\n');

  return `
Resources Domain - External resource management

Commands:
${commandList}

Options:
  --limit=<n>       Limit results
  --batch=<n>       Batch size (metadata)
  --apply           Apply changes (process)
  --dry-run         Preview without changes
  --json            JSON output

Examples:
  crux resources list --limit 20
  crux resources show bioweapons
  crux resources process bioweapons --apply
  crux resources create "https://arxiv.org/abs/..."
  crux resources metadata arxiv --batch 50
  crux resources validate all
`;
}
