/**
 * Import external AI-safety scorecards into wiki-server Postgres (QUA-698).
 *
 * Sources (FMTI lives in QUA-697 — separate command):
 *   - fli_index       FLI AI Safety Index (LLM-extracted from HTML/PDF)
 *   - saferai         SaferAI Ratings (snapshot of the live ratings site)
 *   - ailabwatch      AI Lab Watch (frozen Sept 2025)
 *   - seoul_tracker   The Midas Project Seoul Commitment Tracker
 *
 * Each adapter reads from `data/scorecards/raw/<source>/<wave>/grades.json`.
 * The fetch + extract steps that produce those files are intentionally
 * out-of-band (manual or LLM-assisted) — this command only handles the
 * pipeline from cached JSON to wiki-server. Re-runs are idempotent
 * because IDs are deterministic (`<snapshotId>|<entityId>|<dimensionSlug>`).
 *
 * Usage:
 *   pnpm crux tb import-scorecards analyze                # all sources
 *   pnpm crux tb import-scorecards analyze --source=fli_index
 *   pnpm crux tb import-scorecards sync --dry-run         # all, no writes
 *   pnpm crux tb import-scorecards sync --source=saferai
 */

import { ALL_SOURCES, getAdapter, listSourceKeys } from "../lib/scorecard-import/sources/index.ts";
import { buildOrgResolver } from "../lib/scorecard-import/org-aliases.ts";
import { analyzeSource, syncSource } from "../lib/scorecard-import/sync.ts";
import type { ScorecardSourceAdapter, ScorecardSourceKey } from "../lib/scorecard-import/types.ts";

type CommandResult = { exitCode?: number; output?: string };

function pickSources(sourceFilter?: string): ScorecardSourceAdapter[] {
  if (!sourceFilter) return [...ALL_SOURCES];
  const adapter = ALL_SOURCES.find((a) => a.source === sourceFilter);
  if (!adapter) {
    throw new Error(
      `Unknown scorecard source "${sourceFilter}". Available: ${listSourceKeys().join(", ")}`,
    );
  }
  return [adapter];
}

async function cmdAnalyze(sourceFilter?: string): Promise<CommandResult> {
  const sources = pickSources(sourceFilter);
  const ctx = buildOrgResolver();

  console.log("=== Scorecard Import Analysis ===\n");

  let allUnresolved: string[] = [];
  for (const adapter of sources) {
    const a = analyzeSource(adapter, ctx);
    const unresolvedCount = a.unresolved.length;
    const status = unresolvedCount === 0 ? "✓" : "✗";
    console.log(
      `${status} ${adapter.name} (${a.source})`,
    );
    console.log(
      `    snapshots: ${a.snapshots}  grades: ${a.grades}  orgs: ${a.uniqueOrgs}  resolved: ${a.resolved}/${a.grades}`,
    );
    if (unresolvedCount > 0) {
      console.log(`    unresolved orgs:`);
      for (const name of a.unresolved) {
        console.log(`      - ${name}`);
      }
      allUnresolved.push(...a.unresolved.map((n) => `${a.source}: ${n}`));
    }
    console.log("");
  }

  if (allUnresolved.length > 0) {
    console.log(
      `\n${allUnresolved.length} unresolved org name(s) total. Add aliases to data/scorecards/org-aliases.yaml or to the entity's aliases: block in data/entities/.`,
    );
    return { exitCode: 1 };
  }
  return { exitCode: 0 };
}

async function cmdSync(
  dryRun: boolean,
  sourceFilter: string | undefined,
  verbose: boolean,
): Promise<CommandResult> {
  const sources = pickSources(sourceFilter);
  const ctx = buildOrgResolver();

  console.log(`=== Scorecard Import Sync${dryRun ? " (dry run)" : ""} ===\n`);

  for (const adapter of sources) {
    try {
      const r = await syncSource(adapter, ctx, { dryRun, verbose });
      const verb = dryRun ? "would sync" : "synced";
      console.log(
        `✓ ${adapter.name}: ${verb} ${r.snapshots} snapshot(s), ${r.grades} grade(s)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`✗ ${adapter.name}: ${message}`);
      return { exitCode: 1 };
    }
  }

  return { exitCode: 0 };
}

async function cmdList(): Promise<CommandResult> {
  console.log("=== Scorecard Sources ===\n");
  const ctx = buildOrgResolver();
  for (const adapter of ALL_SOURCES) {
    const a = analyzeSource(adapter, ctx);
    console.log(`  ${adapter.source.padEnd(16)} ${adapter.name}`);
    console.log(
      `    ${a.snapshots} snapshot(s) on disk, ${a.grades} grade(s), ${a.unresolved.length} unresolved`,
    );
  }
  console.log("");
  return { exitCode: 0 };
}

// ---- Crux command exports ----

async function analyzeCommand(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  return cmdAnalyze((options.source as string) || undefined);
}

async function syncCommand(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options["dry-run"];
  const verbose = !!options.verbose;
  const sourceFilter = (options.source as string) || undefined;
  return cmdSync(dryRun, sourceFilter, verbose);
}

async function listCommand(
  _args: string[],
  _options: Record<string, unknown>,
): Promise<CommandResult> {
  return cmdList();
}

export const commands = {
  analyze: analyzeCommand,
  sync: syncCommand,
  list: listCommand,
  default: analyzeCommand,
};

export function getHelp(): string {
  return `
Import Scorecards — Mirror external AI-safety scorecards (QUA-698)

Commands:
  analyze              Preview snapshots, grades, and unresolved orgs
  sync                 Upsert all snapshots + grades to wiki-server
  sync --dry-run       Show what would be synced without writing
  list                 List available source adapters and on-disk state

Options:
  --source=<key>       Filter to a single source (fli_index, saferai,
                       ailabwatch, seoul_tracker)
  --verbose            Print API payloads (debug)
  --dry-run            Skip the wiki-server POST

Sources:
  ${ALL_SOURCES.map((s) => `- ${s.source.padEnd(16)} (${s.name})`).join("\n  ")}

Raw input layout:
  data/scorecards/raw/<source>/<wave-slug>/grades.json

Reruns are idempotent — IDs are derived from snapshotId + entityId +
dimensionSlug. Add new aliases to data/scorecards/org-aliases.yaml.
`;
}

export function _internalGetAdapter(source: ScorecardSourceKey) {
  return getAdapter(source);
}
