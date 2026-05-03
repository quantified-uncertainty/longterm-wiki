/**
 * TableBase Command Handlers
 *
 * Scan PG table completeness, rank enrichment tasks by impact,
 * and run LLM agents with web search to fill gaps.
 *
 * Usage:
 *   crux tb tablebase scan           Show per-table completeness scores
 *   crux tb tablebase gaps           Ranked list of missing data
 *   crux tb tablebase next-task      Single highest-impact task (JSON)
 *   crux tb tablebase improve        Run LLM agent for one task
 *   crux tb tablebase mark-done      Exclude from future picks
 *   crux tb tablebase loop           Autonomous multi-task loop
 *   crux tb tablebase sync-careers   Sync FactBase career data to personnel table
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import type { TaskType } from '../tablebase/types.ts';
import { TASK_TYPES, toSlug } from '../tablebase/types.ts';
import { summarizeRecordForManifest } from '../tablebase/manifest-record.ts';
import { truncate } from '../lib/text-utils.ts';

// Consolidated orphan domain imports
import { commands as backfillGranteeIdsCommands } from './backfill-grantee-ids.ts';
import { commands as backfillProgramIdsCommands } from './backfill-program-ids.ts';
import { commands as backfillStableIdsCommands } from './backfill-stable-ids.ts';
import { commands as backfillSourcesCommands } from './backfill-sources.ts';
import { commands as backfillYamlStableIdsCommands } from './backfill-yaml-stable-ids.ts';
import { commands as importGrantsCommands } from './import-grants.ts';
import { commands as importDivisionsCommands } from './import-divisions.ts';
import { commands as importFundingProgramsCommands } from './import-funding-programs.ts';
import { commands as dataSourcesCommands } from './data-sources.ts';
import { commands as websiteSourcesCommands } from './website-sources.ts';
import { commands as scaffoldCommands } from './tablebase-scaffold.ts';
import { commands as setupOrgCommands } from './setup-org.ts';
import { commands as tbImporterCommands } from './tb-importers/index.ts';
import { commands as systemCardsCommands } from './system-cards.ts';
import { commands as frameworksCommands } from './frameworks.ts';
import { commands as thirdPartyEvalsCommands } from './third-party-evals.ts';

interface CommandOptions extends BaseOptions {
  top?: string;
  limit?: string;
  format?: string;
  ci?: boolean;
  dryRun?: boolean;
  /** Bypass FK validation. Requires --skipEntityValidationReason. Issue #4017. */
  skipEntityValidation?: boolean;
  /** Required when --skipEntityValidation is set. */
  skipEntityValidationReason?: string;
  skipSourcing?: boolean;
  /** Required when --skipSourcing is set. Must be in SKIP_SOURCING_REASONS (QUA-730). */
  skipSourcingReason?: string;
  /** QUA-655: route supported record types through `/api/enrichment/propose` */
  viaPropose?: boolean;
  fix?: boolean;
  apply?: boolean;
  max?: string;
  budget?: string;
  taskType?: string;
  entityType?: string;
  table?: string;
  type?: string;
  description?: string;
  recordsFile?: string;
  model?: string;
  source?: string;
  entity?: string;
  persist?: boolean;
  /** QUA-552: TABLE.FIELD to fill (e.g. divisions.lead_id) */
  targetField?: string;
  /** QUA-552: path to scanner field-gap JSON report */
  fromScanReport?: string;
  /** QUA-552: dollar budget cap for the whole run */
  budgetUsd?: string;
  fields?: boolean;
}

/**
 * QUA-730: thin wrapper around the shared `checkSkipSourcingReason` helper
 * so command handlers can `if (err) return err` without dynamic-importing.
 * The actual logic lives in `crux/tablebase/skip-sourcing-reasons.ts`.
 */
async function checkSkipSourcingReason(options: CommandOptions): Promise<CommandResult | null> {
  const { checkSkipSourcingReason: check } = await import('../tablebase/skip-sourcing-reasons.ts');
  return check(options);
}

async function persistScanResults(scan: import('../tablebase/types.ts').ScanSummary): Promise<void> {
  const { randomUUID } = await import('crypto');
  const { transformScanToItems, syncScannerResults } = await import('../wiki-server/sync-scanner-results.ts');
  const { getServerUrl } = await import('../lib/wiki-server/client.ts');
  const { waitForHealthy } = await import('../wiki-server/sync-common.ts');

  const serverUrl = getServerUrl();
  if (!serverUrl) {
    console.warn('[persist] LONGTERMWIKI_SERVER_URL not set, skipping persistence');
    return;
  }

  const scanRunId = randomUUID();
  const items = transformScanToItems(scan, scanRunId);
  console.log(`\n[persist] Syncing ${items.length} scanner results (run: ${scanRunId})...`);

  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    console.warn('[persist] Server is not healthy, skipping persistence');
    return;
  }

  const result = await syncScannerResults(serverUrl, items);
  if (result.errors > 0) {
    console.warn(`[persist] Completed with ${result.errors} errors (${result.inserted} synced)`);
  } else {
    console.log(`[persist] Done: ${result.inserted} results synced`);
  }
}

async function scanCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { runFullScan, runTableScan, runFieldGapScan, FIELD_GAP_TABLES, YAML_CATALOG_TABLES } = await import('../tablebase/scanner.ts');
  const { formatScanSummary, formatFieldGapReports } = await import('../tablebase/reporter.ts');
  type FieldGapReport = import('../tablebase/types.ts').FieldGapReport;

  const topN = options.top ? parseInt(options.top as string, 10) : undefined;
  const appendFieldGaps = (base: string, reports: FieldGapReport[] | undefined) =>
    reports && reports.length > 0 ? base + '\n\n' + formatFieldGapReports(reports, { top: topN }) : base;

  // Standalone field-gap mode: skip the slower per-entity scan.
  if (options.fields && !options.table) {
    const reports = await runFieldGapScan();
    if (options.ci) {
      return { exitCode: 0, output: JSON.stringify({ fieldReports: reports, timestamp: new Date().toISOString() }, null, 2) };
    }
    return { exitCode: 0, output: formatFieldGapReports(reports, { top: topN }) };
  }

  if (options.table) {
    const tableName = options.table as string;
    const isYamlCatalog = YAML_CATALOG_TABLES.includes(tableName);
    const wantsFields = options.fields && FIELD_GAP_TABLES.includes(tableName);
    if (options.fields && !wantsFields) {
      console.warn(
        `[tablebase] --fields not supported for table '${tableName}'; ` +
        `supported: ${FIELD_GAP_TABLES.join(', ')}`,
      );
    }

    // YAML catalogs only support --fields (no per-entity PG scan).
    if (isYamlCatalog) {
      if (!wantsFields) {
        return {
          exitCode: 1,
          output: `YAML catalog '${tableName}' supports --fields only. Re-run with --fields.`,
        };
      }
      const fieldReports = await runFieldGapScan([tableName]);
      if (options.ci) {
        return { exitCode: 0, output: JSON.stringify({ fieldReports, timestamp: new Date().toISOString() }, null, 2) };
      }
      return { exitCode: 0, output: formatFieldGapReports(fieldReports, { top: topN }) };
    }

    const [result, fieldReports] = await Promise.all([
      runTableScan(tableName),
      wantsFields ? runFieldGapScan([tableName]) : Promise.resolve(undefined),
    ]);
    if (!result) {
      return { exitCode: 1, output: `Unknown table: ${tableName}` };
    }

    if (options.ci) {
      const out = fieldReports ? { ...result, fieldReports } : result;
      return { exitCode: 0, output: JSON.stringify(out, null, 2) };
    }
    const summary = { tables: [result], fieldReports, timestamp: new Date().toISOString() };
    if (options.persist) {
      await persistScanResults(summary);
    }
    return { exitCode: 0, output: appendFieldGaps(formatScanSummary(summary), fieldReports) };
  }

  // Full scan + optional field-gap, parallelized so server round-trips overlap.
  const [scan, fieldReports] = await Promise.all([
    runFullScan(),
    options.fields ? runFieldGapScan() : Promise.resolve(undefined),
  ]);
  if (fieldReports) scan.fieldReports = fieldReports;
  if (options.persist) {
    await persistScanResults(scan);
  }
  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(scan, null, 2) };
  }
  return { exitCode: 0, output: appendFieldGaps(formatScanSummary(scan), scan.fieldReports) };
}

async function gapsCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { runFullScan } = await import('../tablebase/scanner.ts');
  const { rankTasks } = await import('../tablebase/task-ranker.ts');
  const { formatGaps } = await import('../tablebase/reporter.ts');

  const scan = await runFullScan();
  const limit = options.top ? parseInt(options.top as string, 10) : options.limit ? parseInt(options.limit as string, 10) : 20;

  const taskTypes = options.taskType
    ? [options.taskType as TaskType].filter(t => TASK_TYPES.includes(t as TaskType))
    : undefined;
  const entityTypes = options.entityType ? [options.entityType as string] : undefined;

  const tasks = rankTasks(scan, { taskTypes, entityTypes, limit });

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(tasks, null, 2) };
  }
  return { exitCode: 0, output: formatGaps(tasks, { limit }) };
}

async function nextTaskCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { runFullScan } = await import('../tablebase/scanner.ts');
  const { rankTasks } = await import('../tablebase/task-ranker.ts');
  const { formatTask } = await import('../tablebase/reporter.ts');

  const scan = await runFullScan();
  const format = (options.format as string) || 'prompt';

  const taskTypes = options.taskType
    ? [options.taskType as TaskType].filter(t => TASK_TYPES.includes(t as TaskType))
    : undefined;

  const tasks = rankTasks(scan, { taskTypes, limit: 1 });

  if (tasks.length === 0) {
    return format === 'json'
      ? { exitCode: 0, output: JSON.stringify({ task: null, message: 'NO_TASKS' }) }
      : { exitCode: 0, output: 'NO_TASKS — all enrichment targets are complete or excluded.' };
  }

  if (format === 'json') {
    return { exitCode: 0, output: JSON.stringify(tasks[0], null, 2) };
  }
  return { exitCode: 0, output: formatTask(tasks[0]) };
}

async function improveCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  // QUA-552: field-level targeting modes. `--target-field` and `--from-scan-report`
  // delegate to the field-improve engine, which runs the enrichment loop filtered
  // to the task type(s) that can fill the specified field gap(s).
  if (options.targetField || options.fromScanReport) {
    return fieldImproveCommand(options);
  }

  const taskId = args.find(a => !a.startsWith('--'));
  if (!taskId) {
    return {
      exitCode: 1,
      output: [
        'Usage:',
        '  crux tb improve <task-id>                              Run one entity/task by ID',
        '  crux tb improve --target-field=TABLE.FIELD --budget-usd=N',
        '  crux tb improve --from-scan-report=PATH --budget-usd=N',
        '',
        'Common flags: --dry-run, --model=auto|haiku|sonnet|opus, --max=N, --skip-sourcing',
      ].join('\n'),
    };
  }

  const skipSourcingErr = await checkSkipSourcingReason(options);
  if (skipSourcingErr) return skipSourcingErr;

  const { findTaskById } = await import('../tablebase/loop.ts');
  const { runEnrichmentAgent } = await import('../tablebase/agent.ts');

  const task = await findTaskById(taskId);
  if (!task) {
    return { exitCode: 1, output: `Task not found: ${taskId}. Run 'crux tb tablebase gaps' to see available tasks.` };
  }

  const dryRun = !!options.dryRun;
  const model = options.model as string | undefined;
  const result = await runEnrichmentAgent(task, {
    dryRun,
    model,
    skipSourcing: !!options.skipSourcing,
    skipSourcingReason: options.skipSourcingReason,
  });

  if (!dryRun) {
    const { markTaskDone } = await import('../tablebase/task-ranker.ts');
    markTaskDone(task.id);
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result, null, 2) };
  }

  return {
    exitCode: 0,
    output: `\x1b[32m✓\x1b[0m Task ${task.id} complete: ${result.recordsCreated} records created, $${result.cost.toFixed(4)}, ${Math.round(result.durationMs / 1000)}s`,
  };
}

async function fieldImproveCommand(options: CommandOptions): Promise<CommandResult> {
  const budgetUsd = options.budgetUsd ? parseFloat(options.budgetUsd) : NaN;
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    return {
      exitCode: 1,
      output: 'Field-level improve requires --budget-usd=N (positive dollar cap).',
    };
  }

  const skipSourcingErr = await checkSkipSourcingReason(options);
  if (skipSourcingErr) return skipSourcingErr;

  const maxTasks = options.max ? parseInt(options.max, 10) : undefined;
  const model = (options.model as string | undefined) ?? 'auto';

  const { runFieldTargetedImprove, runScanReportImprove, formatFieldImproveResult } =
    await import('../tablebase/field-improve.ts');

  if (options.targetField && options.fromScanReport) {
    return {
      exitCode: 1,
      output: '--target-field and --from-scan-report are mutually exclusive. Pick one.',
    };
  }

  try {
    const result = options.targetField
      ? await runFieldTargetedImprove({
          target: options.targetField,
          budgetUsd,
          maxTasks,
          model,
          dryRun: !!options.dryRun,
          skipSourcing: !!options.skipSourcing,
          skipSourcingReason: options.skipSourcingReason,
        })
      : await runScanReportImprove({
          reportPath: options.fromScanReport as string,
          budgetUsd,
          maxTasks,
          model,
          dryRun: !!options.dryRun,
          skipSourcing: !!options.skipSourcing,
          skipSourcingReason: options.skipSourcingReason,
        });

    if (options.ci) {
      return { exitCode: 0, output: JSON.stringify(result, null, 2) };
    }

    const exitCode = result.skipped.length > 0 && result.targets.length === 0 ? 1 : 0;
    return { exitCode, output: formatFieldImproveResult(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, output: `Field improve failed: ${message}` };
  }
}

async function resolveCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const name = args.filter(a => !a.startsWith('--')).join(' ');
  if (!name) {
    return { exitCode: 1, output: 'Usage: crux tb tablebase resolve <entity name>' };
  }

  const { buildEntityMatcher, matchGrantee } = await import('../lib/grant-import/entity-matcher.ts');
  const matcher = buildEntityMatcher();

  // Try direct match
  const match = matcher.match(name);
  if (match) {
    const result = { found: true, stableId: match.stableId, slug: match.slug, name: match.name };
    return { exitCode: 0, output: options.ci ? JSON.stringify(result) : `${match.stableId}\t${match.slug}\t${match.name}` };
  }

  // Try grantee normalization
  const granteeMatch = matchGrantee(name, matcher);
  if (granteeMatch) {
    const m = matcher.match(granteeMatch);
    const result = { found: true, stableId: granteeMatch, slug: m?.slug || '', name: m?.name || name };
    return { exitCode: 0, output: options.ci ? JSON.stringify(result) : `${granteeMatch}\t${m?.slug || ''}\t${m?.name || name}` };
  }

  const result = { found: false, query: name };
  return { exitCode: 1, output: options.ci ? JSON.stringify(result) : `NOT_FOUND: "${name}"` };
}

async function submitCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const table = options.table as string;
  if (!table) {
    return { exitCode: 1, output: 'Usage: crux tb tablebase submit --table=<table> --records-file=<path>\n       echo \'[...]\' | crux tb tablebase submit --table=<table>' };
  }

  const validTables = ['personnel', 'grants', 'funding-rounds', 'investments', 'benchmark-results', 'publications', 'divisions'];
  if (!validTables.includes(table)) {
    return { exitCode: 1, output: `Invalid table: ${table}. Valid: ${validTables.join(', ')}` };
  }

  // QUA-730: --skip-sourcing requires a controlled-vocabulary reason.
  // Reuse the shared helper so submit + improve + loop all return the same
  // exit code (2) for the same misconfiguration.
  const skipSourcingErr = await checkSkipSourcingReason(options);
  if (skipSourcingErr) return skipSourcingErr;
  // Re-narrow the type — checkSkipSourcingReason guarantees the reason is
  // valid when it returns null AND skipSourcing is set.
  const skipSourcingReason = options.skipSourcing
    ? (options.skipSourcingReason!.trim() as import('../tablebase/skip-sourcing-reasons.ts').SkipSourcingReason)
    : undefined;

  // Read records from --records-file or stdin
  let recordsJson: string;
  const recordsFile = options.recordsFile as string;
  if (recordsFile) {
    const { readFileSync } = await import('fs');
    recordsJson = readFileSync(recordsFile, 'utf-8');
  } else {
    // Read from stdin (piped input)
    const chunks: Buffer[] = [];
    const stdin = process.stdin;
    if (stdin.isTTY) {
      return { exitCode: 1, output: 'No --records-file and no piped stdin. Provide records via file or pipe.' };
    }
    for await (const chunk of stdin) {
      chunks.push(chunk as Buffer);
    }
    recordsJson = Buffer.concat(chunks).toString('utf-8');
  }

  let records: Array<Record<string, unknown>>;
  try {
    records = JSON.parse(recordsJson);
    if (!Array.isArray(records)) {
      return { exitCode: 1, output: 'Records must be a JSON array' };
    }
  } catch (e: unknown) {
    return { exitCode: 1, output: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (records.length === 0) {
    return { exitCode: 0, output: 'No records to submit.' };
  }

  // Generate IDs for records missing them
  const { generateId } = await import('../lib/grant-import/id.ts');
  for (const record of records) {
    if (!record.id) {
      record.id = generateId(`${table}:${JSON.stringify(record)}:${Date.now()}`);
    }
  }

  // Submit to wiki-server
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const dryRun = !!options.dryRun;

  if (dryRun) {
    return { exitCode: 0, output: `[DRY RUN] Would submit ${records.length} records to ${table}:\n${JSON.stringify(records, null, 2)}` };
  }

  // Source-check gate: check records against their source URLs before submission.
  let recordsToSubmit = records;
  let sourcingNote = '';
  if (!options.skipSourcing) {
    const { verifyBeforeSubmit, formatPreSubmitSummary } = await import('../tablebase/pre-submit-sourcing.ts');
    const verifyResult = await verifyBeforeSubmit(table, records);
    console.log(formatPreSubmitSummary(verifyResult));

    recordsToSubmit = [...verifyResult.accepted, ...verifyResult.noSource];

    if (verifyResult.rejected.length > 0) {
      sourcingNote = ` (${verifyResult.rejected.length} rejected by sourcing)`;
    }

    if (recordsToSubmit.length === 0) {
      return {
        exitCode: 1,
        output: `All ${records.length} records were rejected by sourcing.${verifyResult.rejected.map(r => `\n  - ${r.record.id ?? '?'}: ${r.skipReason}`).join('')}`,
      };
    }
  }

  const { getTableConfig } = await import('../tablebase/table-registry.ts');
  const tableConfig = getTableConfig(table);
  if (!tableConfig) return { exitCode: 1, output: `Unknown table: ${table}` };

  const params = new URLSearchParams();
  if (options.skipEntityValidation) {
    const reason = options.skipEntityValidationReason?.trim();
    if (!reason) {
      return {
        exitCode: 1,
        output: 'Error: --skipEntityValidation requires --skipEntityValidationReason="<why>" (issue #4017)',
      };
    }
    params.set('skipEntityValidation', 'true'); // skipEntityValidation-ok: CLI flag enforces reason above
    params.set('skipEntityValidationReason', reason);
  }
  if (tableConfig.requireSourcing) params.set('requireSourcing', 'true');
  if (options.skipSourcing) {
    // forceSkipSourcing bypasses server-side sourcing enforcement.
    // QUA-730: skipSourcingReason was validated by checkSkipSourcingReason() above.
    if (!skipSourcingReason) {
      // Defensive — checkSkipSourcingReason should have rejected this path. Belt + suspenders.
      return { exitCode: 2, output: 'Internal error: --skip-sourcing reached submission without a validated reason (QUA-730).' };
    }
    const { formatSkipSourcingAuditReason, formatSkipSourcingBanner } = await import('../tablebase/skip-sourcing-reasons.ts');
    params.set('forceSkipSourcing', 'true');
    params.set('reason', formatSkipSourcingAuditReason(skipSourcingReason, 'cli'));

    // Loud warning so CI logs and reviewers see what's about to ship unverified.
    console.warn(formatSkipSourcingBanner({
      source: 'cli',
      recordCount: recordsToSubmit.length,
      table,
      reason: skipSourcingReason,
    }));
  }
  const qs = params.toString();
  const syncPath = qs ? `${tableConfig.syncPath}?${qs}` : tableConfig.syncPath;
  // typed-client-ok: QUA-770 baseline — CLI command, follow-up migration to typed client tracked
  const result = await apiRequest<{ upserted?: number; updated?: number }>(
    tableConfig.syncMethod, syncPath, { [tableConfig.syncBodyKey]: recordsToSubmit },
  );

  if (!result.ok) {
    return { exitCode: 1, output: `Submit failed: ${result.message}` };
  }

  const count = result.data.upserted ?? result.data.updated ?? recordsToSubmit.length;

  // Write manifest file for PR audit trail
  const { promises: fsPromises } = await import('fs');
  const path = await import('path');
  const { PROJECT_ROOT: projRoot } = await import('../lib/content-types.ts');

  const manifestDir = path.join(projRoot, 'data', 'tablebase-manifests');
  await fsPromises.mkdir(manifestDir, { recursive: true });

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const manifestPath = path.join(manifestDir, `${dateStr}-${timeStr}-${table}.json`);

  const manifest = {
    table,
    recordCount: recordsToSubmit.length,
    recordsRejected: records.length - recordsToSubmit.length,
    submittedAt: now.toISOString(),
    sourcingSummary: {
      withSourcing: recordsToSubmit.filter((r: Record<string, unknown>) => r.sourcing).length,
      withoutSourcing: recordsToSubmit.filter((r: Record<string, unknown>) => !r.sourcing).length,
      verdicts: {
        verified: recordsToSubmit.filter((r: Record<string, unknown>) => (r.sourcing as Record<string, unknown> | undefined)?.verdict === 'confirmed').length,
        contradicted: recordsToSubmit.filter((r: Record<string, unknown>) => (r.sourcing as Record<string, unknown> | undefined)?.verdict === 'contradicted').length,
        unverifiable: recordsToSubmit.filter((r: Record<string, unknown>) => (r.sourcing as Record<string, unknown> | undefined)?.verdict === 'unverifiable').length,
        other: recordsToSubmit.filter((r: Record<string, unknown>) => {
          const v = r.sourcing as Record<string, unknown> | undefined;
          return v && !['confirmed', 'contradicted', 'unverifiable'].includes(v.verdict as string);
        }).length,
      },
    },
    records: recordsToSubmit.map((r: Record<string, unknown>) =>
      summarizeRecordForManifest(r),
    ),
  };

  await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return {
    exitCode: 0,
    output: options.ci
      ? JSON.stringify({ submitted: count, table })
      : `\x1b[32m✓\x1b[0m Submitted ${count} records to ${table}${sourcingNote}\n  Manifest: ${manifestPath}`,
  };
}

async function existingCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const table = options.table as string;
  const entityId = args.find(a => !a.startsWith('--'));

  if (!table || !entityId) {
    return { exitCode: 1, output: 'Usage: crux tb tablebase existing <entityId> --table=<table>' };
  }

  const { apiRequest } = await import('../lib/wiki-server/client.ts');

  const { getTableConfig } = await import('../tablebase/table-registry.ts');
  const tableConfig = getTableConfig(table);
  if (!tableConfig) return { exitCode: 1, output: `Invalid table: ${table}` };

  // typed-client-ok: QUA-770 baseline — CLI command, follow-up migration to typed client tracked
  const result = await apiRequest<Record<string, unknown>>('GET', `${tableConfig.fetchByEntityPath(entityId)}?limit=200`);
  if (!result.ok) {
    return { exitCode: 1, output: `Query failed: ${result.message}` };
  }

  const records = result.data[tableConfig.resultKey] as Array<Record<string, unknown>>;
  return { exitCode: 0, output: JSON.stringify(records, null, 2) };
}

async function createEntityCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const nameArgs = args.filter(a => !a.startsWith('--'));
  const name = nameArgs.join(' ');
  if (!name) {
    return { exitCode: 1, output: 'Usage: crux tb tablebase create-entity "Person Name" --type=person' };
  }

  const entityType = (options.type as string) || 'person';

  // Generate slug from name
  const slug = toSlug(name);

  // Check if entity already exists
  const { buildEntityMatcher } = await import('../lib/grant-import/entity-matcher.ts');
  const matcher = buildEntityMatcher();
  const existing = matcher.match(name);
  if (existing) {
    const result = { created: false, existing: true, stableId: existing.stableId, slug: existing.slug, name: existing.name };
    return {
      exitCode: 0,
      output: options.ci ? JSON.stringify(result) : `Already exists: ${existing.stableId}\t${existing.slug}\t${existing.name}`,
    };
  }

  // Generate a stable ID deterministically (no wikiId allocation — lightweight record)
  const { generateId } = await import('../lib/grant-import/id.ts');
  const stableId = generateId(`${entityType}:${slug}`);

  // Sync entity to wiki-server (no wikiId — not a full wiki entity)
  // Mark as stub so directory pages can exclude these reference-only entities
  const { syncEntities } = await import('../lib/wiki-server/entities.ts');
  const description = (options.description as string) || undefined;
  const syncResult = await syncEntities([{
    id: slug,
    stableId,
    entityType,
    title: name,
    ...(description && { description }),
    metadata: { stub: true },
  } as any]);

  if (!syncResult.ok) {
    return { exitCode: 1, output: `Entity sync failed: ${syncResult.message}` };
  }

  const result = { created: true, stableId, slug, name, entityType };
  return {
    exitCode: 0,
    output: options.ci ? JSON.stringify(result) : `\x1b[32m✓\x1b[0m Created ${entityType} "${name}" → ${stableId}`,
  };
}

async function fetchPageCommand(args: string[], _options: CommandOptions): Promise<CommandResult> {
  const url = args.find(a => !a.startsWith('--'));
  if (!url) {
    return { exitCode: 1, output: 'Usage: crux tb tablebase fetch-page <url>\nExtracts rendered text from a page using Playwright (handles JavaScript-rendered content).' };
  }

  const { execSync, execFileSync } = await import('child_process');
  const { writeFileSync, unlinkSync, realpathSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');

  // Write script to temp file to avoid shell injection via URL
  const scriptPath = join(tmpdir(), `tablebase-fetch-${Date.now()}.cjs`);
  const script = `
    const { chromium } = require('playwright');
    (async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(process.argv[2], { waitUntil: 'networkidle', timeout: 20000 });
      const text = await page.innerText('body');
      process.stdout.write(text);
      await browser.close();
    })().catch(e => { process.stderr.write(e.message); process.exit(1); });
  `.trim();

  writeFileSync(scriptPath, script);

  // Resolve playwright's node_modules path dynamically
  let nodePath: string | undefined;
  try {
    const playwrightPath = execFileSync('which', ['playwright'], { encoding: 'utf-8' }).trim();
    // Follow symlinks: /opt/homebrew/bin/playwright → ../lib/node_modules/playwright/...
    const resolved = realpathSync(playwrightPath);
    nodePath = resolved.replace(/\/playwright.*$/, '');
  } catch {
    // Fall back to common paths
    nodePath = '/opt/homebrew/lib/node_modules';
  }

  try {
    const { execFileSync } = await import('child_process');
    const output = execFileSync('node', [scriptPath, url], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...(nodePath && { NODE_PATH: nodePath }) },
    });
    return { exitCode: 0, output: output.toString() };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, output: `Playwright fetch failed: ${msg}\nIs Playwright installed? Run: npm i -g playwright` };
  } finally {
    try { unlinkSync(scriptPath); } catch { /* cleanup best-effort */ }
  }
}

/**
 * Build a map from FactBase array indices to correct stableIds.
 * The entity matcher previously used Object.entries() on an array of entities,
 * producing array indices ("0", "1", "108"...) as stableIds instead of the
 * actual entity ID. This mapping is used to fix records that were stored with
 * the wrong IDs.
 */
async function buildArrayIndexFixMap(): Promise<Map<string, { stableId: string; name: string }>> {
  const fs = await import('fs');
  const path = await import('path');
  const map = new Map<string, { stableId: string; name: string }>();

  try {
    const kbDataPath = path.resolve('apps/web/src/data/factbase-data.json');
    const kbData = JSON.parse(fs.readFileSync(kbDataPath, 'utf8'));
    const entities = Array.isArray(kbData.entities) ? kbData.entities : [];

    for (let i = 0; i < entities.length; i++) {
      const ent = entities[i];
      const stableId = ent.stableId || ent.id;
      if (stableId) {
        map.set(String(i), { stableId, name: ent.name || '?' });
      }
    }
  } catch {
    // If factbase-data.json is unavailable, return empty map
  }

  return map;
}

/**
 * Check whether a value looks like it was stored as a FactBase array index
 * rather than a proper stableId. Array indices are short numeric strings
 * that happen to be valid indices into the entities array.
 */
function isArrayIndex(value: string, fixMap: Map<string, { stableId: string; name: string }>): boolean {
  return /^\d+$/.test(value) && fixMap.has(value);
}

async function verifyCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { getAllPersonnel } = await import('../lib/wiki-server/personnel.ts');
  const { getEntity: getEntityFn } = await import('../lib/wiki-server/entities.ts');
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const { buildEntityMatcher } = await import('../lib/grant-import/entity-matcher.ts');
  const matcher = buildEntityMatcher();
  const arrayIndexFixes = await buildArrayIndexFixMap();

  // Fetch all personnel records
  const allPersonnel: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (true) {
    const r = await getAllPersonnel({ limit: 200, offset });
    if (!r.ok) break;
    allPersonnel.push(...(r.data.personnel as Array<Record<string, unknown>>));
    if (allPersonnel.length >= r.data.total) break;
    offset += 200;
  }

  const issues: string[] = [];
  let slugPersonIds = 0;
  let arrayIndexIds = 0;
  let unresolvedPersonIds = 0;
  let missingSource = 0;
  let duplicates = 0;
  let fixed = 0;

  const seen = new Set<string>();
  // Batch fixes to apply in one sync call
  const fixBatch: Array<Record<string, unknown>> = [];

  for (const rec of allPersonnel) {
    let pid = rec.personId as string;
    let oid = rec.organizationId as string;
    const role = rec.role as string;
    let needsFix = false;

    // Check for array-index IDs (e.g., "108" instead of "VoNqoBJkyg")
    // These were created by a bug where Object.entries() on an array produced indices as keys
    if (isArrayIndex(pid, arrayIndexFixes)) {
      const fix = arrayIndexFixes.get(pid)!;
      issues.push(`ARRAY_INDEX_PERSON: Record ${rec.id} has personId="${pid}" → should be "${fix.stableId}" (${fix.name})`);
      arrayIndexIds++;
      pid = fix.stableId;
      needsFix = true;
    }
    if (isArrayIndex(oid, arrayIndexFixes)) {
      const fix = arrayIndexFixes.get(oid)!;
      issues.push(`ARRAY_INDEX_ORG: Record ${rec.id} has organizationId="${oid}" → should be "${fix.stableId}" (${fix.name})`);
      arrayIndexIds++;
      oid = fix.stableId;
      needsFix = true;
    }

    // Check for slug-based personIds (should be stableIds)
    if (pid.includes('-')) {
      const match = matcher.match(pid);
      if (match) {
        issues.push(`SLUG_PERSON_ID: Record ${rec.id} has personId="${pid}" → stableId "${match.stableId}"`);
        slugPersonIds++;
        pid = match.stableId;
        needsFix = true;
      } else {
        const entityR = await getEntityFn(pid);
        if (entityR.ok && entityR.data.stableId) {
          issues.push(`SLUG_PERSON_ID: Record ${rec.id} has personId="${pid}" → stableId "${entityR.data.stableId}" (via server)`);
          slugPersonIds++;
          pid = entityR.data.stableId;
          needsFix = true;
        } else {
          issues.push(`UNRESOLVED_PERSON_ID: Record ${rec.id} has personId="${pid}" which doesn't resolve`);
          unresolvedPersonIds++;
        }
      }
    }

    if (needsFix && options.fix) {
      fixBatch.push({ ...rec, personId: pid, organizationId: oid });
    }

    // Check for missing dates + no confirmation note
    if (!rec.startDate && !rec.endDate) {
      const notes = (rec.notes as string) || '';
      const hasConfirmation = /confirmed|as of|per |appointed|joined|listed/i.test(notes);
      if (!hasConfirmation) {
        issues.push(`NO_DATE_INFO: Record ${rec.id} (${pid} at ${oid}, role: ${role}) has no dates and no confirmation note`);
      }
    }

    // Check for missing source
    if (!rec.source) {
      issues.push(`MISSING_SOURCE: Record ${rec.id} (${pid} at ${oid}) has no source URL`);
      missingSource++;
    }

    // Check for duplicates
    const key = `${pid}|${oid}|${role}`;
    if (seen.has(key)) {
      issues.push(`DUPLICATE: Record ${rec.id} duplicates personId=${pid}, org=${oid}, role=${role}`);
      duplicates++;
    }
    seen.add(key);
  }

  // Apply fixes in batches
  if (fixBatch.length > 0 && options.fix) {
    const BATCH_SIZE = 100;
    for (let i = 0; i < fixBatch.length; i += BATCH_SIZE) {
      const batch = fixBatch.slice(i, i + BATCH_SIZE);
      // Uses raw apiRequest instead of syncPersonnel() because this is a generic
      // data-quality fix path, not a full personnel sync. The CLI-level --fix flag
      // already enforces the reason context. See issue #4017 Phase A.
      // typed-client-ok: QUA-770 baseline — CLI command, follow-up migration to typed client tracked
      const fixR = await apiRequest<{ upserted: number }>('POST', '/api/personnel/sync?forceSkipSourcing=true&reason=verify-fix%3A+personnel+data+normalization', { items: batch });
      if (fixR.ok) {
        fixed += fixR.data.upserted;
      } else {
        issues.push(`FIX_ERROR: Batch starting at ${i} failed: ${fixR.message}`);
      }
    }
  }

  const summary = [
    `\x1b[1mTableBase Data Quality Report\x1b[0m`,
    `Total personnel records: ${allPersonnel.length}`,
    '',
    `Array-index IDs (bug fix needed): ${arrayIndexIds}`,
    `Slug-based personIds (need normalization): ${slugPersonIds}`,
    `Unresolved personIds: ${unresolvedPersonIds}`,
    `Missing source URLs: ${missingSource}`,
    `Duplicate records: ${duplicates}`,
    '',
  ];

  if (options.fix && fixed > 0) {
    summary.push(`\x1b[32m✓ Fixed ${fixed} records\x1b[0m`);
    summary.push('');
  }

  if (issues.length === 0) {
    summary.push('\x1b[32m✓ No issues found\x1b[0m');
  } else {
    summary.push(`\x1b[33m${issues.length} issue(s) found:\x1b[0m`);
    for (const issue of issues.slice(0, 30)) {
      summary.push(`  ${issue}`);
    }
    if (issues.length > 30) summary.push(`  ... and ${issues.length - 30} more`);
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify({ total: allPersonnel.length, arrayIndexIds, slugPersonIds, unresolvedPersonIds, missingSource, duplicates, fixed, issues }) };
  }

  return { exitCode: issues.length > 0 && !options.fix ? 1 : 0, output: summary.join('\n') };
}

async function prepareCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const { runFullScan } = await import('../tablebase/scanner.ts');
  const { rankTasks } = await import('../tablebase/task-ranker.ts');

  const taskTypes = options.taskType
    ? [options.taskType as TaskType].filter(t => TASK_TYPES.includes(t as TaskType))
    : undefined;

  // Get the next task (or a specific one)
  const taskId = args.find(a => !a.startsWith('--'));
  let task;
  if (taskId) {
    const { findTaskById } = await import('../tablebase/loop.ts');
    task = await findTaskById(taskId);
    if (!task) return { exitCode: 1, output: `Task not found: ${taskId}` };
  } else {
    const scan = await runFullScan();
    const tasks = rankTasks(scan, { taskTypes, limit: 1 });
    if (tasks.length === 0) return { exitCode: 0, output: 'NO_TASKS' };
    task = tasks[0];
  }

  // Get existing records
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const { getTableConfig: getTC } = await import('../tablebase/table-registry.ts');
  const taskTableConfig = getTC(task.table);

  let existingRecords: unknown[] = [];
  if (taskTableConfig) {
    // typed-client-ok: QUA-770 baseline — CLI command, follow-up migration to typed client tracked
    const r = await apiRequest<Record<string, unknown>>('GET', `${taskTableConfig.fetchByEntityPath(task.entityId)}?limit=50`);
    if (r.ok) existingRecords = (r.data[taskTableConfig.resultKey] as unknown[]) || [];
  }

  // Build search queries by task type
  const name = task.entityName;
  let searchQueries: string[];
  let submitTable: string;
  let recordFields: string;

  switch (task.taskType) {
    case 'personnel-enrichment':
      searchQueries = [
        `"${name}" leadership team CEO executive director founders`,
        `"${name}" board of directors key personnel`,
      ];
      submitTable = 'personnel';
      recordFields = `personId, organizationId ("${task.entityId}"), role, roleType (key-person|board|career), startDate, endDate, isFounder, source (REQUIRED)`;
      break;
    case 'funding-round-research':
      searchQueries = [
        `"${name}" funding round series raised valuation`,
        `"${name}" investors funding 2024 2025`,
      ];
      submitTable = 'funding-rounds';
      recordFields = `companyId ("${task.entityId}"), name (round name), date, raised (USD number), valuation, leadInvestor, instrument, source (REQUIRED)`;
      break;
    case 'investment-linking':
      searchQueries = [
        `"${name}" investment portfolio companies`,
        `"${name}" invested funding`,
      ];
      submitTable = 'investments';
      recordFields = `companyId, investorId, roundName, date, amount, role (lead|participant), source (REQUIRED)`;
      break;
    case 'benchmark-result-fill':
      searchQueries = [
        `"${name}" benchmark results MMLU HumanEval scores`,
        `"${name}" performance evaluation 2024 2025`,
      ];
      submitTable = 'benchmark-results';
      recordFields = `benchmarkId, modelId ("${task.entityId}"), score, unit, date, sourceUrl (REQUIRED)`;
      break;
    default:
      searchQueries = [`"${name}" data`];
      submitTable = task.table;
      recordFields = 'varies by table';
  }

  // Build team page URLs to try
  const teamPageUrls: string[] = [];
  if (task.website) {
    const base = task.website.replace(/\/$/, '');
    teamPageUrls.push(`${base}/team`, `${base}/about`, `${base}/about/meet-the-team`, `${base}/about-us/team`, `${base}/people`);
  }

  // Fetch divisions for this entity (if personnel task)
  const { getDivisionsByOrg } = await import('../lib/wiki-server/divisions.ts');
  let divisionsInfo = '';
  if (task.taskType === 'personnel-enrichment') {
    const divResult = await getDivisionsByOrg(task.entityId, { limit: 50 });
    if (divResult.ok && divResult.data.divisions.length > 0) {
      const divs = divResult.data.divisions.filter(d => d.status === 'active' || !d.status);
      if (divs.length > 0) {
        const divLines = divs.map(d => `- ${d.name}${d.lead ? ` (lead: ${d.lead})` : ''} [${d.divisionType}]`);
        divisionsInfo = `\n\n### Known divisions\nThis org has ${divs.length} known division(s). Look for team leads and key researchers in each:\n${divLines.join('\n')}`;
      }
    }
  }

  const output = `## Task: ${task.taskType}
**Entity**: ${task.entityName} (ID: ${task.entityId})
**Table**: ${submitTable}
**Task ID**: ${task.id}
**Existing records**: ${existingRecords.length}${task.website ? `\n**Website**: ${task.website}` : ''}

### Research strategy
${teamPageUrls.length > 0 ? `**Step 1 — Try team page** (WebFetch — most data per call):
${teamPageUrls.map(u => `- ${u}`).join('\n')}
Prompt: "List ALL team members with their full names and roles/titles."

**Step 2 — Web search** (if team page fails or for additional context):` : '**Web search:**'}
${searchQueries.map((q, i) => `${i + 1}. ${q}`).join('\n')}

### Record fields
${recordFields}

### Commands to use
\`\`\`bash
# Resolve a person/entity name to their ID:
pnpm crux tb tablebase resolve "Person Name" --ci

# If NOT_FOUND, create the entity first:
pnpm crux tb tablebase create-entity "Person Name" --type=person --ci

# Submit records (pipe JSON array):
cat <<'RECORDS' | pnpm crux tb tablebase submit --table=${submitTable}
[{"personId":"<ID>","organizationId":"${task.entityId}","role":"<ROLE>","roleType":"key-person","source":"<URL>"}]
RECORDS

# When done:
pnpm crux tb tablebase mark-done ${task.id}
\`\`\`
${existingRecords.length > 0 ? `\n### Existing records\n\`\`\`json\n${JSON.stringify(existingRecords.slice(0, 5), null, 2)}\n\`\`\`\n` : ''}${divisionsInfo}`;

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify({ task, existingRecords, searchQueries, submitTable, recordFields }) };
  }

  return { exitCode: 0, output };
}

async function ensureEntitiesCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  // Read JSON array of names from stdin
  const chunks: Buffer[] = [];
  const stdin = process.stdin;
  if (stdin.isTTY) {
    return { exitCode: 1, output: 'Usage: echo \'["Name 1","Name 2"]\' | crux tb tablebase ensure-entities --type=person' };
  }
  for await (const chunk of stdin) {
    chunks.push(chunk as Buffer);
  }
  const inputJson = Buffer.concat(chunks).toString('utf-8');

  let names: string[];
  try {
    names = JSON.parse(inputJson);
    if (!Array.isArray(names)) {
      return { exitCode: 1, output: 'Input must be a JSON array of name strings' };
    }
  } catch (e: unknown) {
    return { exitCode: 1, output: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (names.length === 0) {
    return { exitCode: 0, output: '[]' };
  }

  const entityType = (options.type as string) || 'person';
  const dryRun = !!options.dryRun;

  const { buildEntityMatcher } = await import('../lib/grant-import/entity-matcher.ts');
  const { generateId } = await import('../lib/grant-import/id.ts');
  const matcher = buildEntityMatcher();

  const results: Array<{ name: string; stableId: string; created: boolean }> = [];
  const toCreate: Array<{ slug: string; name: string; stableId: string }> = [];

  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const trimmed = name.trim();

    // Check existing
    const match = matcher.match(trimmed);
    if (match) {
      results.push({ name: trimmed, stableId: match.stableId, created: false });
      continue;
    }

    // Generate lightweight stableId (no wikiId allocation — not a full wiki entity)
    const slug = toSlug(trimmed);
    const stableId = generateId(`${entityType}:${slug}`);

    if (dryRun) {
      results.push({ name: trimmed, stableId, created: true });
      continue;
    }

    toCreate.push({ slug, name: trimmed, stableId });
    results.push({ name: trimmed, stableId, created: true });
  }

  // Batch sync all new entities (lightweight — no wikiId)
  // Mark as stub so directory pages can exclude these reference-only entities
  if (toCreate.length > 0 && !dryRun) {
    const { syncEntities } = await import('../lib/wiki-server/entities.ts');
    const syncResult = await syncEntities(toCreate.map(e => ({
      id: e.slug,
      stableId: e.stableId,
      entityType,
      title: e.name,
      metadata: { stub: true },
    })) as any);
    if (!syncResult.ok) {
      return { exitCode: 1, output: `Entity sync failed: ${syncResult.message}` };
    }
  }

  const created = results.filter(r => r.created).length;
  const existing = results.filter(r => !r.created).length;

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(results) };
  }

  const lines = results.map(r =>
    `${r.created ? '\x1b[33m+\x1b[0m' : '\x1b[32m✓\x1b[0m'} ${r.stableId}\t${r.name}`
  );
  lines.push('', `${created} created, ${existing} already existed`);
  return { exitCode: 0, output: lines.join('\n') };
}

async function markDoneCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const taskId = args.find(a => !a.startsWith('--'));
  if (!taskId) {
    return { exitCode: 1, output: 'Usage: crux tb tablebase mark-done <task-id>' };
  }

  const { markTaskDone } = await import('../tablebase/task-ranker.ts');
  markTaskDone(taskId);

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify({ marked: taskId }) };
  }
  return { exitCode: 0, output: `\x1b[32m✓\x1b[0m Marked ${taskId} as done` };
}

async function loopCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { runLoop } = await import('../tablebase/loop.ts');

  const maxTasks = options.max ? parseInt(options.max as string, 10) : 5;
  const budgetDollars = options.budget ? parseFloat(options.budget as string) : 30;
  const dryRun = !!options.dryRun;
  const model = options.model as string | undefined; // "haiku", "sonnet", "opus", or "auto"

  const taskTypes = options.taskType
    ? [options.taskType as TaskType].filter(t => TASK_TYPES.includes(t as TaskType))
    : undefined;
  const entityTypes = options.entityType ? [options.entityType as string] : undefined;

  const skipSourcingErr = await checkSkipSourcingReason(options);
  if (skipSourcingErr) return skipSourcingErr;

  const result = await runLoop({
    maxTasks,
    budgetDollars,
    dryRun,
    taskTypes,
    entityTypes,
    model,
    skipSourcing: !!options.skipSourcing,
    skipSourcingReason: options.skipSourcingReason,
    viaPropose: !!options.viaPropose,
  });

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result, null, 2) };
  }

  return {
    exitCode: 0,
    output: `Loop finished: ${result.tasksSucceeded}/${result.tasksAttempted} tasks, ${result.totalRecordsCreated} records, $${result.totalCost.toFixed(4)}, ${Math.round(result.totalDurationMs / 1000)}s (${result.stoppedReason})`,
  };
}

// ---------------------------------------------------------------------------
// sync-careers: Extract career data from FactBase and upsert to personnel table
// ---------------------------------------------------------------------------

const PERSONNEL_SYNC_BATCH_SIZE = 200;

// ---------------------------------------------------------------------------
// sourcing-records: Batch sourcing of enriched records
// ---------------------------------------------------------------------------

async function sourcingRecordsCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const { verifyRecords, formatSourcingReport } = await import('../tablebase/sourcing.ts');

  const table = options.table as string | undefined;
  if (!table) {
    return { exitCode: 1, output: 'Usage: crux tb sourcing-records --table=<personnel|funding-rounds|investments|benchmark-results> [--source=deterministic|batch|all] [--limit=N] [--model=haiku]' };
  }

  const limit = options.limit ? parseInt(options.limit as string, 10) : undefined;
  const source = (options.source as 'deterministic' | 'batch' | 'all') || 'all';
  const model = options.model as string | undefined;

  const result = await verifyRecords({ table, limit, source, model });

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result, null, 2) };
  }

  return { exitCode: 0, output: formatSourcingReport(result) };
}

async function syncCareersCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { extractAllCareers } = await import('../lib/career-import/extract.ts');
  const { apiRequest, getServerUrl } = await import('../lib/wiki-server/client.ts');
  const { getPersonnelStats: getPersonnelStatsFn } = await import('../lib/wiki-server/personnel.ts');

  const dryRun = !!options.dryRun;
  const serverUrl = getServerUrl();

  console.log('NOTE: This command syncs career data from FactBase YAML + experts.yaml only.');
  console.log('      Bulk career enrichment data is managed separately via:');
  console.log('        crux/scripts/sync-careers-to-personnel.ts + crux/scripts/career-data.json');
  console.log('      This sync is additive (upsert) and will NOT delete existing records.\n');

  console.log('Extracting career data from FactBase...');
  const { entries, stats } = extractAllCareers();

  console.log(`\nExtraction stats:`);
  console.log(`  From KB records:    ${stats.fromRecords}`);
  console.log(`  From KB facts:      ${stats.fromFacts}`);
  console.log(`  From experts.yaml:  ${stats.fromExperts}`);
  console.log(`  Before dedup:       ${stats.totalBeforeDedup}`);
  console.log(`  After dedup:        ${stats.totalAfterDedup}`);
  console.log(`  Unique persons:     ${stats.uniquePersons}`);
  console.log(`  Unique orgs:        ${stats.uniqueOrgs}`);

  if (entries.length === 0) {
    return { exitCode: 0, output: 'No career entries to sync.' };
  }

  if (dryRun) {
    console.log(`\n(dry run -- no data written)`);
    for (const e of entries.slice(0, 20)) {
      console.log(`  ${e.id}  ${e.personId} -> ${e.organizationId}  "${e.role}"  [${e.origin}]`);
    }
    if (entries.length > 20) {
      console.log(`  ... and ${entries.length - 20} more`);
    }
    return { exitCode: 0, output: `\nDry run: ${entries.length} career entries would be synced.` };
  }

  if (!serverUrl) {
    return {
      exitCode: 1,
      output: 'wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod.',
    };
  }

  // Convert CareerEntry -> personnel sync format (roleType = "career")
  // Filter out entries with unresolvable org IDs (raw names like "Fathom Radiant"
  // that didn't resolve to a stableId or slug in the entity table).
  const validEntries = entries.filter((e) => {
    const id = e.organizationId;
    // stableIds (sid_xxx) and slugs (lowercase-with-hyphens) are valid
    if (id.startsWith('sid_') || /^[a-z0-9-]+$/.test(id)) return true;
    console.warn(`  Skipping career entry ${e.id}: unresolvable organizationId "${id}"`);
    return false;
  });

  if (validEntries.length < entries.length) {
    console.log(`  Filtered: ${entries.length - validEntries.length} entries with unresolvable org IDs`);
  }

  const syncItems = validEntries.map((e) => ({
    id: e.id,
    personId: e.personId,
    organizationId: e.organizationId,
    role: e.role,
    roleType: 'career' as const,
    startDate: e.startDate,
    endDate: e.endDate,
    isFounder: e.isFounder,
    source: e.source,
    notes: e.notes,
  }));

  // Send in batches (server accepts max 500 per request)
  let totalUpserted = 0;
  const batches = Math.ceil(syncItems.length / PERSONNEL_SYNC_BATCH_SIZE);

  console.log(`\nSyncing ${syncItems.length} career entries to ${serverUrl} in ${batches} batch(es)...`);

  for (let i = 0; i < syncItems.length; i += PERSONNEL_SYNC_BATCH_SIZE) {
    const batch = syncItems.slice(i, i + PERSONNEL_SYNC_BATCH_SIZE);
    const batchNum = Math.floor(i / PERSONNEL_SYNC_BATCH_SIZE) + 1;

    // typed-client-ok: QUA-770 baseline — CLI command, follow-up migration to typed client tracked
    const result = await apiRequest<{ upserted: number }>(
      'POST',
      '/api/personnel/sync?forceSkipSourcing=true&reason=bulk-import%3A+career+data+sync+from+FactBase',
      { items: batch },
    );

    if (result.ok) {
      totalUpserted += result.data.upserted;
      console.log(`  Batch ${batchNum}/${batches}: upserted ${result.data.upserted} records`);
    } else {
      return {
        exitCode: 1,
        output: `Batch ${batchNum} failed: ${result.message}`,
      };
    }
  }

  // Show total personnel stats so users can see the full picture
  const statsResult = await getPersonnelStatsFn();

  if (statsResult.ok) {
    const { total, byRoleType } = statsResult.data;
    console.log(`\nPersonnel table totals (all sources):`);
    console.log(`  Total records:  ${total}`);
    console.log(`  Career:         ${byRoleType.career}`);
    console.log(`  Key-person:     ${byRoleType['key-person']}`);
    console.log(`  Board:          ${byRoleType.board}`);
  }

  return {
    exitCode: 0,
    output: `\nSynced ${totalUpserted} career entries to personnel table (from FactBase/experts sources).`,
  };
}

async function marketsDiscoverCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const { discoverMarkets } = await import('../tablebase/market-discovery.ts');
  const entitySlug = args[0];
  if (!entitySlug) {
    return { exitCode: 1, output: 'Usage: crux tb markets-discover <entity-slug-or-stableId>' };
  }
  return discoverMarkets(entitySlug, {
    dryRun: options.dryRun ?? false,
    model: typeof options.model === 'string' ? options.model : undefined,
  });
}

async function marketsFetchCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const { fetchMarketSnapshots } = await import('../tablebase/market-fetcher.ts');
  return fetchMarketSnapshots({
    platform: typeof options.source === 'string' ? options.source : undefined,
    entitySlug: args[0] ?? undefined,
    dryRun: options.dryRun ?? false,
  });
}

async function normalizeIdsCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { normalizeIds } = await import('../tablebase/normalize-ids.ts');
  const result = await normalizeIds(!!options.apply, { quiet: !!options.ci });

  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        personnelChecked: result.personnelChecked,
        grantsChecked: result.grantsChecked,
        fixesFound: result.fixes.length,
        unresolved: result.unresolved.length,
        applied: result.applied,
        fixes: result.fixes,
        unresolvedItems: result.unresolved,
      }, null, 2),
    };
  }

  return {
    exitCode: result.unresolved.length > 0 ? 1 : 0,
    output: '',
  };
}

async function sourceDiscoverCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const entityArg = args.find(a => !a.startsWith('--')) || options.entity;
  const dryRun = !!options.dryRun;
  const apply = !!options.apply;
  const limit = options.limit ? parseInt(options.limit as string, 10) : 10;
  const entityOnly = !!(options as Record<string, unknown>).entityOnly;
  const useV2 = !!(options as Record<string, unknown>).v2;
  const claimsOnly = !!(options as Record<string, unknown>).claimsOnly;

  // Resolve entity name to ID if provided
  let entityId: string | undefined;
  let entityName: string | undefined;
  if (entityArg) {
    const { buildEntityMatcher } = await import('../lib/grant-import/entity-matcher.ts');
    const matcher = buildEntityMatcher();
    const match = matcher.match(entityArg);
    entityId = match?.stableId || entityArg;
    entityName = match?.name || entityArg;
  }

  // ── V2: Claims-first agent ──────────────────────────────────────────
  if (useV2) {
    if (!entityId) {
      return { exitCode: 1, output: 'Error: --v2 requires an entity argument (e.g., crux tb source-discover anthropic --v2)' };
    }

    const { runSourceDiscoverAgent } = await import('../tablebase/source-discover-agent.ts');

    const result = await runSourceDiscoverAgent({
      entityId,
      entityName,
      limit,
      dryRun: !apply && !claimsOnly,
      apply,
      claimsOnly,
      budgetCap: options.budget ? parseFloat(options.budget) : 1.00,
    });

    if (options.ci) {
      return { exitCode: 0, output: JSON.stringify(result, null, 2) };
    }

    // Format summary
    const lines: string[] = [
      `Entity: ${result.entityName} (${result.entityId})`,
      `Unverifiable records: ${result.unverifiableCount} total, ${result.recordsProcessed} processed`,
      `Sources: ${result.sourcesDiscovered} discovered, ${result.sourcesWithClaims} with claims`,
      `Claims: ${result.claimsExtracted} extracted, ${result.claimsSubmitted} submitted`,
      `Cost: $${result.cost.toFixed(4)}, Duration: ${Math.round(result.durationMs / 1000)}s`,
    ];

    if (result.batchId) {
      lines.push(`Batch ID: ${result.batchId}`);
    }

    if (result.verificationStatus) {
      const v = result.verificationStatus;
      lines.push(`Verification: ${v.verified} verified, ${v.contradicted} contradicted, ${v.unverifiable} unverifiable, ${v.pending} pending${v.timedOut ? ' (timed out)' : ''}`);
    }

    if (result.sources.length > 0) {
      lines.push('', 'Sources with claims:');
      for (const s of result.sources) {
        lines.push(`  ${s.title} (${s.claims.length} claims)`);
        for (const c of s.claims.slice(0, 3)) {
          lines.push(`    - ${truncate(c.claimText, 103, { ellipsis: '...' })}`);
        }
        if (s.claims.length > 3) {
          lines.push(`    ... and ${s.claims.length - 3} more`);
        }
      }
    }

    const mode = apply ? 'apply' : claimsOnly ? 'claims-only' : 'dry-run';
    return {
      exitCode: 0,
      output: `[source-discover-agent v2] ${mode}\n${lines.join('\n')}`,
    };
  }

  // ── V1: Legacy string-matching approach ─────────────────────────────
  const { discoverSources } = await import('../tablebase/source-discovery.ts');

  const result = await discoverSources({ entityId, entityName, limit, dryRun, apply, entityOnly });

  if (result.entities.length === 0) {
    return { exitCode: 0, output: entityArg ? `No unverifiable records found for "${entityName}".` : 'No entities with unverifiable records found.' };
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result, null, 2) };
  }

  // Format summary
  const lines: string[] = [];
  for (const e of result.entities) {
    const sources = e.entityLevelSources.length + e.perPersonSources.length;
    lines.push(`  ${e.entityName}: ${e.recordsMatched}/${e.unverifiableCount} matched, ${sources} sources, $${e.cost.toFixed(4)}, ${Math.round(e.durationMs / 1000)}s${e.recordsUpdated > 0 ? ` (${e.recordsUpdated} updated)` : ''}`);
  }

  return {
    exitCode: 0,
    output: `Source discovery complete: ${result.entities.length} entities, ${result.totalRecordsMatched} records matched, $${result.totalCost.toFixed(4)}\n${lines.join('\n')}`,
  };
}

export const commands = {
  scan: scanCommand,
  gaps: gapsCommand,
  'next-task': nextTaskCommand,
  improve: improveCommand,
  'mark-done': markDoneCommand,
  loop: loopCommand,
  resolve: resolveCommand,
  submit: submitCommand,
  existing: existingCommand,
  'create-entity': createEntityCommand,
  'ensure-entities': ensureEntitiesCommand,
  'fetch-page': fetchPageCommand,
  verify: verifyCommand, // personnel ID integrity check (not sourcing)
  'sourcing-records': sourcingRecordsCommand,
  'verify-records': sourcingRecordsCommand, // deprecated alias
  'source-discover': sourceDiscoverCommand,
  prepare: prepareCommand,
  'sync-careers': syncCareersCommand,
  default: scanCommand,
  // Consolidated from backfill-* orphan domains
  'backfill-grantee-ids': backfillGranteeIdsCommands.default,
  'backfill-program-ids': backfillProgramIdsCommands.default,
  'backfill-stable-ids': backfillStableIdsCommands.run,
  'backfill-sources': backfillSourcesCommands.default,
  'backfill-yaml-stable-ids': backfillYamlStableIdsCommands.run,
  // Consolidated from import-* orphan domains
  'import-grants': importGrantsCommands.default,
  'import-grants-sync': importGrantsCommands.sync,
  'import-grants-dedup': importGrantsCommands.dedup,
  'import-grants-download': importGrantsCommands.download,
  'import-divisions': importDivisionsCommands.default,
  'import-divisions-sync': importDivisionsCommands.sync,
  'import-divisions-delete-orphans': importDivisionsCommands['delete-orphans'],
  'import-funding-programs': importFundingProgramsCommands.default,
  'import-funding-programs-sync': importFundingProgramsCommands.sync,
  // Market data commands
  'markets-discover': marketsDiscoverCommand,
  'markets-fetch': marketsFetchCommand,
  // ID normalization
  'normalize-ids': normalizeIdsCommand,
  // Data source management
  'data-sources': dataSourcesCommands.default,
  'data-sources-list': dataSourcesCommands.list,
  'data-sources-show': dataSourcesCommands.show,
  'data-sources-snapshot': dataSourcesCommands.snapshot,
  'data-sources-health': dataSourcesCommands.health,
  // Website source management
  'website-sources': websiteSourcesCommands.default,
  'website-sources-list': websiteSourcesCommands.list,
  'website-sources-show': websiteSourcesCommands.show,
  'website-sources-fetch': websiteSourcesCommands.fetch,
  // QUA-642: T2 website corpus extraction pipeline.
  'website-sources-register': websiteSourcesCommands.register,
  'website-sources-snapshot': websiteSourcesCommands.snapshot,
  'website-sources-extract': websiteSourcesCommands.extract,
  // QUA-455: scaffold a new tablebase entity type.
  scaffold: scaffoldCommands.scaffold,
  'setup-org': setupOrgCommands.default,
  // QUA-640: T1 authoritative-source importers.
  'sec-edgar': tbImporterCommands['sec-edgar'],
  'github-contributors': tbImporterCommands['github-contributors'],
  'hf-leaderboard': tbImporterCommands['hf-leaderboard'],
  // QUA-666: additional T1 authoritative-source importers.
  'wikidata': tbImporterCommands['wikidata'],
  'openalex': tbImporterCommands['openalex'],
  'semantic-scholar': tbImporterCommands['semantic-scholar'],
  'crossref': tbImporterCommands['crossref'],
  // QUA-690: system-card extraction.
  'system-cards': systemCardsCommands.default,
  'system-cards-extract': systemCardsCommands.extract,
  // QUA-691: frontier-safety-framework tracker.
  // QUA-707 added registry-driven `list`, `seed`, and `ingest` subcommands.
  'frameworks': frameworksCommands.default,
  'frameworks-extract': frameworksCommands.extract,
  'frameworks-diff': frameworksCommands.diff,
  'frameworks-fetch': frameworksCommands.fetch,
  'frameworks-list': frameworksCommands.list,
  'frameworks-seed': frameworksCommands.seed,
  'frameworks-ingest': frameworksCommands.ingest,
  // QUA-692: third-party evaluation index.
  'third-party-evals': thirdPartyEvalsCommands.default,
  'third-party-evals-ingest': thirdPartyEvalsCommands.ingest,
  'third-party-evals-extract': thirdPartyEvalsCommands.extract,
};

export function getHelp(): string {
  return `
TableBase Domain — Structured data enrichment via LLM agents

Commands:
  scan           Show per-table completeness scores
  gaps           Ranked list of missing data (enrichment targets)
  next-task      Output the single highest-impact task
  improve        Run LLM agent to enrich data for one task
  mark-done      Mark a task as completed (excluded from future picks)
  loop           Autonomous multi-task enrichment loop
  resolve        Resolve entity name to stableId (for Claude Code skill)
  create-entity  Create a new entity (person, org, etc.) with allocated ID
  submit         Submit records to a table (for Claude Code skill)
  existing       Query existing records for an entity (for Claude Code skill)
  sourcing-records Batch sourcing records using deterministic checks + Batch API
  source-discover      Find better sources for records with unverifiable verdicts
  sync-careers   Sync FactBase career data to the personnel table
  normalize-ids [--apply]  Fix slug-based entity IDs in personnel/grant records

  Backfill (consolidated from backfill-* domains):
  backfill-grantee-ids [--dry-run]       Link grants to grantee entity stableIds
  backfill-program-ids [--dry-run]       Link grants to funding programs
  backfill-stable-ids [--dry-run]        Push KB stableIds to wiki-server entity_ids
  backfill-sources [--dry-run|--apply]   Find source URLs for records with no source
  backfill-yaml-stable-ids [--dry-run]   Insert stableIds into entity YAML files

  Import (consolidated from import-* domains):
  import-grants               Analyze grant import stats (default)
  import-grants-sync          Import grants to wiki-server
  import-grants-dedup         Remove cross-source duplicates
  import-grants-download      Download grant data files
  import-divisions            List known organizational divisions (default)
  import-divisions-sync       Sync divisions to wiki-server
  import-funding-programs     List known funding programs (default)
  import-funding-programs-sync  Sync programs to wiki-server

  Data Sources:
  data-sources                Show data source help
  data-sources-list           List all registered data sources
  data-sources-show <id>      Show details + snapshot history
  data-sources-snapshot <id>  Capture a new snapshot (--all for all sources)
  data-sources-health         Check mapping validity, staleness

  T1 importers (QUA-640/QUA-666 — defensive enrichment):
  sec-edgar           Fetch SEC EDGAR Form D → funding-rounds (--target=slug:cik)
  github-contributors Fetch GitHub contributors → personnel hints (--target=slug:owner/repo[,owner/repo2])
  hf-leaderboard      Fetch HF Open LLM Leaderboard → benchmark-results (--target=modelSlug:displayName:evalName)
  wikidata            Fetch Wikidata SPARQL → organization-fact records (--target=slug:Qnumber)
  openalex            Fetch OpenAlex works by institution → publications (--target=slug:Iinstitution_id)
  semantic-scholar    Fetch Semantic Scholar papers by author → publications (--target=personSlug:displayName:authorId)
  crossref            Fetch Crossref DOI metadata → publications (--target=doi:10.xxx/yyy[|org=slug][|person=slug])

  Website Sources (T2 pipeline, QUA-642):
  website-sources             Show website source help
  website-sources-list        List all registered website sources
  website-sources-show <id>   Show source details with pages
  website-sources-register    Register burst-targets.yaml orgs + default pages
  website-sources-fetch <id>  Fetch pages and store snapshots (--all for all sources)
  website-sources-snapshot    Alias of fetch
  website-sources-extract     LLM-extract personnel from pending snapshots → /propose T2

  Market data:
  markets-discover <entity>   Discover prediction market questions via LLM agent
  markets-fetch [entity]      Fetch latest snapshots from platform APIs (Metaculus, etc.)

Options:
  --table=<name>            Filter scan to specific table; required for submit/existing
  --top=N, --limit=N        Number of gaps to show (default: 20)
  --task-type=<type>        Filter by task type
  --entity-type=<type>      Filter by entity type (organization, ai-model)
  --format=prompt|json      Output format for next-task
  --dry-run                 Run agent without writing to database
  --max=N                   Max tasks for loop (default: 5)
  --budget=N                Budget limit in USD for loop (default: 30)
  --model=<name>            LLM model: haiku, sonnet, opus, or auto (tier by task type)
  --records-file=<path>     JSON file for submit command
  --skip-sourcing       Skip sourcing before submit. Requires
                            --skip-sourcing-reason=<migration|backfill|testing|key-unavailable|manual-verified> (QUA-730).
  --skip-sourcing-reason=<value>   Controlled-vocabulary justification (only valid with --skip-sourcing).
  --via-propose             Route supported record types (grants, Phase 1) through
                            /api/enrichment/propose instead of direct /sync (QUA-655)
  --apply                   For source-discover: also link discovered resources to records
  --v2                      For source-discover: use claims-first agent (extracts + submits claims)
  --claims-only             For source-discover --v2: submit claims but don't apply results
  --persist                 Persist scan results to wiki-server (tablebase_scanner_results)
  --fields                  Add field-gap report (null/empty/n-a %) per table. Works standalone or
                            alongside the per-entity scan. Covers divisions, division_personnel,
                            funding_programs, benchmark_results. (QUA-551)
  --ci                      JSON output

Modes:
  API mode:          crux tb tablebase improve / loop (uses ANTHROPIC_BILLING_KEY, ~$1-2/task)
  Subscription mode: /tablebase-enrich skill in Claude Code ($0, uses subscription)

Task Types:
  grant-grantee-backfill     Link grants to grantee entities
  personnel-enrichment       Add key personnel for organizations
  funding-round-research     Add funding round data for companies
  investment-linking         Add investment records
  benchmark-result-fill      Add benchmark scores for AI models
  source-discovery           Find better sources for unverifiable records

Onboarding:
  setup-org --config=<path>   Single-shot org onboarding: ID + entity YAML + FactBase + PG sync.
                              Default is dry-run; pass --apply to write. See setup-org --help for full help.

Examples:
  crux tb tablebase scan                                   # Overview of all tables
  crux tb tablebase scan --fields                          # Field-gap report only (null/empty/n-a %)
  crux tb tablebase scan --fields --ci                     # JSON output for the field-gap report
  crux tb tablebase scan --table=divisions --fields        # Field gaps for a single table
  crux tb tablebase scan --fields --top=5                  # Show only the 5 biggest gaps per table
  crux tb tablebase gaps --top=10                          # Top 10 enrichment targets
  crux tb tablebase gaps --task-type=personnel-enrichment  # Personnel gaps only
  crux tb tablebase next-task --format=json                # JSON for scripting
  crux tb tablebase improve abc123def --dry-run            # Test run without writing
  crux tb tablebase loop --max=3 --budget=10               # 3-task loop with $10 cap
  crux tb tablebase loop --model=auto --max=20             # Auto-tier: haiku for simple, sonnet for complex
  crux tb tablebase loop --model=haiku --task-type=benchmark-result-fill  # All-haiku for benchmarks
  crux tb tablebase loop --via-propose --task-type=grant-grantee-backfill  # Route grants through /propose (QUA-655)
  crux tb tablebase sourcing-records --table=personnel --source=deterministic  # Fast structural checks
  crux tb tablebase sourcing-records --table=personnel --source=batch --limit=100  # LLM check 100 records
  crux tb tablebase sourcing-records --table=personnel --source=all   # Full sourcing
  crux tb tablebase source-discover anthropic --dry-run       # Preview source suggestions for Anthropic
  crux tb tablebase source-discover --limit=5 --budget=5     # Discover sources for top 5 entities
  crux tb tablebase source-discover anthropic --apply        # Discover + link sources to records
  crux tb tablebase source-discover anthropic --v2           # Claims-first discovery (dry-run)
  crux tb tablebase source-discover anthropic --v2 --apply   # Claims-first: extract + submit + verify
  crux tb tablebase source-discover anthropic --v2 --claims-only  # Submit claims but don't apply
  crux tb tablebase normalize-ids                            # Dry-run: show slug-based IDs
  crux tb tablebase normalize-ids --apply                    # Fix slug-based IDs
  crux tb tablebase resolve "OpenAI"                       # Resolve name → stableId
  crux tb tablebase resolve "OpenAI" --ci                  # JSON output
  crux tb tablebase existing A4XoubikkQ --table=personnel  # Show existing records
  echo '[{...}]' | crux tb tablebase submit --table=personnel  # Submit records via pipe
  echo '[{...}]' | crux tb tablebase submit --table=personnel --skip-sourcing  # Submit without sourcing
  crux tb tablebase mark-done abc123def                    # Exclude from future runs
  crux tb tablebase sync-careers                           # Populate personnel table from FactBase
  crux tb tablebase sync-careers --dry-run                 # Preview extraction without writing
`;
}
