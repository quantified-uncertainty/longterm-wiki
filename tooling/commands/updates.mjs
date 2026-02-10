/**
 * Updates Command Handlers
 *
 * Schedule-aware wiki page update system.
 * Uses `update_frequency` (days) in frontmatter to prioritize which pages
 * need refreshing, combining staleness with importance scoring.
 *
 * Scoring: priority = staleness × (importance / 100)
 *   where staleness = days_since_last_edit / update_frequency
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { execFileSync } from 'child_process';
import { createLogger } from '../lib/output.mjs';
import { parseFrontmatter } from '../lib/mdx-utils.mjs';
import { CONTENT_DIR_ABS, PROJECT_ROOT } from '../lib/content-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively find all MDX/MD files in a directory
 */
function findMdxFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMdxFiles(fullPath));
    } else if (/\.(mdx?|md)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Derive page ID from file path (filename without extension, or directory name for index files)
 */
function derivePageId(filePath) {
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
function loadUpdateCandidates() {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  const now = new Date();
  const candidates = [];

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);

    // Skip pages without update_frequency
    if (fm.update_frequency == null) continue;

    // Skip stubs and documentation pages
    if (fm.pageType === 'stub' || fm.pageType === 'documentation') continue;

    const updateFrequency = Number(fm.update_frequency);
    if (updateFrequency <= 0 || isNaN(updateFrequency)) continue;

    const pageId = derivePageId(filePath);
    const relPath = relative(CONTENT_DIR_ABS, filePath);

    // Parse last edited date
    const lastEditedStr = fm.lastEdited || fm.lastUpdated;
    let daysSinceEdit = null;
    let lastEditedDate = null;
    if (lastEditedStr) {
      lastEditedDate = new Date(lastEditedStr);
      daysSinceEdit = Math.floor((now - lastEditedDate) / (1000 * 60 * 60 * 24));
    } else {
      // Fall back to file modification time
      const stat = statSync(filePath);
      lastEditedDate = stat.mtime;
      daysSinceEdit = Math.floor((now - lastEditedDate) / (1000 * 60 * 60 * 24));
    }

    const staleness = daysSinceEdit / updateFrequency;
    const importance = Number(fm.importance) || 50;
    const quality = Number(fm.quality) || 50;

    // priority = staleness × (importance / 100)
    // Pages that are more overdue AND more important float to top
    const priority = staleness * (importance / 100);

    candidates.push({
      id: pageId,
      title: fm.title || pageId,
      filePath: relPath,
      fullPath: filePath,
      updateFrequency,
      lastEdited: lastEditedStr || lastEditedDate.toISOString().slice(0, 10),
      daysSinceEdit,
      staleness: Math.round(staleness * 100) / 100,
      importance,
      quality,
      priority: Math.round(priority * 100) / 100,
      overdue: staleness >= 1.0,
      category: fm.subcategory || relPath.split('/')[0] || 'unknown',
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
export async function list(args, options) {
  const log = createLogger(options.ci);
  const candidates = loadUpdateCandidates();
  const limit = parseInt(options.limit || '10', 10);
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
  output += `${c.dim}Pages ranked by update priority (staleness × importance)${c.reset}\n\n`;

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
    output += `${String(p.importance).padStart(3)}  `;
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
export async function run(args, options) {
  const log = createLogger(options.ci);
  const candidates = loadUpdateCandidates();
  const count = parseInt(options.count || '1', 10);
  const tier = options.tier || 'standard';
  const dryRun = options.dryRun;

  // Only run overdue pages by default
  const overdue = candidates.filter(p => p.overdue);

  if (overdue.length === 0) {
    return { output: 'No overdue pages found. All tracked pages are up to date.', exitCode: 0 };
  }

  const toRun = overdue.slice(0, count);

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Running Updates${c.reset}\n`;
  output += `${c.dim}Tier: ${tier} | Count: ${toRun.length} | Dry run: ${dryRun ? 'yes' : 'no'}${c.reset}\n\n`;

  for (let i = 0; i < toRun.length; i++) {
    const page = toRun[i];
    output += `${c.bold}[${i + 1}/${toRun.length}] ${page.title}${c.reset}\n`;
    output += `  Priority: ${page.priority} | ${page.daysSinceEdit}d since edit | freq: ${page.updateFrequency}d\n`;

    if (dryRun) {
      output += `  ${c.dim}(dry run — would run: page-improver.mjs -- ${page.id} --tier ${tier} --apply --grade)${c.reset}\n\n`;
      continue;
    }

    try {
      const cmdArgs = ['tooling/content/page-improver.mjs', '--', page.id, '--tier', tier, '--apply', '--grade'];
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
    } catch (err) {
      output += `  ${c.red}Failed: ${err.message?.slice(0, 200)}${c.reset}\n\n`;
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
export async function stats(args, options) {
  const log = createLogger(options.ci);

  // Single pass: read all files once, computing both total-page stats and candidate stats
  const allFiles = findMdxFiles(CONTENT_DIR_ABS);
  const now = new Date();

  let totalPages = 0;
  let pagesWithFrequency = 0;
  let pagesWithImportance = 0;
  const frequencyDistribution = {};
  const candidates = []; // Build candidates inline to avoid double-read

  for (const filePath of allFiles) {
    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    if (fm.pageType === 'stub' || fm.pageType === 'documentation') continue;
    if (filePath.endsWith('index.mdx') || filePath.endsWith('index.md')) continue;

    totalPages++;
    if (fm.importance != null) pagesWithImportance++;

    if (fm.update_frequency != null) {
      const updateFrequency = Number(fm.update_frequency);
      if (updateFrequency > 0 && !isNaN(updateFrequency)) {
        pagesWithFrequency++;
        const bucket = updateFrequency <= 3 ? '1-3d' : updateFrequency <= 7 ? '4-7d' : updateFrequency <= 14 ? '8-14d' : updateFrequency <= 30 ? '15-30d' : updateFrequency <= 60 ? '31-60d' : '60d+';
        frequencyDistribution[bucket] = (frequencyDistribution[bucket] || 0) + 1;

        // Build candidate entry for priority stats
        const lastEditedStr = fm.lastEdited || fm.lastUpdated;
        let daysSinceEdit = 0;
        if (lastEditedStr) {
          daysSinceEdit = Math.floor((now - new Date(lastEditedStr)) / (1000 * 60 * 60 * 24));
        }
        const staleness = daysSinceEdit / updateFrequency;
        const importance = Number(fm.importance) || 50;
        const priority = staleness * (importance / 100);
        const relPath = relative(CONTENT_DIR_ABS, filePath);

        candidates.push({
          staleness: Math.round(staleness * 100) / 100,
          priority: Math.round(priority * 100) / 100,
          overdue: staleness >= 1.0,
          category: fm.subcategory || relPath.split('/')[0] || 'unknown',
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
  const byCategory = {};
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
    coveragePercent: Math.round((pagesWithFrequency / totalPages) * 100),
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
  output += `  Pages with importance score: ${pagesWithImportance}\n`;
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

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands = {
  default: list,
  list,
  run,
  stats,
};

/**
 * Get help text
 */
export function getHelp() {
  return `
Updates Domain - Schedule-aware wiki page update system

Uses update_frequency (days) in page frontmatter to prioritize which
pages need refreshing, combining staleness with importance scoring.

  Priority = staleness × (importance / 100)
  Staleness = days_since_last_edit / update_frequency

Commands:
  list                 Show pages due for update, ranked by priority (default)
  run                  Run content improve on top-priority pages
  stats                Show update frequency coverage statistics

Options:
  --limit=N            Number of results for list (default: 10)
  --overdue            Only show overdue pages (staleness >= 1.0)
  --count=N            Number of pages to improve in run (default: 1)
  --tier=<tier>        Improvement tier: polish, standard, deep (default: standard)
  --dry-run            Preview what run would do without executing
  --json               Output as JSON
  --ci                 JSON output for CI pipelines

Frontmatter fields:
  update_frequency: 7     # Desired update interval in days
  lastEdited: "2026-01-15"  # Last edit date (used for staleness)
  importance: 85            # Page importance (0-100, used as weight)

Examples:
  crux updates list                       Show top 10 update priorities
  crux updates list --overdue --limit=20  All overdue pages
  crux updates run --count=3 --tier=polish  Quick-improve top 3
  crux updates run --dry-run              Preview without executing
  crux updates stats                      Show coverage stats
`;
}
