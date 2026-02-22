/**
 * Updates Command Handlers
 *
 * Schedule-aware wiki page update system.
 * Uses `update_frequency` (days) in frontmatter to prioritize which pages
 * need refreshing, combining staleness with readerImportance scoring.
 *
 * Scoring: priority = staleness × (readerImportance / 100)
 *   where staleness = days_since_last_edit / update_frequency
 */

import { readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { execFileSync } from 'child_process';
import { createLogger } from '../lib/output.ts';
import { parseFrontmatter } from '../lib/mdx-utils.ts';
import { CONTENT_DIR_ABS, PROJECT_ROOT } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { type CommandResult, parseIntOpt } from '../lib/cli.ts';
import { triagePhase, loadPages as loadPagesFromImprover, findPage as findPageFromImprover } from '../authoring/page-improver.ts';
import type { TriageResult } from '../authoring/page-improver.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UpdateCandidate {
  id: string;
  title: string;
  filePath: string;
  fullPath: string;
  updateFrequency: number;
  lastEdited: string;
  daysSinceEdit: number;
  staleness: number;
  readerImportance: number;
  quality: number;
  priority: number;
  overdue: boolean;
  category: string;
}

interface StatsCandidate {
  staleness: number;
  priority: number;
  overdue: boolean;
  category: string;
}

interface CategoryStats {
  total: number;
  overdue: number;
  avgPriority: number;
}

interface CommandOptions {
  ci?: boolean;
  json?: boolean;
  limit?: string;
  overdue?: boolean;
  count?: string;
  tier?: string;
  dryRun?: boolean;
  triage?: boolean;
  noTriage?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive page ID from file path (filename without extension, or directory name for index files)
 */
function derivePageId(filePath: string): string {
  const rel = relative(CONTENT_DIR_ABS, filePath);
  const parts = rel.split('/');
  const filename = parts[parts.length - 1].replace(/\.(mdx?|md)$/, '');
  if (filename === 'index') {
    return parts.length >= 2 ? parts[parts.length - 2] : 'index';
  }
  return filename;
}

/**
 * Load all pages with their frontmatter, computing update priority
 */
function loadUpdateCandidates(): UpdateCandidate[] {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  const now = new Date();
  const candidates: UpdateCandidate[] = [];

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);

    // Skip pages without update_frequency
    if (fm.update_frequency == null) continue;

    // Skip stubs, documentation, and internal pages
    if (fm.pageType === 'stub' || fm.pageType === 'documentation' || fm.entityType === 'internal') continue;

    // Skip non-evergreen pages (reports, blog posts)
    if (fm.evergreen === false) continue;

    const updateFrequency = Number(fm.update_frequency);
    if (updateFrequency <= 0 || isNaN(updateFrequency)) continue;

    const pageId = derivePageId(filePath);
    const relPath = relative(CONTENT_DIR_ABS, filePath);

    // Parse last edited date
    const lastEditedRaw = fm.lastEdited || fm.lastUpdated;
    const lastEditedStr = typeof lastEditedRaw === 'string' ? lastEditedRaw : lastEditedRaw instanceof Date ? lastEditedRaw.toISOString().slice(0, 10) : null;
    let daysSinceEdit = 0;
    let lastEditedDate: Date;
    if (lastEditedStr) {
      lastEditedDate = new Date(lastEditedStr);
      daysSinceEdit = Math.floor((now.getTime() - lastEditedDate.getTime()) / (1000 * 60 * 60 * 24));
    } else {
      // Fall back to file modification time
      const stat = statSync(filePath);
      lastEditedDate = stat.mtime;
      daysSinceEdit = Math.floor((now.getTime() - lastEditedDate.getTime()) / (1000 * 60 * 60 * 24));
    }

    const staleness = daysSinceEdit / updateFrequency;
    const readerImp = Number(fm.readerImportance) || 50;
    const quality = Number(fm.quality) || 50;

    // priority = staleness × (readerImportance / 100)
    // Pages that are more overdue AND more important float to top
    const priority = staleness * (readerImp / 100);

    candidates.push({
      id: pageId,
      title: typeof fm.title === 'string' ? fm.title : pageId,
      filePath: relPath,
      fullPath: filePath,
      updateFrequency,
      lastEdited: lastEditedStr || lastEditedDate.toISOString().slice(0, 10),
      daysSinceEdit,
      staleness: Math.round(staleness * 100) / 100,
      readerImportance: readerImp,
      quality,
      priority: Math.round(priority * 100) / 100,
      overdue: staleness >= 1.0,
      category: (typeof fm.subcategory === 'string' ? fm.subcategory : null) || relPath.split('/')[0] || 'unknown',
    });
  }

  // Sort by priority descending
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * List pages due for update, ranked by priority
 */
export async function list(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const candidates = loadUpdateCandidates();
  const limit = parseIntOpt(options.limit, 10);
  const overdueOnly = options.overdue;

  let filtered = candidates;
  if (overdueOnly) {
    filtered = filtered.filter(c => c.overdue);
  }
  const shown = filtered.slice(0, limit);

  if (options.ci || options.json) {
    return { output: JSON.stringify(shown, null, 2), exitCode: 0 };
  }

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Wiki Update Queue${c.reset}\n`;
  output += `${c.dim}Pages ranked by update priority (staleness × readerImportance)${c.reset}\n\n`;

  // Summary stats
  const totalTracked = candidates.length;
  const overdueCount = candidates.filter(p => p.overdue).length;
  const todayUpdated = candidates.filter(p => p.daysSinceEdit === 0).length;

  output += `${c.dim}Tracked: ${totalTracked} | Overdue: ${overdueCount} | Updated today: ${todayUpdated}${c.reset}\n\n`;

  // Table header
  output += `${c.bold}  #  Priority  Stale  Freq  Imp  Days  Page${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(75)}${c.reset}\n`;

  for (let i = 0; i < shown.length; i++) {
    const p = shown[i];
    const rank = String(i + 1).padStart(3);
    const priColor = p.priority >= 1.0 ? c.red : p.priority >= 0.5 ? c.yellow : '';
    const staleColor = p.staleness >= 2.0 ? c.red : p.staleness >= 1.0 ? c.yellow : c.dim;
    const overdueMarker = p.overdue ? '!' : ' ';

    output += `${overdueMarker}${rank}  `;
    output += `${priColor}${String(p.priority.toFixed(1)).padStart(8)}${c.reset}  `;
    output += `${staleColor}${String(p.staleness.toFixed(1)).padStart(5)}${c.reset}  `;
    output += `${String(p.updateFrequency + 'd').padStart(4)}  `;
    output += `${String(p.readerImportance).padStart(3)}  `;
    output += `${String(p.daysSinceEdit + 'd').padStart(4)}  `;
    output += `${p.title}\n`;
  }

  if (shown.length < filtered.length) {
    output += `\n${c.dim}Showing ${shown.length} of ${filtered.length} pages. Use --limit to see more.${c.reset}\n`;
  }

  if (overdueCount === 0) {
    output += `\n${c.green}All tracked pages are up to date!${c.reset}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Run content improve on top-priority pages
 */
export async function run(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const candidates = loadUpdateCandidates();
  const count = parseIntOpt(options.count, 1);
  const tier = options.tier || 'standard';
  const dryRun = options.dryRun;
  // Triage is ON by default — use --no-triage to skip
  const useTriage = options.noTriage ? false : (options.triage !== undefined ? options.triage : true);

  // Only run overdue pages by default
  const overdue = candidates.filter(p => p.overdue);

  if (overdue.length === 0) {
    return { output: 'No overdue pages found. All tracked pages are up to date.', exitCode: 0 };
  }

  const toRun = overdue.slice(0, count);

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Running Updates${c.reset}\n`;
  output += `${c.dim}Tier: ${useTriage ? 'triage (auto)' : tier} | Count: ${toRun.length} | Dry run: ${dryRun ? 'yes' : 'no'}${c.reset}\n\n`;

  // If triage mode, run triage on all pages first to show the plan
  let triageResults: Map<string, TriageResult> | undefined;
  if (useTriage) {
    triageResults = new Map();
    const improverPages = loadPagesFromImprover();

    output += `${c.bold}Triage Phase${c.reset} — checking for new developments...\n\n`;
    if (output) { console.log(output); output = ''; }

    for (const candidate of toRun) {
      const improverPage = findPageFromImprover(improverPages, candidate.id);
      if (!improverPage) {
        console.log(`  ${c.dim}${candidate.id}: page not found in pages.json, skipping triage${c.reset}`);
        continue;
      }
      try {
        const result = await triagePhase(improverPage, candidate.lastEdited);
        triageResults.set(candidate.id, result);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.log(`  ${c.yellow}${candidate.id}: triage failed (${error.message?.slice(0, 80)}), defaulting to ${tier}${c.reset}`);
      }
    }

    // Show triage summary
    output += `\n${c.bold}Triage Results:${c.reset}\n`;
    let triageTotalSaved = 0;
    const costMid: Record<string, number> = { skip: 0, polish: 2.5, standard: 6.5, deep: 12.5 };
    const defaultCost = costMid[tier] || 6.5;

    for (const candidate of toRun) {
      const result = triageResults.get(candidate.id);
      if (result) {
        const tierColor = result.recommendedTier === 'skip' ? c.green
          : result.recommendedTier === 'polish' ? c.dim
          : result.recommendedTier === 'deep' ? c.red : '';
        output += `  ${tierColor}${result.recommendedTier.padEnd(9)}${c.reset} ${candidate.title} — ${result.reason}\n`;
        triageTotalSaved += defaultCost - (costMid[result.recommendedTier] || 0);
      } else {
        output += `  ${tier.padEnd(9)} ${candidate.title} — (triage unavailable, using default)\n`;
      }
    }

    const skippedCount = [...triageResults.values()].filter(r => r.recommendedTier === 'skip').length;
    if (skippedCount > 0) {
      output += `\n${c.green}Skipping ${skippedCount} page(s) with no new developments${c.reset}\n`;
    }
    if (triageTotalSaved > 0) {
      output += `${c.dim}Estimated savings vs all-${tier}: ~$${triageTotalSaved.toFixed(0)} (triage cost: ~$${(toRun.length * 0.08).toFixed(2)})${c.reset}\n`;
    }
    output += '\n';
  }

  for (let i = 0; i < toRun.length; i++) {
    const page = toRun[i];

    // Determine effective tier for this page
    let effectiveTier = tier;
    if (triageResults) {
      const triageResult = triageResults.get(page.id);
      if (triageResult) {
        if (triageResult.recommendedTier === 'skip') {
          output += `${c.bold}[${i + 1}/${toRun.length}] ${page.title}${c.reset} — ${c.green}skipped${c.reset} (no new developments)\n\n`;
          continue;
        }
        effectiveTier = triageResult.recommendedTier;
      }
    }

    output += `${c.bold}[${i + 1}/${toRun.length}] ${page.title}${c.reset}\n`;
    output += `  Priority: ${page.priority} | ${page.daysSinceEdit}d since edit | freq: ${page.updateFrequency}d`;
    if (triageResults) {
      output += ` | tier: ${effectiveTier} (via triage)`;
    }
    output += '\n';

    if (dryRun) {
      output += `  ${c.dim}(dry run — would run: page-improver.ts -- ${page.id} --tier ${effectiveTier} --apply)${c.reset}\n\n`;
      continue;
    }

    try {
      const cmdArgs = ['--import', 'tsx/esm', '--no-warnings', 'crux/authoring/page-improver.ts', '--', page.id, '--tier', effectiveTier, '--apply'];
      output += `  ${c.dim}Running: node ${cmdArgs.join(' ')}${c.reset}\n`;

      // Print accumulated output before starting long-running process
      if (output) {
        console.log(output);
        output = '';
      }

      execFileSync('node', cmdArgs, {
        cwd: PROJECT_ROOT,
        timeout: 30 * 60 * 1000, // 30 minute timeout per page
        stdio: 'inherit', // Stream output live to terminal
      });

      output += `  ${c.green}Done${c.reset}\n\n`;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      output += `  ${c.red}Failed: ${error.message?.slice(0, 200)}${c.reset}\n\n`;
    }
  }

  // Show what's next
  const remaining = overdue.slice(count, count + 3);
  if (remaining.length > 0) {
    output += `${c.dim}Next in queue: ${remaining.map(p => p.title).join(', ')}${c.reset}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Show update frequency coverage statistics
 */
export async function stats(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);

  // Single pass: read all files once, computing both total-page stats and candidate stats
  const allFiles = findMdxFiles(CONTENT_DIR_ABS);
  const now = new Date();

  let totalPages = 0;
  let pagesWithFrequency = 0;
  let pagesWithImportance = 0;
  const frequencyDistribution: Record<string, number> = {};
  const candidates: StatsCandidate[] = []; // Build candidates inline to avoid double-read

  for (const filePath of allFiles) {
    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    if (fm.pageType === 'stub' || fm.pageType === 'documentation' || fm.entityType === 'internal') continue;
    if (filePath.endsWith('index.mdx') || filePath.endsWith('index.md')) continue;

    totalPages++;
    if (fm.readerImportance != null) pagesWithImportance++;

    if (fm.update_frequency != null) {
      const updateFrequency = Number(fm.update_frequency);
      if (updateFrequency > 0 && !isNaN(updateFrequency)) {
        pagesWithFrequency++;
        const bucket = updateFrequency <= 3 ? '1-3d' : updateFrequency <= 7 ? '4-7d' : updateFrequency <= 14 ? '8-14d' : updateFrequency <= 30 ? '15-30d' : updateFrequency <= 60 ? '31-60d' : '60d+';
        frequencyDistribution[bucket] = (frequencyDistribution[bucket] || 0) + 1;

        // Build candidate entry for priority stats
        const lastEditedRaw = fm.lastEdited || fm.lastUpdated;
        const lastEditedStr = typeof lastEditedRaw === 'string' ? lastEditedRaw : lastEditedRaw instanceof Date ? lastEditedRaw.toISOString().slice(0, 10) : null;
        let daysSinceEdit = 0;
        if (lastEditedStr) {
          daysSinceEdit = Math.floor((now.getTime() - new Date(lastEditedStr).getTime()) / (1000 * 60 * 60 * 24));
        }
        const staleness = daysSinceEdit / updateFrequency;
        const readerImp = Number(fm.readerImportance) || 50;
        const priority = staleness * (readerImp / 100);
        const relPath = relative(CONTENT_DIR_ABS, filePath);

        candidates.push({
          staleness: Math.round(staleness * 100) / 100,
          priority: Math.round(priority * 100) / 100,
          overdue: staleness >= 1.0,
          category: (typeof fm.subcategory === 'string' ? fm.subcategory : null) || relPath.split('/')[0] || 'unknown',
        });
      }
    }
  }

  const overdueCount = candidates.filter(p => p.overdue).length;
  const avgPriority = candidates.length > 0
    ? (candidates.reduce((s, c) => s + c.priority, 0) / candidates.length).toFixed(2)
    : '0';
  const avgStaleness = candidates.length > 0
    ? (candidates.reduce((s, c) => s + c.staleness, 0) / candidates.length).toFixed(2)
    : '0';

  // Category breakdown
  const byCategory: Record<string, CategoryStats> = {};
  for (const p of candidates) {
    if (!byCategory[p.category]) {
      byCategory[p.category] = { total: 0, overdue: 0, avgPriority: 0 };
    }
    byCategory[p.category].total++;
    byCategory[p.category].avgPriority += p.priority;
    if (p.overdue) byCategory[p.category].overdue++;
  }
  for (const cat of Object.values(byCategory)) {
    cat.avgPriority = Math.round((cat.avgPriority / cat.total) * 100) / 100;
  }

  const statsData = {
    totalPages,
    pagesWithFrequency,
    pagesWithImportance,
    coveragePercent: totalPages > 0 ? Math.round((pagesWithFrequency / totalPages) * 100) : 0,
    overdueCount,
    avgPriority,
    avgStaleness,
    frequencyDistribution,
    byCategory,
  };

  if (options.ci || options.json) {
    return { output: JSON.stringify(statsData, null, 2), exitCode: 0 };
  }

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Update Frequency Statistics${c.reset}\n\n`;

  output += `${c.bold}Coverage:${c.reset}\n`;
  output += `  Total content pages: ${totalPages}\n`;
  output += `  Pages with update_frequency: ${pagesWithFrequency} (${statsData.coveragePercent}%)\n`;
  output += `  Pages with readerImportance score: ${pagesWithImportance}\n`;
  output += `  Currently overdue: ${c.yellow}${overdueCount}${c.reset}\n`;
  output += `  Avg priority score: ${avgPriority}\n`;
  output += `  Avg staleness: ${avgStaleness}×\n\n`;

  output += `${c.bold}Frequency Distribution:${c.reset}\n`;
  const bucketOrder = ['1-3d', '4-7d', '8-14d', '15-30d', '31-60d', '60d+'];
  const maxCount = Math.max(...bucketOrder.map(b => frequencyDistribution[b] || 0), 1);
  for (const bucket of bucketOrder) {
    const count = frequencyDistribution[bucket] || 0;
    if (count > 0) {
      const barLen = Math.max(1, Math.round((count / maxCount) * 30));
      const bar = '█'.repeat(barLen);
      output += `  ${bucket.padEnd(8)} ${bar} ${count}\n`;
    }
  }

  output += `\n${c.bold}By Category:${c.reset}\n`;
  const sortedCats = Object.entries(byCategory).sort((a, b) => b[1].overdue - a[1].overdue);
  for (const [cat, data] of sortedCats) {
    output += `  ${cat.padEnd(25)} ${data.total} tracked, ${c.yellow}${data.overdue} overdue${c.reset}, avg priority: ${data.avgPriority}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Run triage on overdue pages to preview what tier each would get
 *
 * Cost: ~$0.08 per page (Haiku + web search + SCRY)
 */
export async function triage(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const candidates = loadUpdateCandidates();
  const count = parseIntOpt(options.count, 5);

  const overdue = candidates.filter(p => p.overdue);

  if (overdue.length === 0) {
    return { output: 'No overdue pages found. All tracked pages are up to date.', exitCode: 0 };
  }

  const toTriage = overdue.slice(0, count);
  const improverPages = loadPagesFromImprover();

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Update Triage${c.reset}\n`;
  output += `${c.dim}Checking ${toTriage.length} overdue page(s) for new developments (~$0.08/page)${c.reset}\n`;
  output += `${c.dim}Total triage cost: ~$${(toTriage.length * 0.08).toFixed(2)}${c.reset}\n\n`;

  if (output) { console.log(output); output = ''; }

  const results: TriageResult[] = [];
  const costMid: Record<string, number> = { skip: 0, polish: 2.5, standard: 6.5, deep: 12.5 };

  for (const candidate of toTriage) {
    const improverPage = findPageFromImprover(improverPages, candidate.id);
    if (!improverPage) {
      console.log(`  ${c.dim}${candidate.id}: not in pages.json, skipping${c.reset}`);
      continue;
    }

    try {
      const result = await triagePhase(improverPage, candidate.lastEdited);
      results.push(result);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.log(`  ${c.yellow}${candidate.id}: triage failed — ${error.message?.slice(0, 80)}${c.reset}`);
    }
  }

  // Summary table
  output += `\n${c.bold}Triage Results:${c.reset}\n\n`;
  output += `${c.bold}  Tier       Est.Cost  Page${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(65)}${c.reset}\n`;

  let totalEstimated = 0;
  let totalDefault = 0;
  const tierCounts: Record<string, number> = { skip: 0, polish: 0, standard: 0, deep: 0 };

  for (const result of results) {
    const tierColor = result.recommendedTier === 'skip' ? c.green
      : result.recommendedTier === 'polish' ? c.dim
      : result.recommendedTier === 'deep' ? c.red : '';
    output += `  ${tierColor}${result.recommendedTier.padEnd(10)}${c.reset}`;
    output += `${result.estimatedCost.padStart(8)}  `;
    output += `${result.title}\n`;
    if (result.reason) {
      output += `${c.dim}  ${''.padEnd(10)}          ${result.reason}${c.reset}\n`;
    }
    if (result.newDevelopments.length > 0) {
      for (const dev of result.newDevelopments.slice(0, 2)) {
        output += `${c.dim}  ${''.padEnd(10)}          • ${dev}${c.reset}\n`;
      }
    }
    totalEstimated += costMid[result.recommendedTier] || 0;
    totalDefault += costMid['standard'];
    tierCounts[result.recommendedTier] = (tierCounts[result.recommendedTier] || 0) + 1;
  }

  output += `\n${c.bold}Summary:${c.reset}\n`;
  output += `  Skip: ${tierCounts.skip} | Polish: ${tierCounts.polish} | Standard: ${tierCounts.standard} | Deep: ${tierCounts.deep}\n`;
  output += `  Triage cost: ~$${(results.length * 0.08).toFixed(2)}\n`;
  output += `  Estimated update cost: ~$${totalEstimated.toFixed(0)} (vs ~$${totalDefault.toFixed(0)} if all standard)\n`;
  const saved = totalDefault - totalEstimated;
  if (saved > 0) {
    output += `  ${c.green}Savings: ~$${saved.toFixed(0)}${c.reset}\n`;
  }

  output += `\n${c.dim}To run with triage: crux updates run --triage --count=${count}${c.reset}\n`;

  if (options.ci || options.json) {
    return { output: JSON.stringify(results, null, 2), exitCode: 0 };
  }

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands = {
  default: list,
  list,
  run,
  triage,
  stats,
};

/**
 * Get help text
 */
export function getHelp(): string {
  return `
Updates Domain - Schedule-aware wiki page update system

Uses update_frequency (days) in page frontmatter to prioritize which
pages need refreshing, combining staleness with readerImportance scoring.

  Priority = staleness × (readerImportance / 100)
  Staleness = days_since_last_edit / update_frequency

Commands:
  list                 Show pages due for update, ranked by priority (default)
  run                  Run content improve on top-priority pages
  triage               Check overdue pages for new developments (~$0.08/page)
  stats                Show update frequency coverage statistics

Options:
  --limit=N            Number of results for list (default: 10)
  --overdue            Only show overdue pages (staleness >= 1.0)
  --count=N            Number of pages to improve/triage (default: 1 for run, 5 for triage)
  --tier=<tier>        Improvement tier: polish, standard, deep (default: standard)
  --no-triage          Skip news-check triage (triage is ON by default for run)
  --dry-run            Preview what run would do without executing
  --json               Output as JSON
  --ci                 JSON output for CI pipelines

Frontmatter fields:
  update_frequency: 7     # Desired update interval in days
  lastEdited: "2026-01-15"  # Last edit date (used for staleness)
  readerImportance: 85      # Reader importance (0-100, used as weight)

Cost-aware updating:
  The triage system checks for new developments before committing to
  an expensive update. For each page it runs a cheap news check (~$0.08)
  using web search + SCRY, then recommends: skip, polish, standard, or deep.

  This can save significantly when many overdue pages have no real news.
  Example: 10 pages at standard = ~$65. With triage, if 6 have no news,
  cost drops to ~$26 + $0.80 triage = ~$27.

Examples:
  crux updates list                       Show top 10 update priorities
  crux updates list --overdue --limit=20  All overdue pages
  crux updates triage --count=10          Preview triage for top 10 overdue
  crux updates run --count=5              Run with triage (default)
  crux updates run --count=3 --no-triage --tier=polish  Skip triage, force polish
  crux updates run --dry-run              Preview without executing
  crux updates stats                      Show coverage stats
`;
}
