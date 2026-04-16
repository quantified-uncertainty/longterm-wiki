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
    passthrough: ['ci', 'tier', 'directions', 'dryRun', 'dry-run', 'apply', 'grade', 'no-grade', 'triage', 'skip-session-log', 'skip-enrich', 'section-level', 'engine', 'citation-gate', 'skip-citation-gate', 'skip-citation-audit', 'citation-audit-model', 'batch', 'batch-file', 'batch-budget', 'page-timeout', 'resume', 'report-file', 'no-save-artifacts', 'output', 'limit', 'openrouter', 'gap-analysis', 'api-direct', 'skip-source-gate', 'min-sources'],
    positional: true,
  },
  iterate: {
    script: 'authoring/page-iterator.ts',
    description: 'Iteratively improve a page until quality stabilizes',
    passthrough: ['tier', 'directions', 'apply', 'max-rounds', 'pages', 'gap-analysis'],
    positional: true,
  },
  create: {
    script: 'authoring/page-creator.ts',
    description: 'Create a new page with research pipeline',
    passthrough: ['ci', 'tier', 'type', 'phase', 'output', 'help', 'sourceFile', 'source-file', 'dest', 'directions', 'force', 'create-category', 'api-direct', 'apiDirect', 'engine', 'grep', 'files'],
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
  'strip-scores': {
    script: 'commands/strip-scores.ts',
    description: 'Strip scoring fields from MDX frontmatter (assessment migration)',
    passthrough: ['fields', 'apply', 'dry-run'],
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
  --engine=v2       Use agent orchestrator instead of fixed pipeline (improve, create)
  --directions=<d>  Specific improvement directions (improve)
  --output=<path>   Output file path (create)
  --batch=<n>       Batch size (regrade, grade-content)
  --model=<m>       Model to use (grade-content)
  --skip-warnings   Skip Steps 1-2, just rate (grade-content)
  --warnings-only   Run Steps 1-2 only, skip rating (grade-content)
  --unscored        Only process pages without a quality score (grade-content)
  --api-direct      Use Anthropic API directly instead of Claude CLI (create)
  --type=<t>        Page type: internal-reference (create, V1 only) / entity type filter (suggest-links)
  --grep=<pattern>  Codebase grep pattern, repeatable (create --type=internal-reference, V1 only)
  --files=<glob>    File glob to include, repeatable (create --type=internal-reference, V1 only)
  --entity=<id>     Analyze specific entity (suggest-links)
  --min-score=<n>   Minimum suggestion score, default 2 (suggest-links)
  --dry-run         Preview without changes
  --apply           Apply changes (suggest-links, improve)
  --skip-session-log  Skip auto-posting session log to wiki-server after improve --apply
  --skip-citation-gate  Allow --apply even if citation audit fails (default: gate ON) (improve)
  --skip-citation-audit  Skip citation audit phase (improve)
  --citation-audit-model Override LLM model for citation checking (improve)
  --skip-source-gate    Allow improve to proceed when research lands few usable sources (improve)
  --min-sources=N       Min usable research sources before improve runs; default standard=1 deep=3 (improve)
  --batch=id1,id2     Batch mode: comma-separated page IDs (improve, requires --engine=v2)
  --batch-file=f.txt  Batch mode: file with page IDs (improve, requires --engine=v2)
  --batch-budget=N    Stop batch when cumulative cost exceeds $N (improve)
  --page-timeout=N    Per-page timeout in seconds, default 900 (improve batch)
  --resume            Resume interrupted batch from batch-state.json (improve)
  --report-file=f.md  Write batch summary report to file (improve)
  --no-save-artifacts Skip saving intermediate artifacts to wiki-server DB (improve)
  --gap-analysis      Run claims gap analysis: inject missing verified facts as structured directions (improve)
  --dry-run           Preview batch without API calls: shows tier, cost estimates, skip reasons
  --output=plan.json  Write dry-run plan to JSON file (use with --dry-run)
  --limit=N           Max pages to preview in dry-run without --batch (default: 20)
  --openrouter        Route Claude calls through OpenRouter (improve; when Anthropic credits depleted)
  --verbose         Detailed output

Examples:
  crux w content improve far-ai --tier deep --directions "add recent papers"
  crux w content improve anthropic --engine=v2 --tier standard --apply
  crux w content create "SecureBio" --tier standard
  crux w content create "Page Creator" --type=internal-reference --grep="runPipeline" --files="crux/authoring/creator/*.ts"
  crux w content review anthropic                     # review single page
  crux w content review --batch --limit=20            # review lowest-quality pages
  crux w content regrade --batch 10
  crux w content grade
  crux w content grade-content --page my-page --warnings-only
  crux w content grade-content --page my-page --apply
  crux w content polish
  crux w content suggest-links --type=organization
  crux w content suggest-links --type=organization --min-score=3 --apply
  crux w content improve --batch=anthropic,miri,far-ai --engine=v2 --tier=standard --apply
  crux w content improve --batch-file=pages.txt --engine=v2 --batch-budget=500 --apply
  crux w content improve --engine=v2 --dry-run --limit=10            # preview 10 pages (no API calls)
  crux w content improve --batch=anthropic,miri --engine=v2 --dry-run  # preview specific pages
  crux w content improve --engine=v2 --dry-run --output=batch-plan.json  # save plan to file
  crux w content iterate anthropic --apply                              # iterate until quality stabilizes
  crux w content iterate anthropic --max-rounds=5 --tier=deep --apply   # deep iteration, up to 5 rounds
  crux w content iterate --pages=anthropic,miri,far-ai --apply          # iterate multiple pages
`;
}