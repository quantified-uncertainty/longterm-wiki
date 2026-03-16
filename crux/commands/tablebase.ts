/**
 * TableBase Command Handlers
 *
 * Scan PG table completeness, rank enrichment tasks by impact,
 * and run LLM agents with web search to fill gaps.
 *
 * Usage:
 *   crux tablebase scan       Show per-table completeness scores
 *   crux tablebase gaps       Ranked list of missing data
 *   crux tablebase next-task  Single highest-impact task (JSON)
 *   crux tablebase improve    Run LLM agent for one task
 *   crux tablebase mark-done  Exclude from future picks
 *   crux tablebase loop       Autonomous multi-task loop
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import type { TaskType } from '../tablebase/types.ts';
import { TASK_TYPES } from '../tablebase/types.ts';

interface CommandOptions extends BaseOptions {
  top?: string;
  limit?: string;
  format?: string;
  ci?: boolean;
  dryRun?: boolean;
  max?: string;
  budget?: string;
  taskType?: string;
  entityType?: string;
  table?: string;
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
    return { exitCode: 1, output: 'Usage: crux tablebase improve <task-id> [--dry-run]' };
  }

  const { findTaskById } = await import('../tablebase/loop.ts');
  const { runEnrichmentAgent } = await import('../tablebase/agent.ts');

  const task = await findTaskById(taskId);
  if (!task) {
    return { exitCode: 1, output: `Task not found: ${taskId}. Run 'crux tablebase gaps' to see available tasks.` };
  }

  const dryRun = !!options.dryRun;
  const result = await runEnrichmentAgent(task, { dryRun });

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
    return { exitCode: 1, output: 'Usage: crux tablebase resolve <entity name>' };
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
    return { exitCode: 1, output: 'Usage: crux tablebase submit --table=<table> --records-file=<path>\n       echo \'[...]\' | crux tablebase submit --table=<table>' };
  }

  const validTables = ['personnel', 'grants', 'funding-rounds', 'investments', 'benchmark-results'];
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

  let apiPath: string;
  let method: 'POST' | 'PATCH' = 'POST';
  switch (table) {
    case 'personnel': apiPath = '/api/personnel/sync'; break;
    case 'grants': apiPath = '/api/grants/batch-update-grantee'; method = 'PATCH'; break;
    case 'funding-rounds': apiPath = '/api/funding-rounds/sync'; break;
    case 'investments': apiPath = '/api/investments/sync'; break;
    case 'benchmark-results': apiPath = '/api/benchmark-results/sync'; break;
    default: return { exitCode: 1, output: `Unknown table: ${table}` };
  }

  const result = await apiRequest<{ upserted?: number; updated?: number }>(
    method, apiPath, { items: records },
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
    return { exitCode: 1, output: 'Usage: crux tablebase existing <entityId> --table=<table>' };
  }

  const { apiRequest } = await import('../lib/wiki-server/client.ts');

  let path: string;
  let resultKey: string;
  switch (table) {
    case 'personnel':
      path = `/api/personnel/by-entity/${encodeURIComponent(entityId)}?limit=200`;
      resultKey = 'personnel';
      break;
    case 'grants':
      path = `/api/grants/by-entity/${encodeURIComponent(entityId)}?limit=200`;
      resultKey = 'grants';
      break;
    case 'funding-rounds':
      path = `/api/funding-rounds/by-entity/${encodeURIComponent(entityId)}?limit=200`;
      resultKey = 'fundingRounds';
      break;
    case 'investments':
      path = `/api/investments/by-entity/${encodeURIComponent(entityId)}?limit=200`;
      resultKey = 'investments';
      break;
    case 'benchmark-results':
      path = `/api/benchmark-results/by-model/${encodeURIComponent(entityId)}?limit=200`;
      resultKey = 'benchmarkResults';
      break;
    default:
      return { exitCode: 1, output: `Invalid table: ${table}` };
  }

  const result = await apiRequest<Record<string, unknown>>('GET', path);
  if (!result.ok) {
    return { exitCode: 1, output: `Query failed: ${result.message}` };
  }

  const records = result.data[resultKey] as Array<Record<string, unknown>>;
  return { exitCode: 0, output: JSON.stringify(records, null, 2) };
}

async function createEntityCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const nameArgs = args.filter(a => !a.startsWith('--'));
  const name = nameArgs.join(' ');
  if (!name) {
    return { exitCode: 1, output: 'Usage: crux tablebase create-entity "Person Name" --type=person' };
  }

  const entityType = (options.type as string) || 'person';

  // Generate slug from name
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

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

  // Allocate numeric ID
  const { allocateId } = await import('../lib/wiki-server/ids.ts');
  const idResult = await allocateId(slug, `${entityType}: ${name}`);
  if (!idResult.ok) {
    return { exitCode: 1, output: `ID allocation failed: ${idResult.message}` };
  }
  const { numericId, stableId } = idResult.data;

  // Sync entity to wiki-server
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const description = (options.description as string) || undefined;
  const syncResult = await apiRequest<{ upserted: number }>('POST', '/api/entities/sync', {
    entities: [{
      id: slug,
      numericId,
      stableId,
      entityType,
      title: name,
      ...(description && { description }),
    }],
  });

  if (!syncResult.ok) {
    return { exitCode: 1, output: `Entity sync failed: ${syncResult.message}` };
  }

  const result = { created: true, stableId, numericId, slug, name, entityType };
  return {
    exitCode: 0,
    output: options.ci ? JSON.stringify(result) : `\x1b[32m✓\x1b[0m Created ${entityType} "${name}" → ${stableId} (${numericId})`,
  };
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
  let existingPath: string;
  let existingKey: string;
  switch (task.table) {
    case 'personnel':
      existingPath = `/api/personnel/by-entity/${encodeURIComponent(task.entityId)}?limit=50`;
      existingKey = 'personnel';
      break;
    case 'grants':
      existingPath = `/api/grants/by-entity/${encodeURIComponent(task.entityId)}?limit=50`;
      existingKey = 'grants';
      break;
    case 'funding_rounds':
      existingPath = `/api/funding-rounds/by-entity/${encodeURIComponent(task.entityId)}?limit=50`;
      existingKey = 'fundingRounds';
      break;
    case 'investments':
      existingPath = `/api/investments/by-entity/${encodeURIComponent(task.entityId)}?limit=50`;
      existingKey = 'investments';
      break;
    case 'benchmark_results':
      existingPath = `/api/benchmark-results/by-model/${encodeURIComponent(task.entityId)}?limit=50`;
      existingKey = 'benchmarkResults';
      break;
    default:
      existingPath = ''; existingKey = '';
  }

  let existingRecords: unknown[] = [];
  if (existingPath) {
    const r = await apiRequest<Record<string, unknown>>('GET', existingPath);
    if (r.ok) existingRecords = (r.data[existingKey] as unknown[]) || [];
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
pnpm crux tablebase resolve "Person Name" --ci

# If NOT_FOUND, create the entity first:
pnpm crux tablebase create-entity "Person Name" --type=person --ci

# Submit records (pipe JSON array):
cat <<'RECORDS' | pnpm crux tablebase submit --table=${submitTable}
[{"personId":"<ID>","organizationId":"${task.entityId}","role":"<ROLE>","roleType":"key-person","source":"<URL>"}]
RECORDS

# When done:
pnpm crux tablebase mark-done ${task.id}
\`\`\`
${existingRecords.length > 0 ? `\n### Existing records\n\`\`\`json\n${JSON.stringify(existingRecords.slice(0, 5), null, 2)}\n\`\`\`\n` : ''}`;

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
    return { exitCode: 1, output: 'Usage: echo \'["Name 1","Name 2"]\' | crux tablebase ensure-entities --type=person' };
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
  const { allocateId } = await import('../lib/wiki-server/ids.ts');
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const matcher = buildEntityMatcher();

  const results: Array<{ name: string; stableId: string; created: boolean }> = [];
  const toCreate: Array<{ slug: string; name: string; numericId: string; stableId: string }> = [];

  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const trimmed = name.trim();

    // Check existing
    const match = matcher.match(trimmed);
    if (match) {
      results.push({ name: trimmed, stableId: match.stableId, created: false });
      continue;
    }

    // Allocate ID
    const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    if (dryRun) {
      results.push({ name: trimmed, stableId: `(dry-run:${slug})`, created: true });
      continue;
    }

    const idResult = await allocateId(slug, `${entityType}: ${trimmed}`);
    if (!idResult.ok) {
      console.warn(`[tablebase] Failed to allocate ID for "${trimmed}": ${idResult.message}`);
      continue;
    }
    toCreate.push({ slug, name: trimmed, numericId: idResult.data.numericId, stableId: idResult.data.stableId });
    results.push({ name: trimmed, stableId: idResult.data.stableId, created: true });
  }

  // Batch sync all new entities
  if (toCreate.length > 0 && !dryRun) {
    const syncResult = await apiRequest<{ upserted: number }>('POST', '/api/entities/sync', {
      entities: toCreate.map(e => ({
        id: e.slug,
        numericId: e.numericId,
        stableId: e.stableId,
        entityType,
        title: e.name,
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
    return { exitCode: 1, output: 'Usage: crux tablebase mark-done <task-id>' };
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
  });

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result, null, 2) };
  }

  return {
    exitCode: 0,
    output: `Loop finished: ${result.tasksSucceeded}/${result.tasksAttempted} tasks, ${result.totalRecordsCreated} records, $${result.totalCost.toFixed(4)}, ${Math.round(result.totalDurationMs / 1000)}s (${result.stoppedReason})`,
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
  prepare: prepareCommand,
  default: scanCommand,
};

export function getHelp(): string {
  return `
TableBase Domain — Structured data enrichment via LLM agents

Commands:
  scan        Show per-table completeness scores
  gaps        Ranked list of missing data (enrichment targets)
  next-task   Output the single highest-impact task
  improve     Run LLM agent for one task (uses ANTHROPIC_API_KEY)
  mark-done   Mark a task as completed (excluded from future picks)
  loop        Autonomous multi-task enrichment loop (uses ANTHROPIC_API_KEY)
  resolve       Resolve entity name to stableId (for Claude Code skill)
  create-entity Create a new entity (person, org, etc.) with allocated ID
  submit        Submit records to a table (for Claude Code skill)
  existing      Query existing records for an entity (for Claude Code skill)

Options:
  --table=<name>            Filter scan to specific table; required for submit/existing
  --top=N, --limit=N        Number of gaps to show (default: 20)
  --task-type=<type>        Filter by task type
  --entity-type=<type>      Filter by entity type (organization, ai-model)
  --format=prompt|json      Output format for next-task
  --dry-run                 Run agent without writing to database
  --max=N                   Max tasks for loop (default: 5)
  --budget=N                Budget limit in USD for loop (default: 30)
  --records-file=<path>     JSON file for submit command
  --ci                      JSON output

Modes:
  API mode:          crux tablebase improve / loop (uses ANTHROPIC_API_KEY, ~$1-2/task)
  Subscription mode: /tablebase-enrich skill in Claude Code ($0, uses subscription)

Task Types:
  grant-grantee-backfill     Link grants to grantee entities
  personnel-enrichment       Add key personnel for organizations
  funding-round-research     Add funding round data for companies
  investment-linking         Add investment records
  benchmark-result-fill      Add benchmark scores for AI models

Examples:
  crux tablebase scan                                 # Overview of all tables
  crux tablebase gaps --top=10                        # Top 10 enrichment targets
  crux tablebase next-task --format=json              # JSON for scripting
  crux tablebase improve abc123def --dry-run          # API mode: test run
  crux tablebase loop --max=3 --budget=10             # API mode: 3-task loop
  crux tablebase resolve "OpenAI"                     # Resolve name → stableId
  crux tablebase resolve "OpenAI" --ci                # JSON output
  crux tablebase existing A4XoubikkQ --table=personnel  # Show existing records
  echo '[{...}]' | crux tablebase submit --table=personnel  # Submit records via pipe
  crux tablebase mark-done abc123def                  # Exclude from future runs
`;
}
