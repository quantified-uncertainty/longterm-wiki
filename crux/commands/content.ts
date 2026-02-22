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
    script: 'authoring/page-improver/index.ts',
    description: 'Improve an existing page with AI assistance',
    passthrough: ['ci', 'tier', 'directions', 'dryRun', 'apply', 'grade', 'no-grade', 'triage', 'skip-session-log', 'skip-enrich', 'section-level', 'engine'],
    positional: true,
  },
  create: {
    script: 'authoring/page-creator.ts',
    description: 'Create a new page with research pipeline',
    passthrough: ['ci', 'tier', 'phase', 'output', 'help', 'sourceFile', 'source-file', 'dest', 'directions', 'force', 'create-category', 'api-direct', 'apiDirect'],
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
    script: 'authoring/grading/index.ts',
    description: 'Grade content quality with AI (3-step pipeline)',
    passthrough: ['ci', 'batch', 'model', 'dryRun', 'apply', 'parallel', 'page', 'limit', 'category', 'skipGraded', 'skipWarnings', 'warningsOnly', 'unscored', 'output'],
  },
  polish: {
    script: 'authoring/post-improve.ts',
    description: 'Post-improvement cleanup and polish',
    passthrough: ['ci'],
  },
  'suggest-links': {
    script: 'authoring/suggest-links.ts',
    description: 'Suggest relatedEntries cross-links for entities',
    passthrough: ['type', 'entity', 'minScore', 'limit', 'apply', 'json', 'ci', 'help'],
    positional: true,
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
  --tier=<t>        Quality tier: budget/standard/premium (create), polish/standard/deep (improve)
  --engine=v2       Use agent orchestrator instead of fixed pipeline (improve)
  --directions=<d>  Specific improvement directions (improve)
  --output=<path>   Output file path (create)
  --batch=<n>       Batch size (regrade, grade-content)
  --model=<m>       Model to use (grade-content)
  --skip-warnings   Skip Steps 1-2, just rate (grade-content)
  --warnings-only   Run Steps 1-2 only, skip rating (grade-content)
  --unscored        Only process pages without a quality score (grade-content)
  --api-direct      Use Anthropic API directly instead of Claude CLI (create)
  --type=<t>        Entity type filter (suggest-links)
  --entity=<id>     Analyze specific entity (suggest-links)
  --min-score=<n>   Minimum suggestion score, default 2 (suggest-links)
  --dry-run         Preview without changes
  --apply           Apply changes (suggest-links, improve)
  --skip-session-log  Skip auto-posting session log to wiki-server after improve --apply
  --verbose         Detailed output

Examples:
  crux content improve far-ai --tier deep --directions "add recent papers"
  crux content improve anthropic --engine=v2 --tier standard --apply
  crux content create "SecureBio" --tier standard
  crux content regrade --batch 10
  crux content grade
  crux content grade-content --page my-page --warnings-only
  crux content grade-content --page my-page --apply
  crux content polish
  crux content suggest-links --type=organization
  crux content suggest-links --type=organization --min-score=3 --apply
`;
}
