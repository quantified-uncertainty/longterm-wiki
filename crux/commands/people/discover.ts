/**
 * People Discover Subcommand
 *
 * Find people across data sources who are not yet in people.yaml.
 */

import type { CommandResult } from '../../lib/command-types.ts';
import {
  type DiscoverCommandOptions,
  type PersonCandidate,
  discoverCandidates,
} from './shared.ts';

function formatCandidate(c: PersonCandidate): string {
  const details = c.sources
    .map((s) => `    - [${s.type}] ${s.context}`)
    .join('\n');
  return `  \x1b[1m${c.name}\x1b[0m (${c.id})  score: ${c.score}, appearances: ${c.appearances}\n${details}`;
}

export async function discoverCommand(
  _args: string[],
  options: DiscoverCommandOptions,
): Promise<CommandResult> {
  const minAppearances = options.minAppearances
    ? parseInt(options.minAppearances, 10)
    : 1;

  const candidates = discoverCandidates();

  // Filter by min appearances
  const filtered = Array.from(candidates.values())
    .filter((c) => c.appearances >= minAppearances)
    .sort((a, b) => b.score - a.score || b.appearances - a.appearances);

  if (options.json || options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify(
        {
          totalCandidates: candidates.size,
          filteredCount: filtered.length,
          minAppearances,
          candidates: filtered,
        },
        null,
        2,
      ),
    };
  }

  if (filtered.length === 0) {
    return {
      exitCode: 0,
      output:
        minAppearances > 1
          ? `No candidates found with ${minAppearances}+ appearances. Try lowering --min-appearances.`
          : 'No new person candidates found in the data.',
    };
  }

  const lines: string[] = [];
  lines.push('\x1b[1mPeople Discovery Report\x1b[0m');
  lines.push(
    `Found ${filtered.length} candidate(s) not in people.yaml (of ${candidates.size} total, min appearances: ${minAppearances})`,
  );
  lines.push('');

  // Group by score tier
  const highScore = filtered.filter((c) => c.score >= 8);
  const medScore = filtered.filter((c) => c.score >= 4 && c.score < 8);
  const lowScore = filtered.filter((c) => c.score < 4);

  if (highScore.length > 0) {
    lines.push('\x1b[32m--- High Priority (score >= 8) ---\x1b[0m');
    for (const c of highScore) {
      lines.push(formatCandidate(c));
    }
    lines.push('');
  }

  if (medScore.length > 0) {
    lines.push('\x1b[33m--- Medium Priority (score 4-7) ---\x1b[0m');
    for (const c of medScore) {
      lines.push(formatCandidate(c));
    }
    lines.push('');
  }

  if (lowScore.length > 0) {
    lines.push('\x1b[2m--- Lower Priority (score < 4) ---\x1b[0m');
    for (const c of lowScore) {
      lines.push(formatCandidate(c));
    }
    lines.push('');
  }

  lines.push(
    '\x1b[2mRun `crux people create` to generate YAML stubs for top candidates.\x1b[0m',
  );

  return { exitCode: 0, output: lines.join('\n') };
}
