/**
 * Agent Orchestrator — Public API
 *
 * Entry point for the agent orchestrator pipeline. Replaces the fixed
 * improve/create pipeline with an LLM agent that has modules as tools.
 *
 * Usage:
 *   import { runOrchestratorPipeline } from './orchestrator/index.ts';
 *   const result = await runOrchestratorPipeline(pageId, options);
 *
 * CLI integration: called via --engine=v2 flag on improve/create commands.
 *
 * See issue #692 and E766 Part 11.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

import { createPhaseLogger } from '../../lib/output.ts';
import { appendEditLog, getDefaultRequestedBy } from '../../lib/edit-log.ts';
import { createSession } from '../../lib/wiki-server/sessions.ts';
import { loadPages as loadPagesFromRegistry } from '../../lib/content-types.ts';
import { repairFrontmatter, stripRelatedPagesSections } from '../page-improver/utils.ts';

import { runOrchestrator } from './orchestrator.ts';
import type { OrchestratorOptions, OrchestratorResult, OrchestratorTier } from './types.ts';

export type { OrchestratorOptions, OrchestratorResult, OrchestratorTier };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../../..');
const TEMP_DIR = path.join(ROOT, '.claude/temp/orchestrator');

const log = createPhaseLogger();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeTemp(pageId: string, filename: string, content: string | object): string {
  const dir = path.join(TEMP_DIR, pageId);
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return filePath;
}

function getFilePath(pagePath: string): string {
  const cleanPath = pagePath.replace(/^\/|\/$/g, '');
  return path.join(ROOT, 'content/docs', cleanPath + '.mdx');
}

interface PageData {
  id: string;
  title: string;
  path: string;
  quality?: number;
  readerImportance?: number;
}

function loadPages(): PageData[] {
  const pages = loadPagesFromRegistry();
  if (pages.length === 0) {
    console.error('Error: pages.json is empty. Run `node apps/web/scripts/build-data.mjs` first.');
    process.exit(1);
  }
  return pages as PageData[];
}

function findPage(pages: PageData[], query: string): PageData | null {
  let page = pages.find(p => p.id === query);
  if (page) return page;

  const matches = pages.filter(p =>
    p.id.includes(query) || p.title.toLowerCase().includes(query.toLowerCase()),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.log('Multiple matches:');
    matches.slice(0, 10).forEach(p => console.log(`  - ${p.id} (${p.title})`));
    process.exit(1);
  }
  return null;
}

function getCurrentBranch(): string | null {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

async function autoLogSession(
  page: PageData,
  tier: string,
  result: OrchestratorResult,
): Promise<void> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const branch = getCurrentBranch();
    const summary = `Improved "${page.title}" via orchestrator v2 (${tier}, ${result.toolCallCount} tool calls, ${result.refinementCycles} refinement cycles). Quality gate: ${result.qualityGatePassed ? 'passed' : 'failed'}. Cost: ~$${result.totalCost.toFixed(2)}.`;

    const entry = {
      date: today,
      branch,
      title: `Orchestrator v2 (${tier}): ${page.title}`,
      summary,
      model: null,
      duration: `${result.duration}s`,
      cost: `~$${result.totalCost.toFixed(2)}`,
      prUrl: null,
      pages: [page.id],
    };

    const apiResult = await createSession(entry);
    if (apiResult.ok) {
      log('session', `Session log written to wiki-server (id: ${apiResult.data.id})`);
    } else {
      log('session', `Warning: could not write session log: ${apiResult.message}`);
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('session', `Warning: session log failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main pipeline function
// ---------------------------------------------------------------------------

/**
 * Run the agent orchestrator pipeline on an existing page.
 *
 * This is the v2 replacement for runPipeline() in page-improver/pipeline.ts.
 * It uses the same page loading, output, session logging, and edit-log
 * infrastructure as the v1 pipeline.
 */
export async function runOrchestratorPipeline(
  pageId: string,
  options: OrchestratorOptions = {},
): Promise<OrchestratorResult> {
  const { tier = 'standard', directions = '', dryRun = false } = options;

  // ── Find page ──────────────────────────────────────────────────────────

  const pages = loadPages();
  const page = findPage(pages, pageId);
  if (!page) {
    console.error(`Page not found: ${pageId}`);
    console.log('Try: pnpm crux content improve --list');
    process.exit(1);
  }

  const filePath = getFilePath(page.path);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  // ── Print header ───────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log(`Improving: "${page.title}" (orchestrator v2)`);
  console.log(`Tier: ${tier}`);
  if (directions) console.log(`Directions: ${directions}`);
  console.log('='.repeat(60) + '\n');

  // ── Run orchestrator ───────────────────────────────────────────────────

  const result = await runOrchestrator(
    {
      id: page.id,
      title: page.title,
      path: page.path,
      quality: page.quality,
      readerImportance: page.readerImportance,
    },
    filePath,
    content,
    options,
  );

  // ── Post-process content ───────────────────────────────────────────────

  let finalContent = result.finalContent;
  finalContent = repairFrontmatter(finalContent);
  finalContent = stripRelatedPagesSections(finalContent);

  // ── Write output ───────────────────────────────────────────────────────

  const tempPath = writeTemp(page.id, 'final.mdx', finalContent);
  result.outputPath = tempPath;

  writeTemp(page.id, 'orchestrator-result.json', {
    ...result,
    finalContent: undefined, // Don't duplicate content in JSON
  });

  // ── Report ─────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log('Orchestrator Complete');
  console.log('='.repeat(60));
  console.log(`Duration: ${result.duration}s`);
  console.log(`Tool calls: ${result.toolCallCount}`);
  console.log(`Refinement cycles: ${result.refinementCycles}`);
  console.log(`Cost: ~$${result.totalCost.toFixed(2)}`);
  console.log(`Quality gate: ${result.qualityGatePassed ? 'PASSED' : 'FAILED'}`);
  console.log(`Output: ${tempPath}`);

  if (result.costBreakdown) {
    console.log('\nCost breakdown:');
    for (const [tool, cost] of Object.entries(result.costBreakdown).sort((a, b) => b[1] - a[1])) {
      if (cost > 0) console.log(`  ${tool}: $${cost.toFixed(2)}`);
    }
  }

  // ── Apply or preview ───────────────────────────────────────────────────

  if (dryRun) {
    console.log('\nTo apply changes:');
    console.log(`  cp "${tempPath}" "${filePath}"`);
    console.log('\nOr review the diff:');
    console.log(`  diff "${filePath}" "${tempPath}"`);
  } else {
    fs.writeFileSync(filePath, finalContent);
    console.log(`\nChanges applied to ${filePath}`);

    // Edit log
    appendEditLog(page.id, {
      tool: 'crux-orchestrator-v2',
      agency: 'ai-directed',
      requestedBy: getDefaultRequestedBy(),
      note: directions
        ? `Orchestrator v2 (${tier}): ${directions.slice(0, 100)}`
        : `Orchestrator v2 (${tier})`,
    });

    // Auto-grade
    if (options.grade !== false) {
      console.log('\nRunning grade-content.ts...');
      try {
        execFileSync('node', ['--import', 'tsx/esm', '--no-warnings', 'crux/authoring/grade-content.ts', '--page', page.id, '--apply'], {
          cwd: ROOT,
          stdio: 'inherit',
        });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('Grading failed:', error.message);
      }
    }

    // Session log
    if (!options.skipSessionLog) {
      await autoLogSession(page, tier, result);
    }
  }

  return result;
}
