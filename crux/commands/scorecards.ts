/**
 * Scorecards Command Handlers
 *
 * Ingest external safety-scorecard data into the Phase 1 (QUA-688)
 * `scorecard_snapshots` + `scorecard_grades` PG tables.
 *
 * Usage:
 *   crux scorecards fmti ingest [--wave=WAVE] [--dry-run] [--ensure-stubs]
 *   crux scorecards list                 List configured FMTI waves
 */

import type {
  CommandOptions as BaseOptions,
  CommandResult,
} from "../lib/command-types.ts";
import {
  FMTI_WAVES,
  type FmtiWave,
} from "../lib/scorecards/fmti.ts";
import {
  ingestFmtiWaves,
  type IngestResult,
} from "../lib/scorecards/fmti-ingest.ts";

interface CommandOptions extends BaseOptions {
  wave?: string;
  dryRun?: boolean;
  ensureStubs?: boolean;
  ci?: boolean;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function listCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({ waves: FMTI_WAVES }, null, 2),
    };
  }
  const lines = [
    "FMTI Waves (Stanford CRFM):",
    "",
    ...FMTI_WAVES.map(formatWaveRow),
  ];
  return { exitCode: 0, output: lines.join("\n") };
}

function formatWaveRow(w: FmtiWave): string {
  return `  ${w.snapshotId}  ${w.publishedAt}  ${w.waveLabel}`;
}

async function fmtiCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const subcommand = args[0];
  if (subcommand === "ingest") {
    return fmtiIngestCommand(args.slice(1), options);
  }
  if (!subcommand || subcommand === "list" || subcommand === "--help") {
    return listCommand(args, options);
  }
  return {
    exitCode: 1,
    output: `Unknown subcommand: ${subcommand}\n\nUsage:\n  crux scorecards fmti list\n  crux scorecards fmti ingest [--wave=ID] [--dry-run] [--ensure-stubs]`,
  };
}

async function fmtiIngestCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const dryRun = !!options.dryRun;
  const waveId = options.wave;

  if (waveId && !FMTI_WAVES.some((w) => w.snapshotId === waveId)) {
    return {
      exitCode: 1,
      output: [
        `Unknown wave: "${waveId}"`,
        `Known waves: ${FMTI_WAVES.map((w) => w.snapshotId).join(", ")}`,
      ].join("\n"),
    };
  }

  const result = await ingestFmtiWaves({
    waveId,
    dryRun,
    ensureStubEntities: !!options.ensureStubs,
  });

  if (options.ci) {
    return { exitCode: result.errors.length ? 1 : 0, output: JSON.stringify(result, null, 2) };
  }

  return formatHumanReadable(result, dryRun);
}

function formatHumanReadable(result: IngestResult, dryRun: boolean): CommandResult {
  const lines: string[] = [];
  lines.push("FMTI Ingest");
  lines.push(dryRun ? "Mode: DRY RUN (no data synced)" : "Mode: LIVE");
  lines.push("");

  for (const w of result.waves) {
    lines.push(`--- ${w.snapshot.waveLabel} (${w.waveId}) ---`);
    lines.push(`  Published:        ${w.snapshot.publishedAt}`);
    lines.push(`  isLatest:         ${w.snapshot.isLatest ? "yes" : "no"}`);
    lines.push(`  Resolved orgs:    ${w.resolvedOrgs}`);
    if (w.unresolvedOrgs.length > 0) {
      lines.push(`  Unresolved orgs:  ${w.unresolvedOrgs.join(", ")}`);
      lines.push(
        "    (re-run with --ensure-stubs to create lightweight stub entities, or add overrides to data/scorecards/fmti-org-overrides.yaml)",
      );
    }
    lines.push(`  Grade rows:       ${w.gradeCount}`);
    for (const warning of w.warnings) {
      lines.push(`  Warning: ${warning}`);
    }
    if (!dryRun && w.syncResult) {
      lines.push(
        `  Sync: snapshot=${w.syncResult.snapshots}, grades=${w.syncResult.grades}`,
      );
      for (const e of w.syncResult.errors) {
        lines.push(`  Error: ${e}`);
      }
    }
    lines.push("");
  }

  for (const e of result.errors) {
    lines.push(`Error: ${e}`);
  }

  const exitCode =
    result.errors.length > 0 ||
    result.waves.some(
      (w) => w.syncResult && w.syncResult.errors.length > 0,
    )
      ? 1
      : 0;

  return { exitCode, output: lines.join("\n") };
}

async function defaultCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help") {
    return helpCommand(args, options);
  }
  if (subcommand === "fmti") {
    return fmtiCommand(args.slice(1), options);
  }
  if (subcommand === "list") {
    return listCommand(args, options);
  }
  return {
    exitCode: 1,
    output: `Unknown command: ${subcommand}\n\n${getHelp()}`,
  };
}

async function helpCommand(
  _args: string[],
  _options: CommandOptions,
): Promise<CommandResult> {
  return { exitCode: 0, output: getHelp() };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands = {
  fmti: fmtiCommand,
  list: listCommand,
  help: helpCommand,
  default: defaultCommand,
};

export function getHelp(): string {
  return [
    "Scorecards Ingest (QUA-688 / QUA-697)",
    "",
    "Mirror external AI-safety scorecards into scorecard_snapshots + scorecard_grades.",
    "",
    "Usage:",
    "  crux scorecards fmti list                                  Show configured FMTI waves",
    "  crux scorecards fmti ingest [options]                      Fetch + parse + sync FMTI",
    "",
    "Options for `fmti ingest`:",
    "  --wave=<id>       Restrict to one wave (default: all)",
    `                    Known: ${FMTI_WAVES.map((w) => w.snapshotId).join(", ")}`,
    "  --dry-run         Fetch + parse but skip POST /sync",
    "  --ensure-stubs    Create lightweight stub `organization` entities for",
    "                    org names that don't match an existing entity",
    "                    (off by default — produces an unresolvedOrgs report",
    "                    instead so a coverage check is non-mutating)",
    "  --ci              Emit JSON output for scripting",
    "",
    "Notes:",
    "  - Source: github.com/stanford-crfm/fmti (CC-BY-4.0)",
    "  - Edit `data/scorecards/fmti-org-overrides.yaml` to map org display",
    "    names to specific entity slugs.",
  ].join("\n");
}

