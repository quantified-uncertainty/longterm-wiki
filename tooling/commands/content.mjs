/**
 * Content Command Handlers
 *
 * Unified interface for content management scripts.
 */

import { createLogger } from '../lib/output.mjs';
import { runScript, optionsToArgs } from '../lib/cli.mjs';

/**
 * Script definitions
 */
const SCRIPTS = {
  improve: {
    script: 'content/page-improver.mjs',
    description: 'Improve an existing page with AI assistance',
    passthrough: ['tier', 'directions', 'dryRun'],
    positional: true,
  },
  create: {
    script: 'content/page-creator.mjs',
    description: 'Create a new page with research pipeline',
    passthrough: ['tier', 'phase', 'output', 'help'],
    positional: true,
  },
  regrade: {
    script: 'content/regrade.mjs',
    description: 'Re-grade content quality ratings',
    passthrough: ['batch', 'dryRun'],
  },
  grade: {
    script: 'content/grade-by-template.mjs',
    description: 'Grade pages by template compliance',
    passthrough: ['verbose'],
  },
  'grade-content': {
    script: 'content/grade-content.mjs',
    description: 'Grade content quality with AI (3-step pipeline)',
    passthrough: ['batch', 'model', 'dryRun', 'skipWarnings', 'warningsOnly'],
  },
  polish: {
    script: 'content/post-improve.mjs',
    description: 'Post-improvement cleanup and polish',
    passthrough: [],
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

    // Add positional args (like page path or topic)
    if (config.positional) {
      const positionals = args.filter((a) => !a.startsWith('-'));
      filteredArgs.unshift(...positionals);
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

/**
 * Get help text
 */
export function getHelp() {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(14)} ${config.description}`)
    .join('\n');

  return `
Content Domain - Page management

Commands:
${commandList}

Options:
  --tier=<t>        Quality tier: polish, standard, deep (improve/create)
  --directions=<d>  Specific improvement directions (improve)
  --output=<path>   Output file path (create)
  --batch=<n>       Batch size (regrade, grade-content)
  --model=<m>       Model to use (grade-content)
  --skip-warnings   Skip Steps 1-2, just rate (grade-content)
  --warnings-only   Run Steps 1-2 only, skip rating (grade-content)
  --dry-run         Preview without changes
  --verbose         Detailed output

Examples:
  crux content improve far-ai --tier deep --directions "add recent papers"
  crux content create "SecureBio" --tier standard
  crux content regrade --batch 10
  crux content grade
  crux content grade-content --page my-page --warnings-only
  crux content grade-content --page my-page --apply
  crux content polish
`;
}
