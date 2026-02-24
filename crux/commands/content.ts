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
    passthrough: ['ci', 'tier', 'directions', 'dryRun', 'dry-run', 'apply', 'grade', 'no-grade', 'triage', 'skip-session-log', 'skip-enrich', 'section-level', 'engine', 'citation-gate', 'skip-citation-audit', 'citation-audit-model', 'batch', 'batch-file', 'batch-budget', 'page-timeout', 'resume', 'report-file', 'no-save-artifacts', 'output', 'limit'],
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
  review: {
    script: 'authoring/page-review.ts',
    description: 'Adversarial review — find gaps in a page (~$0.50/page)',
    passthrough: ['model', 'batch', 'limit', 'help', 'ci'],
    positional: true,
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
  --citation-gate     Block --apply if citation audit pass rate < 80% (improve)
  --skip-citation-audit  Skip citation audit phase (improve)
  --citation-audit-model Override LLM model for citation verification (improve)
  --batch=id1,id2     Batch mode: comma-separated page IDs (improve, requires --engine=v2)
  --batch-file=f.txt  Batch mode: file with page IDs (improve, requires --engine=v2)
  --batch-budget=N    Stop batch when cumulative cost exceeds $N (improve)
  --page-timeout=N    Per-page timeout in seconds, default 900 (improve batch)
  --resume            Resume interrupted batch from batch-state.json (improve)
  --report-file=f.md  Write batch summary report to file (improve)
  --no-save-artifacts Skip saving intermediate artifacts to wiki-server DB (improve)
  --dry-run           Preview batch without API calls: shows tier, cost estimates, skip reasons
  --output=plan.json  Write dry-run plan to JSON file (use with --dry-run)
  --limit=N           Max pages to preview in dry-run without --batch (default: 20)
  --verbose         Detailed output

Examples:
  crux content improve far-ai --tier deep --directions "add recent papers"
  crux content improve anthropic --engine=v2 --tier standard --apply
  crux content create "SecureBio" --tier standard
  crux content review anthropic                     # review single page
  crux content review --batch --limit=20            # review lowest-quality pages
  crux content regrade --batch 10
  crux content grade
  crux content grade-content --page my-page --warnings-only
  crux content grade-content --page my-page --apply
  crux content polish
  crux content suggest-links --type=organization
  crux content suggest-links --type=organization --min-score=3 --apply
  crux content improve --batch=anthropic,miri,far-ai --engine=v2 --tier=standard --apply
  crux content improve --batch-file=pages.txt --engine=v2 --batch-budget=500 --apply
  crux content improve --engine=v2 --dry-run --limit=10            # preview 10 pages (no API calls)
  crux content improve --batch=anthropic,miri --engine=v2 --dry-run  # preview specific pages
  crux content improve --engine=v2 --dry-run --output=batch-plan.json  # save plan to file
`;
}