/**
 * Source-Check Orchestrator — command entry point.
 *
 * Thin wrapper: CLI parsing, argument validation, subcommand routing.
 * All logic lives in crux/lib/source-check/.
 *
 * Usage:
 *   crux source-check orchestrate --dry-run                     Preview what would be checked
 *   crux source-check orchestrate --budget=5 --limit=50         Check up to 50 items, $5 budget
 *   crux source-check orchestrate --type=fact                   Check only FactBase facts
 *   crux source-check orchestrate --type=record                 Check only structured records
 *   crux source-check orchestrate --type=entity                 Check entities via web search
 *   crux source-check orchestrate --entity-type=organization    Filter by entity type
 *   crux source-check orchestrate --source=web-search           Include web search for sourceless entities
 */

import type { CommandResult } from '../lib/command-types.ts';
import { getVerificationStats } from '../lib/wiki-server/verifications.ts';
import type { RecordType } from '../../apps/wiki-server/src/api-types.ts';
import { orchestrateCommand } from '../lib/source-check/orchestrator.ts';
import type { OrchestrateOptions } from '../lib/source-check/orchestrator-types.ts';

export { orchestrateCommand } from '../lib/source-check/orchestrator.ts';

// ── Stats command ─────────────────────────────────────────────────────

async function statsCommand(): Promise<CommandResult> {
  const response = await getVerificationStats();

  if (!response.ok) {
    return { exitCode: 1, output: `Failed to fetch stats: ${response.error}` };
  }

  const stats = response.data;
  const lines: string[] = [];
  lines.push('\x1b[1m=== Verification Stats ===\x1b[0m');
  lines.push(`Total verdicts: ${stats.total}`);
  lines.push(`Average confidence: ${(stats.avg_confidence * 100).toFixed(0)}%`);
  lines.push(`Needs recheck: ${stats.needs_recheck}`);
  lines.push('');

  lines.push('\x1b[1mBy verdict:\x1b[0m');
  for (const [verdict, cnt] of Object.entries(stats.by_verdict)) {
    const color = verdict === 'confirmed' ? '\x1b[32m' : verdict === 'contradicted' ? '\x1b[31m' : '\x1b[33m';
    lines.push(`  ${color}${verdict.padEnd(15)}\x1b[0m ${cnt}`);
  }
  lines.push('');

  lines.push('\x1b[1mBy record type:\x1b[0m');
  for (const [type, cnt] of Object.entries(stats.by_type)) {
    lines.push(`  ${type.padEnd(20)} ${cnt}`);
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Record-type subcommand routing ────────────────────────────────────

/** Map plural/singular CLI subcommand names to RecordType */
const RECORD_TYPE_MAP: Record<string, RecordType> = {
  grant: 'grant',
  grants: 'grant',
  personnel: 'personnel',
  division: 'division',
  divisions: 'division',
  'funding-program': 'funding-program',
  'funding-programs': 'funding-program',
  'funding-round': 'funding-round',
  'funding-rounds': 'funding-round',
  investment: 'investment',
  investments: 'investment',
  'equity-position': 'equity-position',
  'equity-positions': 'equity-position',
  publication: 'publication',
  publications: 'publication',
  'benchmark-result': 'benchmark-result',
  'benchmark-results': 'benchmark-result',
  'entity-event': 'entity-event',
  'entity-events': 'entity-event',
  'entity-assessment': 'entity-assessment',
  'entity-assessments': 'entity-assessment',
  'secondary-market-price': 'secondary-market-price',
  'secondary-market-prices': 'secondary-market-price',
};

/**
 * Unified verify command entry point.
 * Routes to orchestrate, stats, or record-type-specific verification.
 */
async function verifyCommand(
  args: string[],
  options: OrchestrateOptions,
): Promise<CommandResult> {
  const subcommand = args[0];

  // Stats subcommand
  if (subcommand === 'stats') {
    return statsCommand();
  }

  // sync-things subcommand (deprecated)
  if (subcommand === 'sync-things') {
    return { exitCode: 0, output: 'sync-things is no longer needed -- Things table no longer stores verdicts.' };
  }

  // orchestrate subcommand (explicit)
  if (subcommand === 'orchestrate') {
    return orchestrateCommand(args.slice(1), options);
  }

  // Record type subcommands (grants, personnel, etc.)
  const mapped = subcommand ? RECORD_TYPE_MAP[subcommand] : undefined;
  if (mapped) {
    // Route to orchestrate with --type=record and entity-type filter
    const recordOptions: OrchestrateOptions = {
      ...options,
      type: 'record',
    };
    return orchestrateCommand(args.slice(1), recordOptions);
  }

  // Default: run orchestrate
  return orchestrateCommand(args, options);
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: verifyCommand,
  orchestrate: orchestrateCommand,
  stats: statsCommand,
};

export function getHelp(): string {
  return `
Verification — verify structured data against source URLs

Usage:
  crux tb verify [options]                 Run verification across all data layers
  crux tb verify orchestrate [options]     Full orchestrated verification with prioritization
  crux tb verify stats                     Show verification coverage report
  crux tb verify grants                    Verify all grants (shorthand for --type=record)
  crux tb verify personnel                 Verify all personnel records
  crux tb verify divisions                 Verify all divisions
  crux tb verify funding-programs          Verify funding programs
  crux tb verify funding-rounds            Verify funding rounds
  crux tb verify investments               Verify investments
  crux tb verify equity-positions          Verify equity positions
  crux tb verify publications              Verify publications
  crux tb verify benchmark-results         Verify benchmark results
  crux tb verify entity-events             Verify entity events
  crux tb verify entity-assessments        Verify entity assessments
  crux tb verify secondary-market-prices   Verify secondary market prices

Options:
  --budget=N             Max dollars to spend on LLM calls (est. ~$0.01/item)
  --limit=N              Max number of items to verify
  --type=X               What to verify: fact | record | entity | all (default: all)
  --entity-type=X        Filter by entity type (organization, person, ai-model, ...)
  --entity=X             Filter by entity (org or person stableId)
  --source=X             Source mode: existing | web-search | all (default: existing)
  --concurrency=N        Number of parallel verifications (default: 5)
  --dry-run              Show what would be verified without calling LLM
  --ci                   JSON output

Priority order:
  1. Never-verified items first
  2. Items flagged needsRecheck
  3. High reader/research importance (from page data)
  4. Volatile entity types (ai-model, organization, person)
  5. Staleness (oldest verification first)

Examples:
  crux tb verify --dry-run                              Preview verification plan
  crux tb verify orchestrate --budget=5 --limit=100     Verify up to 100 items, $5 cap
  crux tb verify grants --dry-run                       Preview which grants would be checked
  crux tb verify personnel --entity=anthropic           Verify Anthropic personnel records
  crux tb verify stats                                  Show verification coverage
  crux tb verify --type=fact --entity-type=organization  Verify organization facts
  crux tb verify --type=record --limit=20               Verify 20 records
`;
}
