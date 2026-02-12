/**
 * Content Command Handlers
 *
 * Unified interface for content management scripts.
 */

import type { ScriptConfig, CommandResult } from '../lib/cli.ts';
import { buildCommands } from '../lib/cli.ts';

/**
 * Script definitions
 */
const SCRIPTS: Record<string, ScriptConfig> = {
  improve: {
    script: 'authoring/page-improver.ts',
    description: 'Improve an existing page with AI assistance',
    passthrough: ['ci', 'tier', 'directions', 'dryRun', 'apply', 'grade', 'triage'],
    positional: true,
  },
  create: {
    script: 'authoring/page-creator.ts',
    description: 'Create a new page with research pipeline',
    passthrough: ['ci', 'tier', 'phase', 'output', 'help'],
    positional: true,
  },
  regrade: {
    script: 'authoring/regrade.ts',
    description: 'Re-grade content quality ratings',
    passthrough: ['ci', 'batch', 'dryRun'],
  },
  grade: {
    script: 'authoring/grade-by-template.ts',
    description: 'Grade pages by template compliance',
    passthrough: ['ci', 'verbose'],
  },
  'grade-content': {
    script: 'authoring/grade-content.ts',
    description: 'Grade content quality with AI (3-step pipeline)',
    passthrough: ['ci', 'batch', 'model', 'dryRun', 'skipWarnings', 'warningsOnly'],
  },
  polish: {
    script: 'authoring/post-improve.ts',
    description: 'Post-improvement cleanup and polish',
    passthrough: ['ci'],
  },
};

export const commands: Record<string, (args: string[], options: Record<string, unknown>) => Promise<CommandResult>> = buildCommands(SCRIPTS);

/**
 * Get help text
 */
export function getHelp(): string {
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
