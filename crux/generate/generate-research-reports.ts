#!/usr/bin/env node

/**
 * Research Report Generator
 *
 * Identifies AI Transition Model pages that need research reports and generates
 * prompts for Claude Code Task agents.
 *
 * Usage:
 *   node crux/generate/generate-research-reports.ts --list              # List candidates
 *   node crux/generate/generate-research-reports.ts <entity-id>         # Show prompt for one
 *   node crux/generate/generate-research-reports.ts --batch 3           # Generate batch prompts
 *
 * To run in parallel with Claude Code:
 *   1. Run this script to get prompts
 *   2. In Claude Code, spawn multiple Task agents with the prompts
 *
 * Cost estimates (per report):
 *   - Opus: ~$2-4 (highest quality)
 *   - Sonnet: ~$0.50-1 (good balance)
 *   - Haiku: ~$0.10-0.20 (fastest, lower quality)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');

interface TransitionModelEntity {
  id: string;
  title: string;
  type: string;
  path: string;
  parentFactor?: string;
  relatedEntries?: Array<{ id: string; relationship?: string }>;
}

interface Candidate {
  id: string;
  title: string;
  path: string;
  parentFactor?: string;
  hasReport: boolean;
}

// Parse args
import { parseCliArgs } from '../lib/cli.ts';

const parsed = parseCliArgs(process.argv.slice(2));

const LIST_MODE = parsed.list === true;
const BATCH_SIZE = parseInt((parsed.batch as string) || '0');
const SPECIFIC_ID = parsed._positional[0] || undefined;

// Load AI Transition Model data (merged from multiple YAML files)
function loadTransitionModelData(): TransitionModelEntity[] {
  const entitiesDir = path.join(ROOT, 'data/entities');
  const atmFiles = fs.readdirSync(entitiesDir)
    .filter(f => f.startsWith('ai-transition-model') && f.endsWith('.yaml'));
  let entities: TransitionModelEntity[] = [];
  for (const file of atmFiles) {
    const content = fs.readFileSync(path.join(entitiesDir, file), 'utf-8');
    const parsed = parseYaml(content) as TransitionModelEntity | TransitionModelEntity[];
    if (Array.isArray(parsed)) entities.push(...parsed);
    else if (parsed) entities.push(parsed);
  }
  return entities;
}

// Build a set of entity IDs that have research reports (by checking frontmatter topic field)
function getEntitiesWithReports(): Set<string> {
  const reportsDir = path.join(ROOT, 'content/docs/knowledge-base/research-reports');
  const entityIds = new Set<string>();

  if (!fs.existsSync(reportsDir)) return entityIds;

  const files = fs.readdirSync(reportsDir).filter(f => f.endsWith('.mdx') && f !== 'index.mdx');

  for (const file of files) {
    const content = fs.readFileSync(path.join(reportsDir, file), 'utf-8');
    const topicMatch = content.match(/^topic:\s*["']?([^"'\n]+)["']?\s*$/m);
    if (topicMatch) {
      entityIds.add(topicMatch[1]);
    }
  }

  return entityIds;
}

// Check if research report exists for an entity
const entitiesWithReports = getEntitiesWithReports();
function hasResearchReport(entityId: string): boolean {
  return entitiesWithReports.has(entityId);
}

// Get candidates for research reports (subitems without reports)
function getCandidates(entities: TransitionModelEntity[]): Candidate[] {
  return entities
    .filter(e => e.type === 'ai-transition-model-subitem')
    .filter(e => !hasResearchReport(e.id))
    .map(e => ({
      id: e.id,
      title: e.title,
      path: e.path,
      parentFactor: e.parentFactor,
      hasReport: false
    }));
}

// Generate the prompt for a research report
function generatePrompt(entity: Candidate | TransitionModelEntity): string {
  const slug = entity.id.replace('tmc-', '');

  return `Create a research report for the AI Transition Model page: ${entity.title}

## Target
- Entity ID: ${entity.id}
- Page URL: ${entity.path}
- Output file: content/docs/knowledge-base/research-reports/${slug}.mdx

## Instructions

Follow the research-report skill (.claude/skills/research-report/SKILL.md):

1. **Load Context First**
   - Read the existing page at content/docs/ai-transition-model/${entity.path.replace('/ai-transition-model/', '')}.mdx
   - Follow the existing wiki page conventions and formatting
   - Read an example report at content/docs/knowledge-base/research-reports/gradual-ai-takeover.mdx

2. **Web Research** (5-10 searches)
   - Academic sources: "[topic]" site:arxiv.org OR site:nature.com
   - Policy sources: "[topic]" site:rand.org OR site:brookings.edu
   - Recent news: "[topic]" AI safety 2024 OR 2025

3. **Write Report** with required sections:
   - Executive Summary (TABLE format - not bullets)
   - Background (with Aside callouts)
   - Key Findings (organized by theme)
   - Causal Factors (TABLE format - Primary/Secondary/Minor)
   - Open Questions (TABLE format)
   - Sources (organized by type)
   - AI Transition Model Context

4. **Formatting Requirements**
   - Use TABLES, not bullet lists for structured data
   - Escape all dollar signs: \\$100K not $100K
   - Include 4+ Asides (callouts) for key insights
   - Dates in frontmatter must be unquoted: createdAt: 2025-01-08

5. **Frontmatter**
\`\`\`yaml
---
title: "${entity.title}: Research Report"
description: "[Key finding with specific data]"
topic: "${entity.id}"
createdAt: ${new Date().toISOString().split('T')[0]}
lastUpdated: ${new Date().toISOString().split('T')[0]}
researchDepth: "standard"
sources: ["web", "codebase"]
sidebar:
  order: 10
---
\`\`\`

6. **After Writing**
   - Update the index at content/docs/knowledge-base/research-reports/index.mdx
   - Add relatedContent.researchReports to the entity in data/entities/ai-transition-model.yaml
   - Run: pnpm build

This is a RESEARCH task - use WebSearch extensively to find real citations.`;
}

// List candidates
function listCandidates(candidates: Candidate[]): void {
  console.log('\n📊 AI Transition Model pages without research reports:\n');
  console.log('| # | Entity ID | Title | Parent |');
  console.log('|---|-----------|-------|--------|');
  candidates.forEach((c, i) => {
    console.log(`| ${i + 1} | ${c.id} | ${c.title} | ${c.parentFactor} |`);
  });
  console.log(`\nTotal: ${candidates.length} pages need research reports`);
  console.log('\nTo generate a report:');
  console.log('  node crux/generate/generate-research-reports.ts <entity-id>');
  console.log('\nTo generate batch prompts:');
  console.log('  node crux/generate/generate-research-reports.ts --batch 3');
}

// Show prompt for one entity
function showPrompt(entity: Candidate | TransitionModelEntity): void {
  console.log('\n' + '='.repeat(70));
  console.log(`📝 RESEARCH REPORT PROMPT: ${entity.title}`);
  console.log('='.repeat(70) + '\n');
  console.log(generatePrompt(entity));
  console.log('\n' + '='.repeat(70));
  console.log('\nTo run in Claude Code:');
  console.log('  Task({ subagent_type: "general-purpose", prompt: `<paste above>` })');
}

// Generate batch prompts for parallel execution
function generateBatch(candidates: Candidate[], batchSize: number): void {
  const batch = candidates.slice(0, batchSize);

  console.log('\n' + '='.repeat(70));
  console.log(`📦 BATCH PROMPTS FOR ${batch.length} RESEARCH REPORTS`);
  console.log('='.repeat(70));
  console.log('\nCost estimate:');
  console.log(`  - Opus: ~$${(batch.length * 3).toFixed(0)}-${(batch.length * 4).toFixed(0)}`);
  console.log(`  - Sonnet: ~$${(batch.length * 0.5).toFixed(1)}-${(batch.length * 1).toFixed(0)}`);
  console.log('\nTo run in parallel in Claude Code, use multiple Task calls:\n');

  console.log('```javascript');
  console.log('// Run these Task agents in parallel:');
  batch.forEach((entity, i) => {
    console.log(`
// Report ${i + 1}: ${entity.title}
Task({
  subagent_type: "general-purpose",
  model: "sonnet",  // or "opus" for higher quality
  run_in_background: true,
  prompt: \`${generatePrompt(entity).replace(/`/g, '\\`')}\`
})`);
  });
  console.log('```');

  console.log('\n' + '='.repeat(70));
  console.log('\nAlternatively, run sequentially with:');
  batch.forEach((entity, i) => {
    console.log(`  ${i + 1}. node crux/generate/generate-research-reports.ts ${entity.id}`);
  });
}

// Main
function main(): void {
  if (parsed.help === true || parsed.h === true) {
    console.log(`
Research Report Generator

Identifies AI Transition Model pages that need research reports.

Usage:
  node crux/generate/generate-research-reports.ts --list              List all candidates
  node crux/generate/generate-research-reports.ts <entity-id>         Show prompt for one
  node crux/generate/generate-research-reports.ts --batch 3           Generate batch prompts

Options:
  --list          List pages without research reports
  --batch <n>     Generate prompts for n reports (for parallel execution)
  --help          Show this help

Cost Estimates (per report):
  Opus:   ~$2-4   (highest quality, best for complex topics)
  Sonnet: ~$0.50-1 (good balance, recommended for batch)
  Haiku:  ~$0.10-0.20 (fast but lower quality)

Example Workflow:
  1. List candidates:  node crux/generate/generate-research-reports.ts --list
  2. Generate batch:   node crux/generate/generate-research-reports.ts --batch 5
  3. Run in Claude Code with parallel Task agents
`);
    return;
  }

  const entities = loadTransitionModelData();
  const candidates = getCandidates(entities);

  if (LIST_MODE) {
    listCandidates(candidates);
    return;
  }

  if (BATCH_SIZE > 0) {
    generateBatch(candidates, BATCH_SIZE);
    return;
  }

  if (SPECIFIC_ID) {
    const entity = entities.find(e => e.id === SPECIFIC_ID || e.id === `tmc-${SPECIFIC_ID}`);
    if (!entity) {
      console.error(`Error: Entity not found: ${SPECIFIC_ID}`);
      console.log('Try: node crux/generate/generate-research-reports.ts --list');
      process.exit(1);
    }
    showPrompt(entity);
    return;
  }

  // Default: show help
  console.log('Run with --help for usage information');
  console.log('Run with --list to see candidates');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
