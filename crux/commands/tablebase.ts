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

// Consolidated orphan domain imports
import { commands as backfillGranteeIdsCommands } from './backfill-grantee-ids.ts';
import { commands as backfillProgramIdsCommands } from './backfill-program-ids.ts';
import { commands as backfillStableIdsCommands } from './backfill-stable-ids.ts';
import { commands as backfillYamlStableIdsCommands } from './backfill-yaml-stable-ids.ts';
import { commands as importGrantsCommands } from './import-grants.ts';
import { commands as importDivisionsCommands } from './import-divisions.ts';
import { commands as importFundingProgramsCommands } from './import-funding-programs.ts';

interface CommandOptions extends BaseOptions {
  top?: string;
  limit?: string;
  format?: string;
  ci?: boolean;
  dryRun?: boolean;
  skipEntityValidation?: boolean;
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
}

async function scanCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { runFullScan, runTableScan } = await import('../tablebase/scanner.ts');
  const { formatScanSummary } = await import('../tablebase/reporter.ts');

  if (options.table) {
    const result = await runTableScan(options.table as string);
    if (!result) {
      return { exitCode: 1, output: `Unknown table: ${options.table}` };
    }
    if (options.ci) {
      return { exitCode: 0, output: JSON.stringify(result, null, 2) };
    }
    return { exitCode: 0, output: formatScanSummary({ tables: [result], timestamp: new Date().toISOString() }) };
  }

  const scan = await runFullScan();
  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(scan, null, 2) };
  }
  return { exitCode: 0, output: formatScanSummary(scan) };
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
  const taskId = args.find(a => !a.startsWith('--'));
  if (!taskId) {
    return { exitCode: 1, output: 'Usage: crux tb tablebase improve <task-id> [--dry-run]' };
  }

  const { findTaskById } = await import('../tablebase/loop.ts');
  const { runEnrichmentAgent } = await import('../tablebase/agent.ts');

  const task = await findTaskById(taskId);
  if (!task) {
    return { exitCode: 1, output: `Task not found: ${taskId}. Run 'crux tb tablebase gaps' to see available tasks.` };
  }

  const dryRun = !!options.dryRun;
  const model = options.model as string | undefined;
  const result = await runEnrichmentAgent(task, { dryRun, model });

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

  const { getTableConfig } = await import('../tablebase/table-registry.ts');
  const tableConfig = getTableConfig(table);
  if (!tableConfig) return { exitCode: 1, output: `Unknown table: ${table}` };

  const syncPath = options.skipEntityValidation
    ? `${tableConfig.syncPath}?skipEntityValidation=true`
    : tableConfig.syncPath;
  const result = await apiRequest<{ upserted?: number; updated?: number }>(
    tableConfig.syncMethod, syncPath, { [tableConfig.syncBodyKey]: records },
  );

  if (!result.ok) {
    return { exitCode: 1, output: `Submit failed: ${result.message}` };
  }

  const count = result.data.upserted ?? result.data.updated ?? records.length;
  return {
    exitCode: 0,
    output: options.ci
      ? JSON.stringify({ submitted: count, table })
      : `\x1b[32m✓\x1b[0m Submitted ${count} records to ${table}`,
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
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const description = (options.description as string) || undefined;
  const syncResult = await apiRequest<{ upserted: number }>('POST', '/api/entities/sync', {
    entities: [{
      id: slug,
      stableId,
      entityType,
      title: name,
      ...(description && { description }),
      metadata: { stub: true },
    }],
  });

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

  const { execSync } = await import('child_process');
  const { writeFileSync, unlinkSync } = await import('fs');
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
    const playwrightPath = execSync('which playwright', { encoding: 'utf-8' }).trim();
    // Follow symlinks: /opt/homebrew/bin/playwright → ../lib/node_modules/playwright/...
    const resolved = execSync(`realpath "${playwrightPath}"`, { encoding: 'utf-8' }).trim();
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
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const { buildEntityMatcher } = await import('../lib/grant-import/entity-matcher.ts');
  const matcher = buildEntityMatcher();
  const arrayIndexFixes = await buildArrayIndexFixMap();

  // Fetch all personnel records
  const allPersonnel: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (true) {
    const r = await apiRequest<{ personnel: Array<Record<string, unknown>>; total: number }>('GET', `/api/personnel/all?limit=200&offset=${offset}`);
    if (!r.ok) break;
    allPersonnel.push(...r.data.personnel);
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
        const entityR = await apiRequest<{ id: string; stableId: string | null }>('GET', `/api/entities/${encodeURIComponent(pid)}`);
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
      const fixR = await apiRequest<{ upserted: number }>('POST', '/api/personnel/sync', { items: batch });
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
  let divisionsInfo = '';
  if (task.taskType === 'personnel-enrichment') {
    const divResult = await apiRequest<{ divisions: Array<{ name: string; lead: string | null; divisionType: string; status: string }> }>(
      'GET', `/api/divisions/by-org/${encodeURIComponent(task.entityId)}?limit=50`,
    );
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
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
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
    const syncResult = await apiRequest<{ upserted: number }>('POST', '/api/entities/sync', {
      entities: toCreate.map(e => ({
        id: e.slug,
        stableId: e.stableId,
        entityType,
        title: e.name,
        metadata: { stub: true },
      })),
    });
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

  const result = await runLoop({
    maxTasks,
    budgetDollars,
    dryRun,
    taskTypes,
    entityTypes,
    model,
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
// source-check-records: Batch source-checking of enriched records
// ---------------------------------------------------------------------------

async function sourceCheckRecordsCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const { verifyRecords, formatVerificationReport } = await import('../tablebase/source-check.ts');

  const table = options.table as string | undefined;
  if (!table) {
    return { exitCode: 1, output: 'Usage: crux tb source-check-records --table=<personnel|funding-rounds|investments|benchmark-results> [--source=deterministic|batch|all] [--limit=N] [--model=haiku]' };
  }

  const limit = options.limit ? parseInt(options.limit as string, 10) : undefined;
  const source = (options.source as 'deterministic' | 'batch' | 'all') || 'all';
  const model = options.model as string | undefined;

  const result = await verifyRecords({ table, limit, source, model });

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result, null, 2) };
  }

  return { exitCode: 0, output: formatVerificationReport(result) };
}

async function syncCareersCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { extractAllCareers } = await import('../lib/career-import/extract.ts');
  const { apiRequest, getServerUrl } = await import('../lib/wiki-server/client.ts');

  const dryRun = !!options.dryRun;
  const serverUrl = getServerUrl();

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
  const syncItems = entries.map((e) => ({
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

    const result = await apiRequest<{ upserted: number }>(
      'POST',
      '/api/personnel/sync',
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

  return {
    exitCode: 0,
    output: `\nSynced ${totalUpserted} career entries to personnel table.`,
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
  verify: verifyCommand, // personnel ID integrity check (not source-checking)
  'source-check-records': sourceCheckRecordsCommand,
  'verify-records': sourceCheckRecordsCommand, // deprecated alias
  prepare: prepareCommand,
  'sync-careers': syncCareersCommand,
  default: scanCommand,
  // Consolidated from backfill-* orphan domains
  'backfill-grantee-ids': backfillGranteeIdsCommands.default,
  'backfill-program-ids': backfillProgramIdsCommands.default,
  'backfill-stable-ids': backfillStableIdsCommands.run,
  'backfill-yaml-stable-ids': backfillYamlStableIdsCommands.run,
  // Consolidated from import-* orphan domains
  'import-grants': importGrantsCommands.default,
  'import-grants-sync': importGrantsCommands.sync,
  'import-grants-dedup': importGrantsCommands.dedup,
  'import-grants-download': importGrantsCommands.download,
  'import-divisions': importDivisionsCommands.default,
  'import-divisions-sync': importDivisionsCommands.sync,
  'import-funding-programs': importFundingProgramsCommands.default,
  'import-funding-programs-sync': importFundingProgramsCommands.sync,
  // Market data commands
  'markets-discover': marketsDiscoverCommand,
  'markets-fetch': marketsFetchCommand,
  // ID normalization
  'normalize-ids': normalizeIdsCommand,
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
  source-check-records Batch source-check records using deterministic checks + Batch API
  sync-careers   Sync FactBase career data to the personnel table
  normalize-ids [--apply]  Fix slug-based entity IDs in personnel/grant records

  Backfill (consolidated from backfill-* domains):
  backfill-grantee-ids [--dry-run]       Link grants to grantee entity stableIds
  backfill-program-ids [--dry-run]       Link grants to funding programs
  backfill-stable-ids [--dry-run]        Push KB stableIds to wiki-server entity_ids
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
  --ci                      JSON output

Modes:
  API mode:          crux tb tablebase improve / loop (uses ANTHROPIC_API_KEY, ~$1-2/task)
  Subscription mode: /tablebase-enrich skill in Claude Code ($0, uses subscription)

Task Types:
  grant-grantee-backfill     Link grants to grantee entities
  personnel-enrichment       Add key personnel for organizations
  funding-round-research     Add funding round data for companies
  investment-linking         Add investment records
  benchmark-result-fill      Add benchmark scores for AI models

Examples:
  crux tb tablebase scan                                   # Overview of all tables
  crux tb tablebase gaps --top=10                          # Top 10 enrichment targets
  crux tb tablebase gaps --task-type=personnel-enrichment  # Personnel gaps only
  crux tb tablebase next-task --format=json                # JSON for scripting
  crux tb tablebase improve abc123def --dry-run            # Test run without writing
  crux tb tablebase loop --max=3 --budget=10               # 3-task loop with $10 cap
  crux tb tablebase loop --model=auto --max=20             # Auto-tier: haiku for simple, sonnet for complex
  crux tb tablebase loop --model=haiku --task-type=benchmark-result-fill  # All-haiku for benchmarks
  crux tb tablebase source-check-records --table=personnel --source=deterministic  # Fast structural checks
  crux tb tablebase source-check-records --table=personnel --source=batch --limit=100  # LLM check 100 records
  crux tb tablebase source-check-records --table=personnel --source=all   # Full source-check
  crux tb tablebase normalize-ids                            # Dry-run: show slug-based IDs
  crux tb tablebase normalize-ids --apply                    # Fix slug-based IDs
  crux tb tablebase resolve "OpenAI"                       # Resolve name → stableId
  crux tb tablebase resolve "OpenAI" --ci                  # JSON output
  crux tb tablebase existing A4XoubikkQ --table=personnel  # Show existing records
  echo '[{...}]' | crux tb tablebase submit --table=personnel  # Submit records via pipe
  crux tb tablebase mark-done abc123def                    # Exclude from future runs
  crux tb tablebase sync-careers                           # Populate personnel table from FactBase
  crux tb tablebase sync-careers --dry-run                 # Preview extraction without writing
`;
}
