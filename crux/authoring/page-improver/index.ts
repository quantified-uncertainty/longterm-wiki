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
import { runOrchestratorPipeline } from '../orchestrator/index.ts';
import { runBatch, parseBatchPageIds } from '../batch-runner.ts';
import type { OrchestratorTier } from '../orchestrator/types.ts';

// Re-export public API for any direct importers
export { runPipeline } from './pipeline.ts';
export { runOrchestratorPipeline } from '../orchestrator/index.ts';
export { runBatch, parseBatchPageIds } from '../batch-runner.ts';
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
  --engine v2                     Use agent orchestrator (LLM with modules as tools) instead of fixed pipeline
  --apply                         Apply changes directly (don't just preview)
  --no-grade                      Skip auto-grading after apply (grading runs by default)
  --skip-session-log              Skip auto-posting session log to wiki-server after apply
  --skip-enrich                   Skip post-improve enrichment (entity-links, fact-refs)
  --section-level                 Use per-## section rewriting instead of single-pass improve (#671)
  --citation-gate                 Block --apply when citation audit pass rate is below threshold
  --skip-citation-audit           Skip the post-improve citation audit phase
  --citation-audit-model <model>  Override LLM model for per-citation verification
  --no-save-artifacts             Skip saving intermediate artifacts to wiki-server DB
  --triage                        Run news-check triage only (no improvement)
  --list                          List pages needing improvement
  --limit N                       Limit list results (default: 20)
  --adversarial-model <model>     Override model for adversarial review (deep tier only)
  --max-adversarial-iterations N  Max adversarial loop iterations, default 2 (deep tier only)

Batch mode (V2 only):
  --batch=id1,id2,...             Comma-separated page IDs for batch processing
  --batch-file=pages.txt          File with one page ID per line
  --batch-budget=500              Stop when cumulative cost exceeds this amount ($)
  --page-timeout=900              Per-page timeout in seconds (default: 900 = 15 min)
  --resume                        Skip pages already completed in a previous batch run
  --report-file=report.md         Write summary report to a file
  --quality-report-file=path.json Write quality report JSON (default: .claude/temp/batch-quality-report.json)

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

  // ── Batch mode (V2 only) — checked before pageId so --batch works without positional arg
  if (opts.batch || opts['batch-file']) {
    if (opts.engine !== 'v2') {
      console.error('Batch mode requires --engine=v2');
      process.exit(1);
    }
    const tierStr = (opts.tier as string) || 'standard';
    const tierMap: Record<string, OrchestratorTier> = {
      polish: 'polish', standard: 'standard', deep: 'deep',
    };
    const v2Tier = tierMap[tierStr];
    if (!v2Tier) {
      console.error(`Orchestrator v2 supports tiers: polish, standard, deep (got: ${tierStr})`);
      process.exit(1);
    }

    const pageIds = parseBatchPageIds(
      opts.batch as string | undefined,
      opts['batch-file'] as string | undefined,
    );
    if (pageIds.length === 0) {
      console.error('No page IDs provided. Use --batch=id1,id2 or --batch-file=pages.txt');
      process.exit(1);
    }

    await runBatch({
      pageIds,
      tier: v2Tier,
      directions: (opts.directions as string) || undefined,
      budgetLimit: opts['batch-budget'] ? parseFloat(opts['batch-budget'] as string) : undefined,
      pageTimeout: opts['page-timeout'] ? parseInt(opts['page-timeout'] as string, 10) * 1000 : undefined,
      resume: opts.resume === true,
      apply: opts.apply === true,
      grade: opts['no-grade'] ? false : undefined,
      skipSessionLog: opts['skip-session-log'] === true,
      reportFile: opts['report-file'] as string | undefined,
      qualityReportFile: opts['quality-report-file'] as string | undefined,
    });
    return;
  }

  // ── Single-page modes require a page ID ──────────────────────────────────
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

  // Route to agent orchestrator v2 or fixed pipeline v1
  if (opts.engine === 'v2') {
    const tierStr = (opts.tier as string) || 'standard';
    // Map v1 tiers to v2 tiers (v2 only supports polish/standard/deep)
    const tierMap: Record<string, string> = {
      polish: 'polish',
      standard: 'standard',
      deep: 'deep',
    };
    const v2Tier = tierMap[tierStr];
    if (!v2Tier) {
      console.error(`Orchestrator v2 supports tiers: polish, standard, deep (got: ${tierStr})`);
      process.exit(1);
    }
    await runOrchestratorPipeline(pageId, {
      tier: v2Tier as 'polish' | 'standard' | 'deep',
      directions: (opts.directions as string) || '',
      dryRun: !opts.apply,
      grade: opts['no-grade'] ? false : undefined,
      skipSessionLog: opts['skip-session-log'] === true ? true : undefined,
      saveArtifacts: opts['no-save-artifacts'] === true ? false : undefined,
    });
  } else {
    await runPipeline(pageId, {
      tier: (opts.tier as string) || 'standard',
      directions: (opts.directions as string) || '',
      dryRun: !opts.apply,
      grade: opts['no-grade'] ? false : undefined,
      adversarialModel: (opts['adversarial-model'] as string) || undefined,
      maxAdversarialIterations: opts['max-adversarial-iterations']
        ? parseInt(opts['max-adversarial-iterations'] as string, 10)
        : undefined,
      skipSessionLog: opts['skip-session-log'] === true ? true : undefined,
      skipEnrich: opts['skip-enrich'] === true ? true : undefined,
      sectionLevel: opts['section-level'] === true ? true : undefined,
      citationGate: opts['citation-gate'] === true ? true : undefined,
      skipCitationAudit: opts['skip-citation-audit'] === true ? true : undefined,
      citationAuditModel: (opts['citation-audit-model'] as string) || undefined,
      saveArtifacts: opts['no-save-artifacts'] === true ? false : undefined,
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}