/**
 * Claims Ingest Batch — bulk-ingest claims from all resources with cited_by entries
 *
 * Phase 3: Batch variant of ingest-resource. Processes all resources that
 * have at least one cited_by wiki page and haven't been ingested yet (or
 * all, if --force is set).
 *
 * Usage:
 *   pnpm crux claims ingest-batch               Ingest resources with citedBy entries
 *   pnpm crux claims ingest-batch --limit=20    Process at most 20 resources
 *   pnpm crux claims ingest-batch --dry-run     Preview without storing
 *   pnpm crux claims ingest-batch --force       Re-ingest even if already done
 *   pnpm crux claims ingest-batch --entity=kalshi  Only resources cited by kalshi
 *
 * Requires: OPENROUTER_API_KEY or ANTHROPIC_API_KEY
 */

import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { loadResources } from '../resource-io.ts';

const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const INGEST_STATE_FILE = join(PROJECT_ROOT, '.cache', 'claims-ingest-state.json');

interface IngestState {
  ingestedResources: Record<string, { ingestedAt: string; claimsInserted: number }>;
}

function loadState(): IngestState {
  if (existsSync(INGEST_STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(INGEST_STATE_FILE, 'utf-8')) as IngestState;
    } catch { /* ignore */ }
  }
  return { ingestedResources: {} };
}

function saveState(state: IngestState): void {
  writeFileSync(INGEST_STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const force = args.force === true;
  const limit = typeof args.limit === 'string' ? parseInt(args.limit, 10) : undefined;
  const model = typeof args.model === 'string' ? args.model : undefined;
  const entityFilter = typeof args.entity === 'string' ? args.entity : null;
  const c = getColors(false);

  // Check server availability (unless dry-run)
  if (!dryRun) {
    const serverAvailable = await isServerAvailable();
    if (!serverAvailable) {
      console.error(`${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`);
      console.error(`  Use --dry-run to preview without storing.`);
      process.exit(1);
    }
  }

  // Load all resources
  const allResources = loadResources();
  const state = loadState();

  // Filter to resources with cited_by entries
  let candidates = allResources.filter(r => {
    const citedBy = r.cited_by ?? [];
    if (citedBy.length === 0) return false;
    if (entityFilter && !citedBy.includes(entityFilter)) return false;
    if (!force && state.ingestedResources[r.id]) return false;
    return true;
  });

  if (limit) candidates = candidates.slice(0, limit);

  console.log(`\n${c.bold}${c.blue}Claims Ingest Batch${c.reset}`);
  console.log(`  Resources to process: ${c.bold}${candidates.length}${c.reset}`);
  console.log(`  Total with cited_by:  ${allResources.filter(r => (r.cited_by ?? []).length > 0).length}`);
  console.log(`  Already ingested:     ${Object.keys(state.ingestedResources).length}`);
  if (entityFilter) console.log(`  Entity filter:        ${entityFilter}`);
  if (dryRun) console.log(`  ${c.yellow}DRY RUN — claims will not be stored${c.reset}`);
  console.log('');

  if (candidates.length === 0) {
    console.log(`${c.green}All eligible resources already ingested. Use --force to re-ingest.${c.reset}\n`);
    return;
  }

  let totalInserted = 0;
  let processed = 0;
  let skipped = 0;

  for (const resource of candidates) {
    const citedBy = resource.cited_by ?? [];
    const entities = entityFilter ? [entityFilter] : citedBy;
    const label = (resource.title ?? resource.id).slice(0, 60);

    process.stdout.write(`  ${c.dim}[${processed + 1}/${candidates.length}]${c.reset} ${label}... `);

    // Build model args string for ingest-resource subprocess
    const extraArgs: string[] = [];
    if (dryRun) extraArgs.push('--dry-run');
    if (force) extraArgs.push('--force');
    if (model) extraArgs.push(`--model=${model}`);
    for (const entity of entities) extraArgs.push(`--entity=${entity}`);

    try {
      // Run ingest-resource as a subprocess
      const { spawnSync } = await import('child_process');
      const result = spawnSync('node', [
        '--import', 'tsx/esm',
        join(PROJECT_ROOT, 'crux', 'claims', 'ingest-resource.ts'),
        resource.id,
        ...extraArgs,
      ], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
        encoding: 'utf-8',
        timeout: 120000,
      });

      if (result.status === 0) {
        // Strip ANSI escape codes before parsing — ingest-resource.ts uses colored output
        const cleanStdout = result.stdout.replace(/\x1b\[[0-9;]*m/g, '');
        const insertedMatch = cleanStdout.match(/Inserted:\s+(\d+)/);
        const n = insertedMatch ? parseInt(insertedMatch[1], 10) : 0;
        totalInserted += n;
        console.log(`${c.green}✓ ${n} claims${c.reset}`);

        if (!dryRun) {
          state.ingestedResources[resource.id] = {
            ingestedAt: new Date().toISOString(),
            claimsInserted: n,
          };
          saveState(state);
        }
        processed++;
      } else {
        console.log(`${c.yellow}skipped (exit ${result.status})${c.reset}`);
        if (result.stderr) {
          const errLine = result.stderr.split('\n').find(l => l.includes('Error:') || l.includes('warn'));
          if (errLine) console.log(`    ${c.dim}${errLine.slice(0, 100)}${c.reset}`);
        }
        skipped++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${c.red}error: ${msg.slice(0, 80)}${c.reset}`);
      skipped++;
    }
  }

  console.log(`\n${c.bold}Batch complete:${c.reset}`);
  console.log(`  Processed: ${c.green}${processed}${c.reset}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Total claims inserted: ${c.green}${totalInserted}${c.reset}`);
  console.log(`\n  State saved to: ${INGEST_STATE_FILE}`);
  console.log('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Claims ingest-batch failed:', err);
    process.exit(1);
  });
}
