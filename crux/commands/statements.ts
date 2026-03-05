/**
 * Statements Command Handlers
 *
 * Extract, verify, and review structured statements from wiki pages.
 * Statements are the successor to claims — richer structured data with
 * properties from the controlled vocabulary, typed values, and citations.
 *
 * Usage:
 *   crux statements extract <page-id> [--apply]    Extract statements from a page (LLM)
 *   crux statements verify <page-id> [--apply]     Verify statements against cited sources
 *   crux statements quality <page-id>              Coverage and quality report
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  extract: {
    script: 'statements/extract.ts',
    description: 'Extract structured statements from a wiki page using LLM',
    passthrough: ['apply', 'model', 'dry-run'],
    positional: true,
  },
  verify: {
    script: 'statements/verify.ts',
    description: 'Verify statements against cited source text',
    passthrough: ['apply', 'model', 'fetch'],
    positional: true,
  },
  quality: {
    script: 'statements/quality.ts',
    description: 'Coverage and quality report for page statements',
    passthrough: ['json'],
    positional: true,
  },
  score: {
    script: 'statements/score.ts',
    description: 'Score statements for quality across 10 dimensions',
    passthrough: ['json', 'dry-run', 'llm', 'org-type'],
    positional: true,
  },
  gaps: {
    script: 'statements/gaps.ts',
    description: 'Coverage gap analysis — which categories need more statements',
    passthrough: ['json', 'org-type'],
    positional: true,
  },
  improve: {
    script: 'statements/improve.ts',
    description: 'Generate new statements to fill coverage gaps',
    passthrough: ['json', 'dry-run', 'org-type', 'category', 'no-research', 'min-score', 'budget', 'target-coverage', 'max-iterations'],
    positional: true,
  },
};

export const commands = buildCommands(SCRIPTS, 'quality');

export function getHelp(): string {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(18)} ${config.description}`)
    .join('\n');

  return `
Statements Domain — Extract and verify structured statements from wiki pages

Commands:
${commandList}

Options:
  --apply               Write results to database (default: dry-run preview)
  --model=M             LLM model override (default: google/gemini-2.0-flash-001)
  --fetch               Fetch missing sources from web (verify only)
  --json                JSON output (quality/score/gaps/improve)
  --dry-run             Preview without storing (score/improve)
  --llm                 Use LLM for importance + clarity scoring (score only)
  --org-type=TYPE       Organization subtype (e.g., frontier-lab, safety-org)
  --category=CAT        Target a single category (improve only)
  --no-research         Skip web research (improve only)
  --min-score=N         Quality gate threshold (default: 0.5, improve only)
  --budget=N            Cost cap in USD (default: 5, improve only)
  --target-coverage=N   Target coverage score for iterative loop (improve only)
  --max-iterations=N    Max iterations for iterative loop (default: 5, improve only)

Examples:
  crux statements extract anthropic                Extract statements (dry run)
  crux statements extract anthropic --apply        Extract + store in DB
  crux statements verify anthropic --apply         Verify against sources
  crux statements quality anthropic                Coverage report
  crux statements quality anthropic --json         Machine-readable output
  crux statements score anthropic                  Score all statements (10 dimensions)
  crux statements score anthropic --dry-run        Preview scores without storing
  crux statements score anthropic --llm            Score with LLM-based importance + clarity
  crux statements gaps anthropic                   Show coverage gaps
  crux statements gaps anthropic --org-type=frontier-lab  Gaps with specific org type
  crux statements improve anthropic --org-type=frontier-lab  Generate + insert
  crux statements improve anthropic --dry-run      Preview generated statements
  crux statements improve anthropic --category=safety  Target one category
  crux statements improve anthropic --no-research  Skip web search
  crux statements improve anthropic --target-coverage=0.8 --max-iterations=3  Iterate until 80%

Workflow:
  1. crux statements extract <page-id> --apply     Extract statements from page
  2. crux statements verify <page-id> --apply      Verify against cited sources
  3. crux statements score <page-id>               Score statement quality
  4. crux statements gaps <page-id>                Identify coverage gaps
  5. crux statements improve <page-id>             Generate statements to fill gaps
  6. crux statements quality <page-id>             Review coverage and quality
`;
}
