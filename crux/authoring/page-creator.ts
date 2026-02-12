#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Page Creator - Cost-Optimized Pipeline (CLI Entry Point)
 *
 * Uses Perplexity for research (cheap, good at web search)
 * Uses Claude for synthesis and validation iteration
 *
 * Cost breakdown (standard tier):
 * - Research: ~$0.10 (12 Perplexity queries)
 * - SCRY search: Free
 * - Extraction: ~$0.50 (Gemini Flash)
 * - Synthesis: ~$2.00 (Claude Sonnet)
 * - Validation loop: ~$1.50 (Claude Code SDK, iterates until passing)
 * Total: ~$4-5 vs $10+ with all-Claude approach
 *
 * Usage:
 *   node crux/authoring/page-creator.ts "SecureBio" --tier standard
 *   node crux/authoring/page-creator.ts "Community Notes" --tier premium
 *
 * Module structure (under creator/):
 *   duplicate-detection.ts   — fuzzy page matching
 *   canonical-links.ts       — finds Wikipedia, LW, EA Forum links
 *   research.ts              — Perplexity + SCRY research
 *   source-fetching.ts       — URL registration, Firecrawl, directions
 *   synthesis.ts             — Claude article generation
 *   verification.ts          — source/quote verification
 *   validation.ts            — validation loop + component imports
 *   grading.ts               — quality grading
 *   deployment.ts            — deploy, cross-links, review
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Sub-modules
import { checkForExistingPage } from './creator/duplicate-detection.ts';
import { findCanonicalLinks } from './creator/canonical-links.ts';
import { runPerplexityResearch, runScryResearch } from './creator/research.ts';
import { registerResearchSources, fetchRegisteredSources, processDirections, loadSourceFile } from './creator/source-fetching.ts';
import { runSynthesis } from './creator/synthesis.ts';
import { runSourceVerification } from './creator/verification.ts';
import { ensureComponentImports, runValidationLoop, runFullValidation } from './creator/validation.ts';
import { runGrading } from './creator/grading.ts';
import { createCategoryDirectory, deployToDestination, validateCrossLinks, runReview } from './creator/deployment.ts';
import { inferEntityType } from '../lib/category-entity-types.ts';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT: string = path.join(__dirname, '../..');
const TEMP_DIR: string = path.join(ROOT, '.claude/temp/page-creator');

// ============ Configuration ============

interface TierConfig {
  name: string;
  estimatedCost: string;
  phases: string[];
  description: string;
}

const TIERS: Record<string, TierConfig> = {
  budget: {
    name: 'Budget',
    estimatedCost: '$2-3',
    phases: ['canonical-links', 'research-perplexity', 'synthesize-fast', 'verify-sources', 'validate-loop', 'validate-full', 'grade'],
    description: 'Perplexity research + fast synthesis'
  },
  standard: {
    name: 'Standard',
    estimatedCost: '$4-6',
    phases: ['canonical-links', 'research-perplexity', 'register-sources', 'fetch-sources', 'research-scry', 'synthesize', 'verify-sources', 'validate-loop', 'review', 'validate-full', 'grade'],
    description: 'Full research + source fetching + Sonnet synthesis + validation loop'
  },
  premium: {
    name: 'Premium',
    estimatedCost: '$8-12',
    phases: ['canonical-links', 'research-perplexity-deep', 'register-sources', 'fetch-sources', 'research-scry', 'synthesize-quality', 'verify-sources', 'review', 'validate-loop', 'validate-full', 'grade'],
    description: 'Deep research + source fetching + quality synthesis + review'
  }
};

// ============ Utility Functions ============

interface PipelineContext {
  log: (phase: string, message: string) => void;
  saveResult: (topic: string, filename: string, data: string | object) => string;
  getTopicDir: (topic: string) => string;
  ensureDir: (dirPath: string) => void;
  ROOT: string;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function log(phase: string, message: string): void {
  const timestamp: string = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${timestamp}] [${phase}] ${message}`);
}

function getTopicDir(topic: string): string {
  const sanitized = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return path.join(TEMP_DIR, sanitized);
}

function saveResult(topic: string, filename: string, data: string | object): string {
  const dir = getTopicDir(topic);
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  if (typeof data === 'string') {
    fs.writeFileSync(filePath, data);
  } else {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }
  return filePath;
}

/**
 * Context object passed to sub-modules so they can use shared utilities
 * without relying on closures over module-scoped variables.
 */
function createContext(): PipelineContext {
  return { log, saveResult, getTopicDir, ensureDir, ROOT };
}

// ============ Pipeline Runner ============

interface PipelineResults {
  topic: string;
  tier: string;
  startTime: string;
  endTime?: string;
  phases: Record<string, { success: boolean; [key: string]: unknown }>;
  totalCost: number;
}

async function runPipeline(topic: string, tier: string = 'standard', directions: string | null = null, sourceFilePath: string | null = null, destPath: string | null = null): Promise<PipelineResults> {
  const config = TIERS[tier];
  if (!config) {
    console.error(`Unknown tier: ${tier}`);
    process.exit(1);
  }

  let phases: string[] = directions
    ? ['process-directions', ...config.phases]
    : [...config.phases];

  // When --source-file is used, skip research phases and inject load-source-file
  if (sourceFilePath) {
    const researchPhases = ['research-perplexity', 'research-perplexity-deep', 'research-scry', 'register-sources', 'fetch-sources'];
    phases = phases.filter(p => !researchPhases.includes(p));
    const canonicalIdx = phases.indexOf('canonical-links');
    phases.splice(canonicalIdx + 1, 0, 'load-source-file');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Page Creator - Cost Optimized`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Topic: "${topic}"`);
  console.log(`Tier: ${config.name} (${config.estimatedCost})`);
  if (sourceFilePath) {
    console.log(`Source file: ${sourceFilePath}`);
  }
  if (directions) {
    console.log(`Directions: ${directions.slice(0, 80)}${directions.length > 80 ? '...' : ''}`);
  }
  console.log(`Phases: ${phases.join(' → ')}`);
  console.log(`${'='.repeat(60)}\n`);

  const pipelineContext: { directions: string | null; sourceFilePath: string | null } = { directions, sourceFilePath };
  const ctx = createContext();

  const results: PipelineResults = {
    topic,
    tier,
    startTime: new Date().toISOString(),
    phases: {},
    totalCost: 0
  };

  for (const phase of phases) {
    console.log(`\n${'─'.repeat(50)}`);
    log(phase, 'Starting...');

    try {
      let result: Record<string, unknown>;

      switch (phase) {
        case 'process-directions':
          result = await processDirections(topic, pipelineContext.directions, ctx);
          break;

        case 'load-source-file':
          result = await loadSourceFile(topic, pipelineContext.sourceFilePath!, ctx);
          break;

        case 'canonical-links':
          result = await findCanonicalLinks(topic, ctx);
          results.totalCost += (result.cost as number) || 0;
          break;

        case 'research-perplexity':
          result = await runPerplexityResearch(topic, 'standard', ctx);
          results.totalCost += (result.cost as number) || 0;
          break;

        case 'research-perplexity-deep':
          result = await runPerplexityResearch(topic, 'deep', ctx);
          results.totalCost += (result.cost as number) || 0;
          break;

        case 'research-scry':
          result = await runScryResearch(topic, ctx);
          break;

        case 'register-sources':
          result = await registerResearchSources(topic, ctx);
          break;

        case 'fetch-sources':
          result = await fetchRegisteredSources(topic, { maxSources: 15 }, ctx);
          break;

        case 'synthesize':
          result = await runSynthesis(topic, 'standard', ctx, destPath);
          results.totalCost += (result.budget as number) || 0;
          break;

        case 'synthesize-fast':
          result = await runSynthesis(topic, 'fast', ctx, destPath);
          results.totalCost += 1.0;
          break;

        case 'synthesize-quality':
          result = await runSynthesis(topic, 'quality', ctx, destPath);
          results.totalCost += (result.budget as number) || 0;
          break;

        case 'verify-sources':
          result = await runSourceVerification(topic, ctx);
          if ((result.warnings as Array<unknown>)?.length > 0) {
            log(phase, `Found ${(result.warnings as Array<unknown>).length} potential hallucination(s) - review recommended`);
          }
          break;

        case 'review':
          result = await runReview(topic, ctx);
          results.totalCost += 1.0;
          break;

        case 'validate-loop':
          // Auto-fix missing component imports before validation
          {
            const draftPath = path.join(getTopicDir(topic), 'draft.mdx');
            const importResult = ensureComponentImports(draftPath);
            if (importResult.fixed) {
              log('validate-loop', `Auto-fixed missing imports: ${importResult.added.join(', ')}`);
            }
          }
          result = await runValidationLoop(topic, ctx);
          results.totalCost += 2.0;
          break;

        case 'validate-full':
          result = await runFullValidation(topic, ctx);
          if (!result.success) {
            log(phase, 'Critical validation failures - page may break build');
          }
          break;

        case 'grade':
          result = await runGrading(topic, ctx);
          results.totalCost += 0.01;
          break;

        default:
          log(phase, `Unknown phase: ${phase}`);
          continue;
      }

      results.phases[phase] = { success: true, ...result };
      log(phase, 'Complete');

    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log(phase, `Failed: ${error.message}`);
      results.phases[phase] = { success: false, error: error.message };

      if (phase.includes('research') || phase.includes('synthesize') || phase === 'load-source-file') {
        break;
      }
    }
  }

  results.endTime = new Date().toISOString();

  saveResult(topic, 'pipeline-results.json', results);

  console.log(`\n${'='.repeat(60)}`);
  console.log('Pipeline Complete');
  console.log(`${'='.repeat(60)}`);
  console.log(`Estimated cost: ~$${results.totalCost.toFixed(2)}`);

  const finalPath = path.join(getTopicDir(topic), 'final.mdx');
  const draftPath = path.join(getTopicDir(topic), 'draft.mdx');

  if (fs.existsSync(finalPath)) {
    console.log(`\nFinal article: ${finalPath}`);
  } else if (fs.existsSync(draftPath)) {
    console.log(`\nDraft article: ${draftPath}`);
  }

  return results;
}

// ============ CLI ============

function printHelp(): void {
  console.log(`
Page Creator - Cost-Optimized Pipeline

Uses Perplexity for research ($0.10) + Claude for synthesis ($2-3)
Total: $4-6 vs $10+ with all-Claude approach

Usage:
  node crux/authoring/page-creator.ts "<topic>" [options]

Options:
  --tier <tier>            Quality tier: budget, standard, premium (default: standard)
  --source-file <path>     Use a local file as research input (skips web research phases)
  --dest <path>            Deploy to content path (e.g., knowledge-base/people)
  --create-category <name> Create new category with index.mdx
  --directions <text>      Context, source URLs, and editorial guidance (see below)
  --phase <phase>          Run a single phase only (for resuming/testing)
  --force                  Skip duplicate page check (create even if similar page exists)
  --help                   Show this help

Directions:
  Pass a text block with any combination of:
  - Source URLs (will be fetched and included in research)
  - Context the user knows about the topic
  - Editorial guidance (e.g., "be skeptical", "focus on X")

  Example:
    --directions "Primary source: https://example.com/article
    I've heard criticisms that this is overhyped.
    Focus on skeptical perspectives and consider source incentives."

Destination Examples:
  --dest knowledge-base/people
  --dest knowledge-base/organizations/safety-orgs
  --dest knowledge-base/organizations/political-advocacy

Phases:
  canonical-links       Find Wikipedia, LessWrong, EA Forum, official sites
  load-source-file      Load local file as research input (used with --source-file)
  research-perplexity   Perplexity web research
  register-sources      Register citation URLs in knowledge database
  fetch-sources         Fetch actual page content via Firecrawl
  research-scry         Scry knowledge base search
  synthesize            Claude synthesis to MDX
  verify-sources        Check quotes against fetched source content
  validate-loop         Iterative Claude validation
  validate-full         Comprehensive programmatic validation
  grade                 Quality grading

Tiers:
${Object.entries(TIERS).map(([key, config]) =>
    `  ${key.padEnd(10)} ${config.estimatedCost.padEnd(10)} ${config.description}`
  ).join('\n')}

Examples:
  node crux/authoring/page-creator.ts "MIRI" --tier standard
  node crux/authoring/page-creator.ts "Anthropic" --tier premium
  node crux/authoring/page-creator.ts "Lighthaven" --phase grade
  node crux/authoring/page-creator.ts "Some Event" --dest knowledge-base/incidents --create-category "Incidents"
  node crux/authoring/page-creator.ts "SecureBio" --source-file ./reports/securebio-analysis.md
  node crux/authoring/page-creator.ts "SecureBio" --source-file ./notes.txt --directions "Focus on policy"
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  // Use shared parseCliArgs for consistent --key=value handling
  const { parseCliArgs } = await import('../lib/cli.ts');
  const parsed = parseCliArgs(args);

  const topic: string | undefined = parsed._positional[0];
  const tier: string = (parsed.tier as string) || 'standard';
  const singlePhase: string | null = (parsed.phase as string) || null;
  const destPath: string | null = (parsed.dest as string) || null;
  const directions: string | null = (parsed.directions as string) || null;
  const sourceFilePath: string | null = parsed['source-file'] ? path.resolve(parsed['source-file'] as string) : null;
  const createCategoryLabel: string | null = (parsed['create-category'] as string) || null;
  const forceCreate: boolean = parsed.force === true;

  if (sourceFilePath && !fs.existsSync(sourceFilePath)) {
    console.error(`Error: Source file not found: ${sourceFilePath}`);
    process.exit(1);
  }

  if (!topic) {
    console.error('Error: Topic required');
    printHelp();
    process.exit(1);
  }

  // Check for existing pages with similar names (skip for single phases)
  if (!singlePhase && !forceCreate) {
    console.log(`\nChecking for existing pages similar to "${topic}"...`);
    const { exists, matches } = await checkForExistingPage(topic, ROOT);

    if (matches.length > 0) {
      console.log('\nFound similar existing pages:');
      for (const match of matches) {
        const simPercent = Math.round(match.similarity * 100);
        const indicator = match.similarity >= 0.9 ? 'EXACT' : match.similarity >= 0.8 ? 'CLOSE' : 'PARTIAL';
        console.log(`  [${indicator}] ${match.title} (${simPercent}% similar)`);
        console.log(`     Path: ${match.path}`);
      }

      if (exists) {
        console.log('\nA page with this name likely already exists.');
        console.log('   Use --force to create anyway, or choose a different topic.\n');
        process.exit(1);
      } else {
        console.log('\n   These are partial matches. Proceeding with page creation...\n');
      }
    } else {
      console.log('   No similar pages found. Proceeding...\n');
    }
  }

  ensureDir(TEMP_DIR);
  const ctx = createContext();

  // If running a single phase, execute just that phase
  if (singlePhase) {
    console.log(`Running single phase: ${singlePhase} for "${topic}"`);
    let result: unknown;
    switch (singlePhase) {
      case 'process-directions':
        if (!directions) {
          console.error('Error: --directions required for process-directions phase');
          process.exit(1);
        }
        result = await processDirections(topic, directions, ctx);
        break;
      case 'load-source-file':
        if (!sourceFilePath) {
          console.error('Error: --source-file required for load-source-file phase');
          process.exit(1);
        }
        result = await loadSourceFile(topic, sourceFilePath, ctx);
        break;
      case 'canonical-links':
        result = await findCanonicalLinks(topic, ctx);
        break;
      case 'research-perplexity':
        result = await runPerplexityResearch(topic, 'standard', ctx);
        break;
      case 'research-scry':
        result = await runScryResearch(topic, ctx);
        break;
      case 'register-sources':
        result = await registerResearchSources(topic, ctx);
        break;
      case 'fetch-sources':
        result = await fetchRegisteredSources(topic, { maxSources: 15 }, ctx);
        break;
      case 'synthesize':
        result = await runSynthesis(topic, tier === 'premium' ? 'quality' : 'standard', ctx, destPath);
        break;
      case 'verify-sources':
        result = await runSourceVerification(topic, ctx);
        break;
      case 'validate-loop':
        // Auto-fix missing component imports before validation
        {
          const draftPath = path.join(getTopicDir(topic), 'draft.mdx');
          const importResult = ensureComponentImports(draftPath);
          if (importResult.fixed) {
            log('validate-loop', `Auto-fixed missing imports: ${importResult.added.join(', ')}`);
          }
        }
        result = await runValidationLoop(topic, ctx);
        break;
      case 'validate-full':
        result = await runFullValidation(topic, ctx);
        break;
      case 'grade':
        result = await runGrading(topic, ctx);
        break;
      default:
        console.error(`Unknown phase: ${singlePhase}`);
        process.exit(1);
    }
    console.log('Result:', JSON.stringify(result, null, 2));
    return;
  }

  await runPipeline(topic, tier, directions, sourceFilePath, destPath);

  // Deploy to destination if --dest provided
  if (destPath) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log('Deploying to content directory...');

    if (createCategoryLabel) {
      console.log(`Creating category: ${createCategoryLabel}`);
      createCategoryDirectory(destPath, createCategoryLabel, ROOT);
    }

    const deployResult = deployToDestination(topic, destPath, ctx);

    if (deployResult.success) {
      console.log(`ok Deployed to: ${deployResult.deployedTo}`);

      // Cross-linking validation
      const entitySlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const crossLinkCheck = validateCrossLinks(deployResult.deployedTo!);

      const { getColors } = await import('../lib/output.ts');
      const c = getColors();
      console.log(`\n${'─'.repeat(50)}`);
      if (crossLinkCheck.warnings.length > 0) {
        console.log(`${c.yellow}Cross-linking issues detected:${c.reset}`);
        crossLinkCheck.warnings.forEach((w: string) => console.log(`   - ${w}`));
        console.log(`\n   Outbound EntityLinks (${crossLinkCheck.outboundCount}): ${crossLinkCheck.outboundIds.join(', ') || 'none'}`);
      } else {
        console.log(`${c.green}Cross-linking looks good (${crossLinkCheck.outboundCount} outbound EntityLinks)${c.reset}`);
      }

      // Entity type check — warn if deploying to entity-required category without entityType
      const expectedType = inferEntityType(destPath);
      if (expectedType) {
        const deployedContent = fs.readFileSync(deployResult.deployedTo!, 'utf-8');
        const hasEntityType = /^entityType:/m.test(deployedContent);
        if (!hasEntityType) {
          console.log(`\n${c.yellow}WARNING: No entityType in frontmatter${c.reset}`);
          console.log(`   Category "${destPath}" expects entityType: "${expectedType}"`);
          console.log(`   Without it, this page will fail the CI entity test.`);
          console.log(`   Add to frontmatter: entityType: "${expectedType}"`);
        } else {
          console.log(`\n${c.green}Entity type set in frontmatter${c.reset}`);
        }
      }

      console.log(`\n${c.yellow}Cross-linking reminder:${c.reset}`);
      console.log(`   After running 'pnpm build', check cross-links:`);
      console.log(`   ${c.cyan}node crux/crux.mjs analyze entity-links ${entitySlug}${c.reset}`);
      console.log(`\n   This shows pages that mention this entity but don't link to it.`);
      console.log(`   Consider adding EntityLinks to improve wiki connectivity.`);
    } else {
      console.log(`FAIL Deployment failed: ${deployResult.error}`);
    }
  } else {
    console.log(`\nTip: Use --dest <path> to deploy directly to content directory`);
    console.log(`   Example: --dest knowledge-base/people`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
