/**
 * Auto-Update Command Handlers
 *
 * News-driven wiki auto-update system.
 * Fetches news from configured sources, routes to wiki pages,
 * and executes improvements automatically.
 *
 * Subcommands:
 *   run       Full pipeline: fetch → digest → route → update
 *   digest    Fetch sources and show the news digest (no updates)
 *   plan      Show what would be updated without executing
 *   sources   List configured news sources
 *   history   Show past auto-update runs
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '../lib/output.ts';
import { PROJECT_ROOT, loadPages } from '../lib/content-types.ts';
import {
  runPipeline,
  fetchAllSources,
  buildDigest,
  routeDigest,
  loadSources,
  loadFetchTimes,
  loadSeenItems,
} from '../auto-update/index.ts';
import type { AutoUpdateOptions, RunReport } from '../auto-update/types.ts';
import type { CommandResult } from '../lib/cli.ts';

const RUNS_DIR = join(PROJECT_ROOT, 'data/auto-update/runs');

// ── Commands ────────────────────────────────────────────────────────────────

/**
 * Full auto-update pipeline
 */
async function run(args: string[], options: AutoUpdateOptions): Promise<CommandResult> {
  const { report, reportPath } = await runPipeline(options);

  if (options.json || options.ci) {
    return { output: JSON.stringify(report, null, 2), exitCode: 0 };
  }

  return { output: '', exitCode: report.execution.pagesFailed > 0 ? 1 : 0 };
}

/**
 * Fetch sources and show digest only (no routing or updates)
 */
async function digest(args: string[], options: AutoUpdateOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const sourceIds = options.sources ? options.sources.split(',').map(s => s.trim()) : undefined;
  const verbose = options.verbose || false;

  console.log(`Fetching news sources...`);
  const fetchResult = await fetchAllSources(sourceIds, verbose);
  console.log(`Fetched ${fetchResult.items.length} items from ${fetchResult.fetchedSources.length} sources`);

  if (fetchResult.items.length === 0) {
    return { output: 'No new items found.', exitCode: 0 };
  }

  // Load entity IDs for classification (auto-builds data layer if missing)
  const entityIds = loadPages().map(p => p.id).filter((id): id is string => Boolean(id));

  console.log(`\nBuilding digest...`);
  const previouslySeen = loadSeenItems();
  const newsDigest = await buildDigest(
    fetchResult.items,
    fetchResult.fetchedSources,
    fetchResult.failedSources.map(f => f.id),
    { entityIds, previouslySeen, verbose },
  );

  if (options.json || options.ci) {
    return { output: JSON.stringify(newsDigest, null, 2), exitCode: 0 };
  }

  const c = log.colors;
  let output = '';

  output += `\n${c.bold}${c.blue}News Digest — ${newsDigest.date}${c.reset}\n`;
  output += `${c.dim}${newsDigest.itemCount} relevant items from ${newsDigest.fetchedSources.length} sources${c.reset}\n`;

  if (newsDigest.failedSources.length > 0) {
    output += `${c.yellow}Failed sources: ${newsDigest.failedSources.join(', ')}${c.reset}\n`;
  }

  output += `\n${c.bold}  Score  Source           Title${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(80)}${c.reset}\n`;

  for (const item of newsDigest.items.slice(0, 30)) {
    const scoreColor = item.relevanceScore >= 70 ? c.green
      : item.relevanceScore >= 40 ? c.yellow : c.dim;
    output += `  ${scoreColor}${String(item.relevanceScore).padStart(5)}${c.reset}  `;
    output += `${item.sourceId.padEnd(17).slice(0, 17)} `;
    output += `${item.title.slice(0, 55)}\n`;
  }

  if (newsDigest.itemCount > 30) {
    output += `\n${c.dim}Showing 30 of ${newsDigest.itemCount} items${c.reset}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Show what would be updated without executing (fetch + digest + route)
 */
async function plan(args: string[], options: AutoUpdateOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const sourceIds = options.sources ? options.sources.split(',').map(s => s.trim()) : undefined;
  const verbose = options.verbose || false;
  const budget = parseFloat(options.budget || '50');
  const maxPages = parseInt(options.count || '10', 10);

  console.log(`Fetching news sources...`);
  const fetchResult = await fetchAllSources(sourceIds, verbose);

  if (fetchResult.items.length === 0) {
    return { output: 'No new items found. Nothing to plan.', exitCode: 0 };
  }

  console.log(`Building digest...`);
  const pagesPath = join(PROJECT_ROOT, 'app/src/data/pages.json');
  let entityIds: string[] = [];
  if (existsSync(pagesPath)) {
    try {
      const pages = JSON.parse(readFileSync(pagesPath, 'utf-8'));
      if (Array.isArray(pages)) entityIds = pages.map((p: { id?: string }) => p.id).filter((id): id is string => Boolean(id));
    } catch { /* ignore */ }
  }

  const previouslySeenPlan = loadSeenItems();
  const newsDigest = await buildDigest(
    fetchResult.items,
    fetchResult.fetchedSources,
    fetchResult.failedSources.map(f => f.id),
    { entityIds, previouslySeen: previouslySeenPlan, verbose },
  );

  console.log(`Routing to pages...`);
  const updatePlan = await routeDigest(newsDigest, { maxPages, maxBudget: budget, verbose });

  if (options.json || options.ci) {
    return { output: JSON.stringify(updatePlan, null, 2), exitCode: 0 };
  }

  const c = log.colors;
  let output = '';

  output += `\n${c.bold}${c.blue}Auto-Update Plan — ${updatePlan.date}${c.reset}\n`;
  output += `${c.dim}Budget: $${budget} | Max pages: ${maxPages} | Estimated cost: ~$${updatePlan.estimatedCost.toFixed(0)}${c.reset}\n`;

  if (updatePlan.pageUpdates.length > 0) {
    output += `\n${c.bold}Page Updates (${updatePlan.pageUpdates.length}):${c.reset}\n`;
    for (const update of updatePlan.pageUpdates) {
      const tierColor = update.suggestedTier === 'deep' ? c.red
        : update.suggestedTier === 'polish' ? c.dim : '';
      output += `\n  ${tierColor}${update.suggestedTier.padEnd(9)}${c.reset} ${c.bold}${update.pageTitle}${c.reset}\n`;
      output += `  ${c.dim}Reason: ${update.reason}${c.reset}\n`;
      output += `  ${c.dim}Directions: ${update.directions.slice(0, 120)}${c.reset}\n`;
      if (update.relevantNews.length > 0) {
        for (const news of update.relevantNews.slice(0, 2)) {
          output += `  ${c.dim}  • ${news.title.slice(0, 80)}${c.reset}\n`;
        }
      }
    }
  } else {
    output += `\n${c.green}No page updates needed.${c.reset}\n`;
  }

  if (updatePlan.newPageSuggestions.length > 0) {
    output += `\n${c.bold}New Page Suggestions (${updatePlan.newPageSuggestions.length}):${c.reset}\n`;
    for (const np of updatePlan.newPageSuggestions) {
      output += `  ${np.suggestedTier.padEnd(9)} "${np.suggestedTitle}" — ${np.reason.slice(0, 80)}\n`;
    }
  }

  if (updatePlan.skippedReasons.length > 0) {
    output += `\n${c.dim}Skipped: ${updatePlan.skippedReasons.length} items${c.reset}\n`;
  }

  output += `\n${c.dim}Run 'crux auto-update run' to execute this plan.${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * List configured news sources
 */
async function sources(args: string[], options: AutoUpdateOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const config = loadSources();
  const fetchTimes = loadFetchTimes();

  if (options.json || options.ci) {
    return { output: JSON.stringify(config.sources, null, 2), exitCode: 0 };
  }

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Auto-Update News Sources${c.reset}\n\n`;
  output += `${c.bold}  Status  Type        Freq     Name${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(65)}${c.reset}\n`;

  for (const source of config.sources) {
    const statusIcon = source.enabled ? `${c.green}ON ${c.reset}` : `${c.red}OFF${c.reset}`;
    const lastFetch = fetchTimes[source.id];
    output += `  ${statusIcon}   `;
    output += `${source.type.padEnd(12)}`;
    output += `${source.frequency.padEnd(9)}`;
    output += `${source.name}\n`;
    if (lastFetch) {
      output += `  ${c.dim}${''.padEnd(6)}Last fetched: ${lastFetch.slice(0, 16)}${c.reset}\n`;
    }
  }

  output += `\n${c.dim}${config.sources.length} sources configured (${config.sources.filter(s => s.enabled).length} enabled)${c.reset}\n`;
  output += `${c.dim}Config: data/auto-update/sources.yaml${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * Show past auto-update run history
 */
async function history(args: string[], options: AutoUpdateOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const limit = parseInt(args[0] || '10', 10);

  if (!existsSync(RUNS_DIR)) {
    return { output: 'No auto-update runs found yet.', exitCode: 0 };
  }

  const files = readdirSync(RUNS_DIR)
    .filter(f => f.endsWith('.yaml'))
    .sort()
    .reverse()
    .slice(0, limit);

  if (files.length === 0) {
    return { output: 'No auto-update runs found yet.', exitCode: 0 };
  }

  const reports: RunReport[] = files.map(f => {
    const content = readFileSync(join(RUNS_DIR, f), 'utf-8');
    return parseYaml(content) as RunReport;
  });

  if (options.json || options.ci) {
    return { output: JSON.stringify(reports, null, 2), exitCode: 0 };
  }

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Auto-Update History${c.reset}\n\n`;
  output += `${c.bold}  Date        Trigger    Sources  Items  Pages  Failed  Budget${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(72)}${c.reset}\n`;

  for (const report of reports) {
    const failColor = report.execution.pagesFailed > 0 ? c.red : c.dim;
    output += `  ${report.date}  `;
    output += `${(report.trigger || 'manual').padEnd(11)}`;
    output += `${String(report.digest.sourcesChecked).padStart(7)}  `;
    output += `${String(report.digest.itemsRelevant).padStart(5)}  `;
    output += `${String(report.execution.pagesUpdated).padStart(5)}  `;
    output += `${failColor}${String(report.execution.pagesFailed).padStart(6)}${c.reset}  `;
    output += `$${report.budget.spent.toFixed(0)}/$${report.budget.limit}\n`;
  }

  output += `\n${c.dim}Showing ${files.length} most recent runs. Reports in: data/auto-update/runs/${c.reset}\n`;

  return { output, exitCode: 0 };
}

// ── Command Registry ────────────────────────────────────────────────────────

export const commands = {
  default: plan,
  run,
  digest,
  plan,
  sources,
  history,
};

export function getHelp(): string {
  return `
Auto-Update Domain — News-driven wiki update system

Fetches news from configured RSS feeds, newsletters, and web searches,
then routes relevant items to wiki pages for automatic improvement.

Pipeline: fetch sources → build digest → route to pages → execute updates

Commands:
  plan                 Show what would be updated (default)
  run                  Execute the full auto-update pipeline
  digest               Fetch sources and show news digest only
  sources              List configured news sources
  history [count]      Show past auto-update runs

Options:
  --budget=N           Max dollars to spend per run (default: 50)
  --count=N            Max pages to update per run (default: 10)
  --sources=a,b,c      Only fetch these source IDs
  --dry-run            Run pipeline but skip page improvements
  --verbose            Show detailed progress
  --json               Output as JSON
  --ci                 JSON output for CI pipelines

Pipeline stages:
  1. Fetch:   Pull new items from RSS/Atom feeds and web searches
  2. Digest:  Deduplicate, classify relevance, extract topics (~$0.02-0.05)
  3. Route:   Map news items to wiki pages via entity matching + LLM (~$0.05-0.15)
  4. Execute: Run page improvements via crux content improve (~$2-12/page)
  5. Validate: Run validation gate (escaping, schema, frontmatter)
  6. Report:  Save run report to data/auto-update/runs/

Cost model:
  Triage/routing overhead: ~$0.15-0.25 per run
  Per-page improvement: polish ~$2.50, standard ~$6.50, deep ~$12.50
  Typical daily run (5 pages): ~$15-35

Source configuration:
  Edit data/auto-update/sources.yaml to add/remove/configure news sources.
  Supported types: rss, atom, web-search

Examples:
  crux auto-update plan                          Preview what would be updated
  crux auto-update run --budget=30               Run with $30 budget
  crux auto-update run --count=3 --verbose       Update 3 pages with details
  crux auto-update digest --sources=openai-blog  Check one source
  crux auto-update sources                       List all sources
  crux auto-update history                       Show recent runs
  crux auto-update run --dry-run                 Full pipeline without executing
`;
}
