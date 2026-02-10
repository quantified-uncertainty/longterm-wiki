#!/usr/bin/env node

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
 *   node tooling/content/page-creator.mjs "SecureBio" --tier standard
 *   node tooling/content/page-creator.mjs "Community Notes" --tier premium
 *
 * Module structure (under creator/):
 *   duplicate-detection.mjs  — fuzzy page matching
 *   canonical-links.mjs      — finds Wikipedia, LW, EA Forum links
 *   research.mjs             — Perplexity + SCRY research
 *   source-fetching.mjs      — URL registration, Firecrawl, directions
 *   synthesis.mjs            — Claude article generation
 *   verification.mjs         — source/quote verification
 *   validation.mjs           — validation loop + component imports
 *   grading.mjs              — quality grading
 *   deployment.mjs           — deploy, cross-links, review
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Sub-modules
import { checkForExistingPage } from './creator/duplicate-detection.mjs';
import { findCanonicalLinks } from './creator/canonical-links.mjs';
import { runPerplexityResearch, runScryResearch } from './creator/research.mjs';
import { registerResearchSources, fetchRegisteredSources, processDirections } from './creator/source-fetching.mjs';
import { runSynthesis } from './creator/synthesis.mjs';
import { runSourceVerification } from './creator/verification.mjs';
import { ensureComponentImports, runValidationLoop, runFullValidation } from './creator/validation.mjs';
import { runGrading } from './creator/grading.mjs';
import { createCategoryDirectory, deployToDestination, validateCrossLinks, runReview } from './creator/deployment.mjs';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');
const TEMP_DIR = path.join(ROOT, '.claude/temp/page-creator');

// ============ Configuration ============

const TIERS = {
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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function log(phase, message) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${timestamp}] [${phase}] ${message}`);
}

function getTopicDir(topic) {
  const sanitized = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return path.join(TEMP_DIR, sanitized);
}

function saveResult(topic, filename, data) {
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
function createContext() {
  return { log, saveResult, getTopicDir, ensureDir, ROOT };
}

// ============ Pipeline Runner ============

async function runPipeline(topic, tier = 'standard', directions = null) {
  const config = TIERS[tier];
  if (!config) {
    console.error(`Unknown tier: ${tier}`);
    process.exit(1);
  }

  const phases = directions
    ? ['process-directions', ...config.phases]
    : config.phases;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Page Creator - Cost Optimized`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Topic: "${topic}"`);
  console.log(`Tier: ${config.name} (${config.estimatedCost})`);
  if (directions) {
    console.log(`Directions: ${directions.slice(0, 80)}${directions.length > 80 ? '...' : ''}`);
  }
  console.log(`Phases: ${phases.join(' → ')}`);
  console.log(`${'='.repeat(60)}\n`);

  const pipelineContext = { directions };
  const ctx = createContext();

  const results = {
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
      let result;

      switch (phase) {
        case 'process-directions':
          result = await processDirections(topic, pipelineContext.directions, ctx);
          break;

        case 'canonical-links':
          result = await findCanonicalLinks(topic, ctx);
          results.totalCost += result.cost || 0;
          break;

        case 'research-perplexity':
          result = await runPerplexityResearch(topic, 'standard', ctx);
          results.totalCost += result.cost || 0;
          break;

        case 'research-perplexity-deep':
          result = await runPerplexityResearch(topic, 'deep', ctx);
          results.totalCost += result.cost || 0;
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
          result = await runSynthesis(topic, 'standard', ctx);
          results.totalCost += result.budget || 0;
          break;

        case 'synthesize-fast':
          result = await runSynthesis(topic, 'fast', ctx);
          results.totalCost += 1.0;
          break;

        case 'synthesize-quality':
          result = await runSynthesis(topic, 'quality', ctx);
          results.totalCost += result.budget || 0;
          break;

        case 'verify-sources':
          result = await runSourceVerification(topic, ctx);
          if (result.warnings?.length > 0) {
            log(phase, `Found ${result.warnings.length} potential hallucination(s) - review recommended`);
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

    } catch (error) {
      log(phase, `Failed: ${error.message}`);
      results.phases[phase] = { success: false, error: error.message };

      if (phase.includes('research') || phase.includes('synthesize')) {
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

function printHelp() {
  console.log(`
Page Creator - Cost-Optimized Pipeline

Uses Perplexity for research ($0.10) + Claude for synthesis ($2-3)
Total: $4-6 vs $10+ with all-Claude approach

Usage:
  node tooling/content/page-creator.mjs "<topic>" [options]

Options:
  --tier <tier>            Quality tier: budget, standard, premium (default: standard)
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
  node tooling/content/page-creator.mjs "MIRI" --tier standard
  node tooling/content/page-creator.mjs "Anthropic" --tier premium
  node tooling/content/page-creator.mjs "Lighthaven" --phase grade
  node tooling/content/page-creator.mjs "Some Event" --dest knowledge-base/incidents --create-category "Incidents"
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const topic = args.find(arg => !arg.startsWith('--'));
  const tierIndex = args.indexOf('--tier');
  const tier = tierIndex !== -1 ? args[tierIndex + 1] : 'standard';
  const phaseIndex = args.indexOf('--phase');
  const singlePhase = phaseIndex !== -1 ? args[phaseIndex + 1] : null;
  const destIndex = args.indexOf('--dest');
  const destPath = destIndex !== -1 ? args[destIndex + 1] : null;
  const directionsIndex = args.indexOf('--directions');
  const directions = directionsIndex !== -1 ? args[directionsIndex + 1] : null;
  const createCategoryIndex = args.indexOf('--create-category');
  const createCategoryLabel = createCategoryIndex !== -1 ? args[createCategoryIndex + 1] : null;
  const forceCreate = args.includes('--force');

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
    let result;
    switch (singlePhase) {
      case 'process-directions':
        if (!directions) {
          console.error('Error: --directions required for process-directions phase');
          process.exit(1);
        }
        result = await processDirections(topic, directions, ctx);
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
        result = await runSynthesis(topic, tier === 'premium' ? 'quality' : 'standard', ctx);
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

  await runPipeline(topic, tier, directions);

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
      console.log(`✓ Deployed to: ${deployResult.deployedTo}`);

      // Cross-linking validation
      const entitySlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const crossLinkCheck = validateCrossLinks(deployResult.deployedTo);

      console.log(`\n${'─'.repeat(50)}`);
      if (crossLinkCheck.warnings.length > 0) {
        console.log(`${'\x1b[33m'}Cross-linking issues detected:${'\x1b[0m'}`);
        crossLinkCheck.warnings.forEach(w => console.log(`   - ${w}`));
        console.log(`\n   Outbound EntityLinks (${crossLinkCheck.outboundCount}): ${crossLinkCheck.outboundIds.join(', ') || 'none'}`);
      } else {
        console.log(`${'\x1b[32m'}Cross-linking looks good (${crossLinkCheck.outboundCount} outbound EntityLinks)${'\x1b[0m'}`);
      }

      console.log(`\n${'\x1b[33m'}Cross-linking reminder:${'\x1b[0m'}`);
      console.log(`   After running 'pnpm build', check cross-links:`);
      console.log(`   ${'\x1b[36m'}node tooling/crux.mjs analyze entity-links ${entitySlug}${'\x1b[0m'}`);
      console.log(`\n   This shows pages that mention this entity but don't link to it.`);
      console.log(`   Consider adding EntityLinks to improve wiki connectivity.`);
    } else {
      console.log(`✗ Deployment failed: ${deployResult.error}`);
    }
  } else {
    console.log(`\nTip: Use --dest <path> to deploy directly to content directory`);
    console.log(`   Example: --dest knowledge-base/people`);
  }
}

main().catch(console.error);
