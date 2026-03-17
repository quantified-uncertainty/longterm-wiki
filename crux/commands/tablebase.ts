/**
 * TableBase Command Handlers
 *
 * Scan PG table completeness, rank enrichment tasks by impact,
 * and run LLM agents with web search to fill gaps.
 *
 * Usage:
 *   crux tablebase scan           Show per-table completeness scores
 *   crux tablebase gaps           Ranked list of missing data
 *   crux tablebase next-task      Single highest-impact task (JSON)
 *   crux tablebase improve        Run LLM agent for one task
 *   crux tablebase mark-done      Exclude from future picks
 *   crux tablebase loop           Autonomous multi-task loop
 *   crux tablebase sync-careers   Sync FactBase career data to personnel table
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
  fix?: boolean;
  max?: string;
  budget?: string;
  taskType?: string;
  entityType?: string;
  table?: string;
  type?: string;
  description?: string;
  recordsFile?: string;
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

  // Allocate wiki ID
  const { allocateId } = await import('../lib/wiki-server/ids.ts');
  const idResult = await allocateId(slug, `${entityType}: ${name}`);
  if (!idResult.ok) {
    return { exitCode: 1, output: `ID allocation failed: ${idResult.message}` };
  }
  const { wikiId, stableId } = idResult.data;

  // Sync entity to wiki-server
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const description = (options.description as string) || undefined;
  const syncResult = await apiRequest<{ upserted: number }>('POST', '/api/entities/sync', {
    entities: [{
      id: slug,
      wikiId,
      stableId,
      entityType,
      title: name,
      ...(description && { description }),
    }],
  });

  if (!syncResult.ok) {
    return { exitCode: 1, output: `Entity sync failed: ${syncResult.message}` };
  }

  const result = { created: true, stableId, wikiId, slug, name, entityType };
  return {
    exitCode: 0,
    output: options.ci ? JSON.stringify(result) : `\x1b[32m✓\x1b[0m Created ${entityType} "${name}" → ${stableId} (${wikiId})`,
  };
}

async function fetchPageCommand(args: string[], _options: CommandOptions): Promise<CommandResult> {
  const url = args.find(a => !a.startsWith('--'));
  if (!url) {
    return { exitCode: 1, output: 'Usage: crux tablebase fetch-page <url>\nExtracts rendered text from a page using Playwright (handles JavaScript-rendered content).' };
  }

  const { execSync } = await import('child_process');
  // Use node with the global playwright module to extract rendered text
  const script = `
    const { chromium } = require('playwright');
    (async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 20000 });
      const text = await page.innerText('body');
      process.stdout.write(text);
      await browser.close();
    })().catch(e => { process.stderr.write(e.message); process.exit(1); });
  `.trim();

  try {
    const output = execSync(`node -e "${script.replace(/"/g, '\\"')}"`, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, NODE_PATH: '/opt/homebrew/lib/node_modules' },
    });
    return { exitCode: 0, output: output.toString() };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, output: `Playwright fetch failed: ${msg}\nIs Playwright installed? Run: npm i -g playwright` };
  }
}

async function verifyCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const { buildEntityMatcher } = await import('../lib/grant-import/entity-matcher.ts');
  const matcher = buildEntityMatcher();

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
  let unresolvedPersonIds = 0;
  let missingSource = 0;
  let duplicates = 0;

  const seen = new Set<string>();

  for (const rec of allPersonnel) {
    const pid = rec.personId as string;
    const oid = rec.organizationId as string;
    const role = rec.role as string;

    // Check for slug-based personIds (should be stableIds)
    // StableIds are 10-char alphanumeric without hyphens, so hyphens indicate a slug
    if (pid && pid.includes('-')) {
      // Try local matcher first, then wiki-server entity lookup
      const match = matcher.match(pid);
      if (match) {
        issues.push(`SLUG_PERSON_ID: Record ${rec.id} has personId="${pid}" → stableId "${match.stableId}"`);
        slugPersonIds++;
        if (options.fix) {
          const fixR = await apiRequest<{ upserted: number }>('POST', '/api/personnel/sync', {
            items: [{ ...rec, personId: match.stableId }],
          });
          if (fixR.ok) issues[issues.length - 1] += ' [FIXED]';
        }
      } else {
        // Check wiki-server directly (entity may exist but not in local database.json)
        const entityR = await apiRequest<{ id: string; stableId: string | null }>('GET', `/api/entities/${encodeURIComponent(pid)}`);
        if (entityR.ok && entityR.data.stableId) {
          issues.push(`SLUG_PERSON_ID: Record ${rec.id} has personId="${pid}" → stableId "${entityR.data.stableId}" (via server)`);
          slugPersonIds++;
          if (options.fix) {
            const fixR = await apiRequest<{ upserted: number }>('POST', '/api/personnel/sync', {
              items: [{ ...rec, personId: entityR.data.stableId }],
            });
            if (fixR.ok) issues[issues.length - 1] += ' [FIXED]';
          }
        } else {
          issues.push(`UNRESOLVED_PERSON_ID: Record ${rec.id} has personId="${pid}" which doesn't resolve`);
          unresolvedPersonIds++;
        }
      }
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

  const summary = [
    `\x1b[1mTableBase Data Quality Report\x1b[0m`,
    `Total personnel records: ${allPersonnel.length}`,
    '',
    `Slug-based personIds (need normalization): ${slugPersonIds}`,
    `Unresolved personIds: ${unresolvedPersonIds}`,
    `Missing source URLs: ${missingSource}`,
    `Duplicate records: ${duplicates}`,
    '',
  ];

  if (issues.length === 0) {
    summary.push('\x1b[32m✓ No issues found\x1b[0m');
  } else {
    summary.push(`\x1b[33m${issues.length} issue(s) found:\x1b[0m`);
    for (const issue of issues.slice(0, 20)) {
      summary.push(`  ${issue}`);
    }
    if (issues.length > 20) summary.push(`  ... and ${issues.length - 20} more`);
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify({ total: allPersonnel.length, slugPersonIds, unresolvedPersonIds, missingSource, duplicates, issues }) };
  }

  return { exitCode: issues.length > 0 ? 1 : 0, output: summary.join('\n') };
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
  const toCreate: Array<{ slug: string; name: string; wikiId: string; stableId: string }> = [];

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
    toCreate.push({ slug, name: trimmed, wikiId: idResult.data.wikiId, stableId: idResult.data.stableId });
    results.push({ name: trimmed, stableId: idResult.data.stableId, created: true });
  }

  // Batch sync all new entities
  if (toCreate.length > 0 && !dryRun) {
    const syncResult = await apiRequest<{ upserted: number }>('POST', '/api/entities/sync', {
      entities: toCreate.map(e => ({
        id: e.slug,
        wikiId: e.wikiId,
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

// ---------------------------------------------------------------------------
// sync-careers: Extract career data from FactBase and upsert to personnel table
// ---------------------------------------------------------------------------

const PERSONNEL_SYNC_BATCH_SIZE = 200;

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
  verify: verifyCommand,
  prepare: prepareCommand,
  'sync-careers': syncCareersCommand,
  default: scanCommand,
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
  sync-careers   Sync FactBase career data to the personnel table

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
  crux tablebase scan                                   # Overview of all tables
  crux tablebase gaps --top=10                          # Top 10 enrichment targets
  crux tablebase gaps --task-type=personnel-enrichment  # Personnel gaps only
  crux tablebase next-task --format=json                # JSON for scripting
  crux tablebase improve abc123def --dry-run            # Test run without writing
  crux tablebase loop --max=3 --budget=10               # 3-task loop with $10 cap
  crux tablebase resolve "OpenAI"                       # Resolve name → stableId
  crux tablebase resolve "OpenAI" --ci                  # JSON output
  crux tablebase existing A4XoubikkQ --table=personnel  # Show existing records
  echo '[{...}]' | crux tablebase submit --table=personnel  # Submit records via pipe
  crux tablebase mark-done abc123def                    # Exclude from future runs
  crux tablebase sync-careers                           # Populate personnel table from FactBase
  crux tablebase sync-careers --dry-run                 # Preview extraction without writing
`;
}
