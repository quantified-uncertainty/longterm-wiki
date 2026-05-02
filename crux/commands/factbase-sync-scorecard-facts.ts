/**
 * `crux fb sync-scorecard-facts` — mirror scorecard "overall" grades into
 * FactBase YAML (QUA-865).
 *
 * Reads the latest snapshot of every scorecard source from the wiki-server
 * (`/api/scorecard-grades/all?latest=true&overall=true`) and writes a
 * managed `scorecard-grades.yaml` under each rated org's per-entity
 * directory. See `crux/lib/scorecards/factbase-mirror.ts` for the full
 * write pipeline.
 *
 * Usage:
 *   pnpm crux fb sync-scorecard-facts                # write
 *   pnpm crux fb sync-scorecard-facts --dry-run      # report only
 *   pnpm crux fb sync-scorecard-facts --json         # machine-readable
 *
 * Run from a slot or from `coord/` — wiki-server auto-prod kicks in
 * (QUA-616) so no env override is needed.
 */

import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import {
  syncScorecardFactsToYaml,
  type SyncSummary,
} from '../lib/scorecards/factbase-mirror.ts';

interface Options extends CommandOptions {
  'dry-run'?: boolean;
  dryRun?: boolean;
  json?: boolean;
  ci?: boolean;
}

export async function syncScorecardFactsCommand(
  _args: string[],
  options: Options,
): Promise<CommandResult> {
  const dryRun = Boolean(options['dry-run'] ?? options.dryRun);
  const machineReadable = Boolean(options.json ?? options.ci);

  let summary: SyncSummary;
  try {
    summary = await syncScorecardFactsToYaml({ dryRun });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, output: `\x1b[31m✗\x1b[0m ${message}\n` };
  }

  if (machineReadable) {
    return { exitCode: 0, output: JSON.stringify(summary, null, 2) + '\n' };
  }

  return { exitCode: 0, output: formatSummary(summary, dryRun) };
}

function formatSummary(summary: SyncSummary, dryRun: boolean): string {
  const lines: string[] = [];
  const verb = dryRun ? 'would write' : 'wrote';
  lines.push(
    `\x1b[1mScorecard → FactBase mirror${dryRun ? ' (dry run)' : ''}\x1b[0m`,
  );
  lines.push(`  api grades:           ${summary.apiGrades}`);
  lines.push(`  entities with grades: ${summary.entitiesWithGrades}`);
  lines.push(`  ${verb}:                ${summary.entitiesWritten}`);
  if (summary.entitiesSkippedNoFbYaml > 0) {
    lines.push(
      `  skipped (no fb yaml):  ${summary.entitiesSkippedNoFbYaml}`,
    );
  }
  if (summary.entitiesSkippedNoSlug > 0) {
    lines.push(
      `  skipped (no slug):     ${summary.entitiesSkippedNoSlug}`,
    );
  }
  if (!dryRun && summary.removed > 0) {
    lines.push(`  stale files removed:  ${summary.removed}`);
  }

  // Per-entity outcomes — show "skipped" rows so operators can see what
  // didn't get mirrored and why. Limit "written" rows to keep the output
  // readable when 50+ entities are touched.
  const skipped = summary.details.filter((d) => d.status !== 'written');
  if (skipped.length > 0) {
    lines.push('');
    lines.push('Skipped entities:');
    for (const d of skipped) {
      const reason =
        d.status === 'skipped-no-slug'
          ? `stableId ${d.stableId} not in data/entities/*.yaml`
          : `no fb-entity yaml at fb-entities/${d.slug}.yaml or fb-entities/${d.slug}/`;
      lines.push(`  - ${d.slug ?? d.stableId}: ${reason}`);
    }
  }

  if (!dryRun && summary.entitiesWritten > 0) {
    lines.push('');
    lines.push(
      `Run \`pnpm crux fb validate\` to confirm the new facts parse cleanly,`,
    );
    lines.push(
      `then commit the changes under packages/factbase/data/fb-entities/.`,
    );
  }

  return lines.join('\n') + '\n';
}

export const commands = {
  'sync-scorecard-facts': syncScorecardFactsCommand,
};
