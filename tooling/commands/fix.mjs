/**
 * Fix Command Handlers
 *
 * Unified interface for auto-fix operations.
 */

import { createLogger } from '../lib/output.mjs';
import { runScript, optionsToArgs } from '../lib/cli.mjs';

/**
 * Script definitions
 */
const SCRIPTS = {
  all: {
    script: 'auto-fix.mjs',
    description: 'Run all auto-fixers',
    passthrough: ['dryRun'],
  },
  'entity-links': {
    script: 'validate/validate-entity-links.mjs',
    description: 'Convert markdown links to EntityLink',
    passthrough: ['ci'],
    extraArgs: ['--fix'],
  },
  'cross-links': {
    script: 'fix/fix-cross-links.mjs',
    description: 'Add EntityLinks to plain text entity mentions',
    passthrough: ['apply', 'verbose', 'file'],
  },
  'broken-links': {
    script: 'fix-broken-links.mjs',
    description: 'Fix broken internal links',
    passthrough: ['dryRun'],
    extraArgs: ['--fix'],
  },
  markdown: {
    script: 'validate/validate-unified.mjs',
    description: 'Fix markdown formatting (lists, bold labels)',
    passthrough: ['ci'],
    extraArgs: ['--rules=markdown-lists,consecutive-bold-labels', '--fix'],
  },
  escaping: {
    script: 'validate/validate-unified.mjs',
    description: 'Fix escaping issues (dollars, comparisons, tildes)',
    passthrough: ['ci'],
    extraArgs: ['--rules=dollar-signs,comparison-operators,tilde-dollar', '--fix'],
  },
  dollars: {
    script: 'validate/validate-unified.mjs',
    description: 'Escape dollar signs for LaTeX',
    passthrough: ['ci'],
    extraArgs: ['--rules=dollar-signs', '--fix'],
  },
  comparisons: {
    script: 'validate/validate-unified.mjs',
    description: 'Escape comparison operators',
    passthrough: ['ci'],
    extraArgs: ['--rules=comparison-operators', '--fix'],
  },
  frontmatter: {
    script: 'validate/validate-unified.mjs',
    description: 'Fix frontmatter issues (unquoted dates)',
    passthrough: ['ci'],
    extraArgs: ['--rules=frontmatter-schema', '--fix'],
  },
  imports: {
    script: 'fix/fix-component-imports.mjs',
    description: 'Add missing component imports to MDX files',
    passthrough: ['apply', 'verbose', 'file'],
  },
};

/**
 * Create a command handler for a script
 */
function createScriptHandler(name, config) {
  return async function (args, options) {
    const log = createLogger(options.ci);

    // Build args from allowed passthrough options
    const scriptArgs = optionsToArgs(options, ['help']);
    const filteredArgs = scriptArgs.filter((arg) => {
      const key = arg.replace(/^--/, '').split('=')[0];
      const camelKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return config.passthrough.includes(camelKey) || config.passthrough.includes(key);
    });

    // Add extra args (like --fix)
    if (config.extraArgs) {
      filteredArgs.push(...config.extraArgs);
    }

    const streamOutput = !options.ci;

    const result = await runScript(config.script, filteredArgs, {
      streamOutput,
    });

    if (options.ci) {
      return { output: result.stdout, exitCode: result.code };
    }

    return { output: '', exitCode: result.code };
  };
}

/**
 * Generate command handlers dynamically
 */
export const commands = {};
for (const [name, config] of Object.entries(SCRIPTS)) {
  commands[name] = createScriptHandler(name, config);
}

// Default command
commands.default = commands.all;

/**
 * Get help text
 */
export function getHelp() {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(14)} ${config.description}`)
    .join('\n');

  return `
Fix Domain - Auto-fix operations

Commands:
${commandList}

Options:
  --dry-run       Preview changes without applying
  --ci            JSON output for CI pipelines

Examples:
  crux fix                          Run all auto-fixers
  crux fix --dry-run                Preview all fixes
  crux fix entity-links             Convert markdown links to EntityLink
  crux fix escaping                 Fix all escaping issues
  crux fix markdown                 Fix markdown formatting
  crux fix dollars                  Escape dollar signs only
`;
}
