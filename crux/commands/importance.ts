/**
 * Importance Command Handlers
 *
 * Manage the importance ranking — an ordered list of pages sorted by
 * importance to AI safety, from which 0-100 scores are derived.
 */

import type { ScriptConfig, CommandResult } from '../lib/cli.ts';
import { buildCommands } from '../lib/cli.ts';

const SCRIPTS: Record<string, ScriptConfig> = {
  show: {
    script: 'importance/show.ts',
    description: 'Show current importance rankings',
    passthrough: ['ci', 'top', 'unranked'],
  },
  sync: {
    script: 'importance/sync.ts',
    description: 'Derive 0-100 scores from ranking and write to frontmatter',
    passthrough: ['ci', 'apply'],
  },
  rank: {
    script: 'importance/rank.ts',
    description: 'Use LLM to place page(s) in the ranking via comparison',
    passthrough: ['ci', 'batch', 'auto'],
    positional: true,
  },
  seed: {
    script: 'importance/seed.ts',
    description: 'Bootstrap ranking from existing importance scores',
    passthrough: ['ci', 'apply'],
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

The importance ranking is an ordered list of page IDs (most important first).
Numeric 0-100 importance scores are derived from position in this list.

Commands:
${commandList}

Workflow:
  1. crux importance seed --apply         Bootstrap from existing scores
  2. crux importance rank --batch=20      Refine with LLM comparisons
  3. crux importance show --top=30        Review the ranking
  4. crux importance sync --apply         Write scores to frontmatter

You can also manually edit data/importance-ranking.yaml to reorder pages.

Options:
  --top=<n>       Show top N pages (show)
  --unranked      Also list unranked pages (show)
  --batch=<n>     Rank N unranked pages (rank)
  --apply         Write changes (sync, seed)

Examples:
  crux importance show --top=20
  crux importance show --unranked
  crux importance rank existential-risk
  crux importance rank --batch=50
  crux importance sync --apply
  crux importance seed --apply
`;
}
