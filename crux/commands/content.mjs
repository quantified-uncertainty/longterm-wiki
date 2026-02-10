/**
 * Content Command Handlers
 *
 * Unified interface for content management scripts.
 */

import { buildCommands } from '../lib/cli.mjs';

/**
 * Script definitions
 */
const SCRIPTS = {
  improve: {
    script: 'authoring/page-improver.mjs',
    description: 'Improve an existing page with AI assistance',
    passthrough: ['tier', 'directions', 'dryRun'],
    positional: true,
  },
  create: {
    script: 'authoring/page-creator.mjs',
    description: 'Create a new page with research pipeline',
    passthrough: ['tier', 'phase', 'output', 'help'],
    positional: true,
  },
  regrade: {
    script: 'authoring/regrade.mjs',
    description: 'Re-grade content quality ratings',
    passthrough: ['batch', 'dryRun'],
  },
  grade: {
    script: 'authoring/grade-by-template.mjs',
    description: 'Grade pages by template compliance',
    passthrough: ['verbose'],
  },
  'grade-content': {
    script: 'authoring/grade-content.mjs',
    description: 'Grade content quality with AI (3-step pipeline)',
    passthrough: ['batch', 'model', 'dryRun', 'skipWarnings', 'warningsOnly'],
  },
  polish: {
    script: 'authoring/post-improve.mjs',
    description: 'Post-improvement cleanup and polish',
    passthrough: [],
  },
};

export const commands = buildCommands(SCRIPTS);

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
