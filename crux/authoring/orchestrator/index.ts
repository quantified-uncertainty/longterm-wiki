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
import { appendEditLog, getDefaultRequestedBy } from '../../lib/session/edit-log.ts';
import { createSession } from '../../lib/wiki-server/sessions.ts';
import { loadPages as loadPagesFromRegistry } from '../../lib/content-types.ts';
import { repairFrontmatter, stripRelatedPagesSections } from '../page-improver/utils.ts';
import { checkForExistingPage } from '../creator/duplicate-detection.ts';
import { deployToDestination, validateCrossLinks } from '../creator/deployment.ts';

import { runOrchestrator, normalizeDollarEscaping } from './orchestrator.ts';
import { generateCreateScaffold } from './scaffold.ts';
import { CREATE_TIER_BUDGETS, type OrchestratorOptions, type OrchestratorResult, type OrchestratorTier, type CreateTier } from './types.ts';

export type { OrchestratorOptions, OrchestratorResult, OrchestratorTier };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../../..');
const TEMP_DIR = path.join(ROOT, '.claude/temp/orchestrator');

const log = createPhaseLogger();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
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
    const displayCost = result.actualTotalCost != null
      ? `$${result.actualTotalCost.toFixed(2)} actual`
      : `~$${result.totalCost.toFixed(2)} estimated`;
    const summary = `Improved "${page.title}" via orchestrator v2 (${tier}, ${result.toolCallCount} tool calls, ${result.refinementCycles} refinement cycles). Quality gate: ${result.qualityGatePassed ? 'passed' : 'failed'}. Cost: ${displayCost}.`;

    const entry = {
      date: today,
      branch,
      title: `Orchestrator v2 (${tier}): ${page.title}`,
      summary,
      model: null,
      duration: `${result.duration}s`,
      cost: result.actualTotalCost != null
        ? `$${result.actualTotalCost.toFixed(2)}`
        : `~$${result.totalCost.toFixed(2)}`,
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
  finalContent = normalizeDollarEscaping(finalContent);

  // ── Write output ───────────────────────────────────────────────────────

  const tempPath = writeTemp(page.id, 'final.mdx', finalContent);
  result.outputPath = tempPath;

  writeTemp(page.id, 'orchestrator-result.json', {
    ...result,
    finalContent: undefined, // Don't duplicate content in JSON
  });

  // ── Report ─────────────────────────────────────────────────────────────

  const costStr = result.actualTotalCost != null
    ? `~$${result.totalCost.toFixed(2)} estimated / $${result.actualTotalCost.toFixed(2)} actual`
    : `~$${result.totalCost.toFixed(2)}`;

  console.log('\n' + '='.repeat(60));
  console.log('Orchestrator Complete');
  console.log('='.repeat(60));
  console.log(`Duration: ${result.duration}s`);
  console.log(`Tool calls: ${result.toolCallCount}`);
  console.log(`Refinement cycles: ${result.refinementCycles}`);
  console.log(`Cost: ${costStr}`);
  console.log(`Quality gate: ${result.qualityGatePassed ? 'PASSED' : 'FAILED'}`);
  console.log(`Output: ${tempPath}`);

  if (result.actualCostBreakdown && Object.keys(result.actualCostBreakdown).length > 0) {
    console.log('\nActual cost breakdown (from API usage):');
    for (const [label, cost] of Object.entries(result.actualCostBreakdown).sort((a, b) => b[1] - a[1])) {
      if (cost > 0) console.log(`  ${label}: $${cost.toFixed(4)}`);
    }
  }

  if (result.costBreakdown) {
    console.log('\nEstimated cost breakdown:');
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
      tool: 'crux-improve',
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

// ---------------------------------------------------------------------------
// Create pipeline (v2)
// ---------------------------------------------------------------------------

export interface OrchestratorCreateOptions {
  /** Create-mode tier (budget/standard/premium). */
  tier?: CreateTier;
  /** Free-text directions for content focus. */
  directions?: string;
  /** Entity type for the page (person, organization, concept, etc.). */
  entityType?: string;
  /** Destination path under content/docs/ (e.g., "knowledge-base/people"). */
  destPath?: string | null;
  /** Skip duplicate detection. */
  force?: boolean;
  /** Model override for orchestrator. */
  orchestratorModel?: string;
  /** Model override for section writer. */
  writerModel?: string;
}

/**
 * Run the V2 orchestrator to create a new wiki page.
 *
 * This is the create-mode counterpart to runOrchestratorPipeline().
 * It generates a scaffold, runs the orchestrator agent to fill it in,
 * and optionally deploys to the content directory.
 */
export async function runOrchestratorCreate(
  topic: string,
  options: OrchestratorCreateOptions = {},
): Promise<OrchestratorResult> {
  const {
    tier = 'standard',
    directions = '',
    entityType = 'concept',
    destPath = null,
    force = false,
  } = options;

  // ── Duplicate check ──────────────────────────────────────────────────────

  if (!force) {
    let duplicateExists = false;
    try {
      console.log(`\nChecking for existing pages similar to "${topic}"...`);
      const { exists, matches } = await checkForExistingPage(topic, ROOT);

      if (matches.length > 0) {
        console.log('\nFound similar existing pages:');
        for (const match of matches) {
          const simPercent = Math.round(match.similarity * 100);
          console.log(`  [${simPercent}%] ${match.title} — ${match.path}`);
        }
        duplicateExists = exists;
        if (!exists) {
          console.log('\n   Partial matches only. Proceeding...\n');
        }
      } else {
        console.log('   No similar pages found. Proceeding...\n');
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.warn(`Duplicate check failed (continuing): ${error.message}`);
    }
    if (duplicateExists) {
      throw new Error(`A page similar to "${topic}" already exists. Use --force to create anyway.`);
    }
  }

  // ── Generate scaffold ──────────────────────────────────────────────────

  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const scaffold = generateCreateScaffold(topic, entityType);

  // ── Set up temp file ───────────────────────────────────────────────────

  const tempDir = path.join(TEMP_DIR, slug);
  ensureDir(tempDir);
  const tempFilePath = path.join(tempDir, 'create.mdx');
  fs.writeFileSync(tempFilePath, scaffold);

  // ── Map create tier to orchestrator budget ─────────────────────────────

  const budget = CREATE_TIER_BUDGETS[tier] || CREATE_TIER_BUDGETS.standard;

  // ── Build page metadata ────────────────────────────────────────────────

  const pageData = {
    id: slug,
    title: topic,
    path: destPath ? `${destPath}/${slug}` : `knowledge-base/${slug}`,
    entityType,
  };

  // ── Print header ───────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log(`Creating: "${topic}" (orchestrator v2)`);
  console.log(`Tier: ${tier} (${budget.name})`);
  console.log(`Entity type: ${entityType}`);
  if (directions) console.log(`Directions: ${directions}`);
  console.log('='.repeat(60) + '\n');

  // ── Run orchestrator in create mode ────────────────────────────────────

  const result = await runOrchestrator(
    pageData,
    tempFilePath,
    scaffold,
    {
      tier: 'standard', // Fallback tier (budget override takes precedence)
      budgetOverride: budget,
      directions,
      mode: 'create',
      topic,
      orchestratorModel: options.orchestratorModel,
      writerModel: options.writerModel,
    },
  );

  // ── Post-process content ───────────────────────────────────────────────
  // normalizeDollarEscaping is already applied inside runOrchestrator()

  let finalContent = result.finalContent;
  finalContent = repairFrontmatter(finalContent);
  finalContent = stripRelatedPagesSections(finalContent);

  // ── Write output ───────────────────────────────────────────────────────

  const finalPath = writeTemp(slug, 'final.mdx', finalContent);
  result.outputPath = finalPath;

  writeTemp(slug, 'orchestrator-result.json', {
    ...result,
    finalContent: undefined,
  });

  // ── Report ─────────────────────────────────────────────────────────────

  const costStr = result.actualTotalCost != null
    ? `~$${result.totalCost.toFixed(2)} estimated / $${result.actualTotalCost.toFixed(2)} actual`
    : `~$${result.totalCost.toFixed(2)}`;

  console.log('\n' + '='.repeat(60));
  console.log('Orchestrator Create Complete');
  console.log('='.repeat(60));
  console.log(`Duration: ${result.duration}s`);
  console.log(`Tool calls: ${result.toolCallCount}`);
  console.log(`Refinement cycles: ${result.refinementCycles}`);
  console.log(`Cost: ${costStr}`);
  console.log(`Quality gate: ${result.qualityGatePassed ? 'PASSED' : 'FAILED'}`);
  console.log(`Output: ${finalPath}`);

  if (result.actualCostBreakdown && Object.keys(result.actualCostBreakdown).length > 0) {
    console.log('\nActual cost breakdown (from API usage):');
    for (const [label, cost] of Object.entries(result.actualCostBreakdown).sort((a, b) => b[1] - a[1])) {
      if (cost > 0) console.log(`  ${label}: $${cost.toFixed(4)}`);
    }
  }

  // ── Deploy if --dest provided ──────────────────────────────────────────

  if (destPath) {
    try {
      console.log(`\nDeploying to content/docs/${destPath}...`);

      // Write final content to a temp draft path the deployer expects
      const draftDir = path.join(ROOT, '.claude/temp/page-creator', slug);
      ensureDir(draftDir);
      const draftPath = path.join(draftDir, 'final.mdx');
      fs.writeFileSync(draftPath, finalContent);

      // Build the context that deployToDestination requires
      // (deployToDestination internally writes an edit-log entry)
      const deployCtx = {
        ROOT,
        getTopicDir: () => draftDir,
        ensureDir: (dir: string) => { fs.mkdirSync(dir, { recursive: true }); },
      };
      const deployResult = deployToDestination(topic, destPath, deployCtx);

      if (deployResult.success) {
        console.log(`Deployed to: ${deployResult.deployedTo}`);
        const crossLinks = validateCrossLinks(deployResult.deployedTo!);
        console.log(`EntityLinks: ${crossLinks.outboundCount}`);
      } else {
        console.error(`Deployment failed: ${deployResult.error}`);
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`Deployment failed: ${error.message}`);
    }
  } else {
    console.log(`\nTo deploy, copy the output file to the content directory:`);
    console.log(`  cp "${finalPath}" content/docs/knowledge-base/<category>/${slug}.mdx`);
  }

  return result;
}
