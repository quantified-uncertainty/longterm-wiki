#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Page Improvement Pipeline — CLI entry point.
 *
 * Multi-phase improvement pipeline with SCRY research and specific directions.
 *
 * Usage:
 *   node crux/authoring/page-improver/index.ts -- <page-id> [options]
 *   node crux/authoring/page-improver/index.ts -- --list
 */

import { fileURLToPath } from 'url';
import fs from 'fs';
import type { PageData, ParsedArgs } from './types.ts';
import { loadPages, findPage, getFilePath } from './utils.ts';
import { runPipeline } from './pipeline.ts';
import { triagePhase } from './phases.ts';

// Re-export public API for any direct importers
export { runPipeline } from './pipeline.ts';
export { triagePhase } from './phases.ts';
export { loadPages, findPage, getFilePath } from './utils.ts';
export type { TriageResult, PipelineResults, PageData, PipelineOptions } from './types.ts';

// ── List pages command ───────────────────────────────────────────────────────

interface ListOptions {
  limit?: number;
  maxQuality?: number;
  minImportance?: number;
}

function listPages(pages: PageData[], options: ListOptions = {}): void {
  const { limit = 20, maxQuality = 80, minImportance = 30 } = options;

  const candidates = pages
    .filter(p => p.quality && p.quality <= maxQuality)
    .filter(p => p.readerImportance && p.readerImportance >= minImportance)
    .filter(p => !p.path.includes('/models/'))
    .map(p => ({
      id: p.id,
      title: p.title,
      quality: p.quality!,
      importance: p.readerImportance!,
      gap: p.readerImportance! - p.quality!
    }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, limit);

  console.log(`\nPages needing improvement (Q<=${maxQuality}, Imp>=${minImportance}):\n`);
  console.log('| # | Q | Imp | Gap | Page |');
  console.log('|---|---|-----|-----|------|');
  candidates.forEach((p, i) => {
    console.log(`| ${i + 1} | ${p.quality} | ${p.importance} | ${p.gap > 0 ? '+' : ''}${p.gap} | ${p.title} (${p.id}) |`);
  });
  console.log(`\nRun: node crux/authoring/page-improver/index.ts -- <page-id> --directions "your directions"`);
}

// ── Argument parser ──────────────────────────────────────────────────────────

function parseArgs(args: string[]): ParsedArgs {
  const opts: ParsedArgs = { _positional: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') continue;
    if (args[i].startsWith('--')) {
      const raw = args[i].slice(2);
      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        opts[raw.slice(0, eqIdx)] = raw.slice(eqIdx + 1);
      } else {
        const key = raw;
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          opts[key] = next;
          i++;
        } else {
          opts[key] = true;
        }
      }
    } else {
      (opts._positional as string[]).push(args[i]);
    }
  }
  return opts;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  if (args.length === 0 || opts.help || opts.h) {
    console.log(`
Page Improvement Pipeline v2

Multi-phase improvement with SCRY research and specific directions.

Usage:
  node crux/authoring/page-improver/index.ts -- <page-id> [options]
  node crux/authoring/page-improver/index.ts -- --list

Options:
  --directions "..."              Specific improvement directions
  --tier <tier>                   polish ($2-3), standard ($5-8), deep ($15-25), or triage (auto)
  --apply                         Apply changes directly (don't just preview)
  --no-grade                      Skip auto-grading after apply (grading runs by default)
  --triage                        Run news-check triage only (no improvement)
  --list                          List pages needing improvement
  --limit N                       Limit list results (default: 20)
  --adversarial-model <model>     Override model for adversarial review (deep tier only)
  --max-adversarial-iterations N  Max adversarial loop iterations, default 2 (deep tier only)

Tiers:
  polish    Quick single-pass, no research (~$2-3)
  standard  Light research + improve + review (default, ~$5-8)
  deep      Full SCRY + web research + adversarial review loop + gap filling (~$15-25)
  triage    Auto-select tier via cheap news check (~$0.08)

Examples:
  node crux/authoring/page-improver/index.ts -- open-philanthropy --directions "add 2024 grants"
  node crux/authoring/page-improver/index.ts -- far-ai --tier deep --directions "add publications"
  node crux/authoring/page-improver/index.ts -- cea --tier deep --max-adversarial-iterations 1
  node crux/authoring/page-improver/index.ts -- cea --tier polish
  node crux/authoring/page-improver/index.ts -- cea --triage
  node crux/authoring/page-improver/index.ts -- --list --limit 30
`);
    return;
  }

  if (opts.list) {
    const pages = loadPages();
    listPages(pages, { limit: parseInt(opts.limit as string) || 20 });
    return;
  }

  const pageId = (opts._positional as string[])[0];
  if (!pageId) {
    console.error('Error: No page ID provided');
    console.error('Try: node crux/authoring/page-improver/index.ts -- --list');
    process.exit(1);
  }

  // Triage-only mode
  if (opts.triage) {
    const pages = loadPages();
    const page = findPage(pages, pageId);
    if (!page) {
      console.error(`Page not found: ${pageId}`);
      process.exit(1);
    }
    const filePath = getFilePath(page.path);
    const content = fs.readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/lastEdited:\s*["']?(\d{4}-\d{2}-\d{2})["']?/);
    const lastEdited = fmMatch?.[1] || 'unknown';
    const result = await triagePhase(page, lastEdited);
    console.log('\nTriage Result:');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  await runPipeline(pageId, {
    tier: (opts.tier as string) || 'standard',
    directions: (opts.directions as string) || '',
    dryRun: !opts.apply,
    grade: opts['no-grade'] ? false : undefined,
    adversarialModel: (opts['adversarial-model'] as string) || undefined,
    maxAdversarialIterations: opts['max-adversarial-iterations']
      ? parseInt(opts['max-adversarial-iterations'] as string, 10)
      : undefined,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
