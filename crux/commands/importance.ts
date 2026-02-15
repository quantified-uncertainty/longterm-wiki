/**
 * Importance Command Handlers
 *
 * Manage importance rankings — ordered lists of pages from which 0-100 scores
 * are derived. Two dimensions:
 *   - readership: How important is this page for readers? (default)
 *   - research:   How much value would deeper investigation yield?
 */

import type { ScriptConfig, CommandResult } from '../lib/cli.ts';
import { buildCommands } from '../lib/cli.ts';

const SCRIPTS: Record<string, ScriptConfig> = {
  show: {
    script: 'importance/show.ts',
    description: 'Show current importance rankings',
    passthrough: ['ci', 'top', 'unranked', 'dimension'],
  },
  sync: {
    script: 'importance/sync.ts',
    description: 'Derive 0-100 scores from rankings and write to frontmatter',
    passthrough: ['ci', 'apply'],
  },
  rank: {
    script: 'importance/rank.ts',
    description: 'Use LLM to place page(s) in the ranking via comparison',
    passthrough: ['ci', 'batch', 'auto', 'dimension'],
    positional: true,
  },
  seed: {
    script: 'importance/seed.ts',
    description: 'Bootstrap ranking from existing importance scores',
    passthrough: ['ci', 'apply'],
  },
  rerank: {
    script: 'importance/rerank.ts',
    description: 'Sort pages by importance using LLM judgment',
    passthrough: ['ci', 'apply', 'sample', 'all', 'model', 'dimension', 'verify'],
    positional: true,
  },
};

export const commands: Record<
  string,
  (args: string[], options: Record<string, unknown>) => Promise<CommandResult>
> = buildCommands(SCRIPTS, 'show');

export function getHelp(): string {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(10)} ${config.description}`)
    .join('\n');

  return `
Importance Domain - Ranking-based importance scoring

Two ranking dimensions:
  readership (default) — How important is this page for readers?
  research             — How much value would deeper investigation yield?

Rankings are ordered lists of page IDs (most important first).
Scores (0-100) are derived from position and written to frontmatter.

Commands:
${commandList}

Workflow:
  1. crux importance rerank --all --apply                       # Readership ranking
  2. crux importance rerank --dimension=research --all --apply  # Research ranking
  3. crux importance show --top=30                              # Review readership
  4. crux importance show --dimension=research --top=30         # Review research
  5. crux importance sync --apply                               # Write both to frontmatter

Files:
  data/importance-ranking.yaml   Readership ranking
  data/research-ranking.yaml     Research importance ranking

Options:
  --dimension=<d>   Ranking dimension: readership (default) or research
  --top=<n>         Show top N pages (show)
  --unranked        Also list unranked pages (show)
  --batch=<n>       Rank N unranked pages (rank)
  --sample=<n>      Test with N diverse pages (rerank)
  --all             Rerank all pages (rerank)
  --verify          Fix local inversions in existing ranking (rerank)
  --model=<m>       Model: haiku (default) or sonnet (rerank)
  --apply           Write changes

Examples:
  crux importance show --top=20
  crux importance show --dimension=research --top=20
  crux importance rerank --sample=20
  crux importance rerank --dimension=research --sample=20
  crux importance rerank --all --apply
  crux importance rerank --verify --apply
  crux importance sync --apply
`;
}
