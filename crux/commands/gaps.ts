/**
 * Gaps Command Handlers
 *
 * Find pages that need more insights extracted.
 * Integrates with insight-hunting system for automated research.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { join } from 'path';
import type { CommandResult } from '../lib/cli.ts';
import type { PageEntry } from '../lib/content-types.ts';
import { createLogger } from '../lib/output.ts';
import { loadPages, DATA_DIR_ABS } from '../lib/content-types.ts';

const INSIGHTS_DIR: string = join(DATA_DIR_ABS, 'insights');

interface InsightEntry {
  source: string;
  [key: string]: unknown;
}

interface InsightsFileData {
  insights?: InsightEntry[];
}

interface GapEntry {
  title: string;
  path: string;
  filePath: string;
  importance: number;
  quality: number;
  insightCount: number;
  potentialScore: number;
  wordCount: number;
  gapReason: string;
  category: string;
}

/**
 * Load insights data from directory of YAML files
 */
function loadInsights(): { insights: InsightEntry[] } {
  if (!existsSync(INSIGHTS_DIR)) {
    return { insights: [] };
  }
  const files = readdirSync(INSIGHTS_DIR).filter((f: string) => f.endsWith('.yaml'));
  const allInsights: InsightEntry[] = [];
  for (const file of files) {
    const content = readFileSync(join(INSIGHTS_DIR, file), 'utf-8');
    const data = parseYaml(content) as InsightsFileData | null;
    if (data?.insights) {
      allInsights.push(...data.insights);
    }
  }
  return { insights: allInsights };
}

/**
 * Calculate insight gaps
 */
function calculateGaps(pages: PageEntry[], insights: InsightEntry[]): GapEntry[] {
  // Count insights per source
  const insightCounts = new Map<string, number>();
  for (const insight of insights) {
    const current = insightCounts.get(insight.source) || 0;
    insightCounts.set(insight.source, current + 1);
  }

  // Calculate gaps for each page
  return pages
    .filter((page: PageEntry) => page.importance != null && page.importance > 0)
    .map((page: PageEntry): GapEntry => {
      const insightCount = insightCounts.get(page.path) || 0;
      const importance = page.importance || 0;
      const quality = page.quality || 50;
      const potentialScore = Math.round(importance * (1 + quality / 100) - insightCount * 20);

      let gapReason = '';
      if (insightCount === 0 && importance >= 70) {
        gapReason = 'High importance, no insights';
      } else if (insightCount < 2 && importance >= 80) {
        gapReason = 'Very high importance, few insights';
      } else if (quality >= 80 && insightCount < 3) {
        gapReason = 'High quality, under-extracted';
      }

      return {
        title: page.title,
        path: page.path,
        filePath: page.filePath,
        importance,
        quality,
        insightCount,
        potentialScore,
        wordCount: page.wordCount || 0,
        gapReason,
        category: page.category || 'unknown',
      };
    })
    .filter((g: GapEntry) => g.potentialScore > 50)
    .sort((a: GapEntry, b: GapEntry) => b.potentialScore - a.potentialScore);
}

/**
 * List gap candidates
 */
export async function list(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const pages = loadPages();
  const { insights } = loadInsights();
  const gaps = calculateGaps(pages, insights);

  const limit = parseInt((options.limit as string) || '20', 10);
  const minScore = parseInt((options.minScore as string) || '60', 10);
  const noInsightsOnly = options.noInsights || options.empty;

  let filtered = gaps.filter((g: GapEntry) => g.potentialScore >= minScore);
  if (noInsightsOnly) {
    filtered = filtered.filter((g: GapEntry) => g.insightCount === 0);
  }
  filtered = filtered.slice(0, limit);

  if (options.ci || options.json) {
    return { output: JSON.stringify(filtered, null, 2), exitCode: 0 };
  }

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Insight Gap Analysis${c.reset}\n`;
  output += `${c.dim}Pages needing more insights${c.reset}\n\n`;

  // Stats
  const noInsights = gaps.filter((g: GapEntry) => g.insightCount === 0).length;
  const highPriority = gaps.filter((g: GapEntry) => g.potentialScore >= 100).length;
  output += `${c.dim}Total gaps: ${gaps.length} | No insights: ${noInsights} | High priority: ${highPriority}${c.reset}\n\n`;

  // Table header
  output += `${c.bold}Score  Imp  Qual  #Ins  Page${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(70)}${c.reset}\n`;

  for (const gap of filtered) {
    const scoreColor = gap.potentialScore >= 100 ? c.red : gap.potentialScore >= 80 ? c.yellow : '';
    const insightColor = gap.insightCount === 0 ? c.red : c.dim;

    output += `${scoreColor}${String(gap.potentialScore).padStart(5)}${c.reset}  `;
    output += `${String(gap.importance).padStart(3)}  `;
    output += `${String(gap.quality).padStart(4)}  `;
    output += `${insightColor}${String(gap.insightCount).padStart(4)}${c.reset}  `;
    output += `${gap.title}\n`;

    if (gap.gapReason) {
      output += `${c.dim}                        └─ ${gap.gapReason}${c.reset}\n`;
    }
  }

  if (filtered.length < gaps.length) {
    output += `\n${c.dim}Showing ${filtered.length} of ${gaps.length} gaps. Use --limit to see more.${c.reset}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Show top candidates for automated extraction
 */
export async function targets(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const pages = loadPages();
  const { insights } = loadInsights();
  const gaps = calculateGaps(pages, insights);

  // Get best targets: high score, no insights, good word count
  const targets = gaps
    .filter((g: GapEntry) => g.insightCount === 0 && g.wordCount >= 500)
    .slice(0, parseInt((options.limit as string) || '10', 10));

  if (options.ci || options.json) {
    return { output: JSON.stringify(targets, null, 2), exitCode: 0 };
  }

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Top Extraction Targets${c.reset}\n`;
  output += `${c.dim}Best candidates for automated insight extraction${c.reset}\n\n`;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    output += `${c.bold}${i + 1}. ${t.title}${c.reset}\n`;
    output += `   Score: ${t.potentialScore} | Importance: ${t.importance} | Quality: ${t.quality}\n`;
    output += `   ${c.dim}${t.wordCount.toLocaleString()} words | ${t.category}${c.reset}\n`;
    output += `   ${c.cyan}content/docs/${t.filePath}${c.reset}\n\n`;
  }

  // Output file paths for piping
  output += `\n${c.dim}File paths (for scripting):${c.reset}\n`;
  for (const t of targets) {
    output += `content/docs/${t.filePath}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Show statistics about insight coverage
 */
export async function stats(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const pages = loadPages();
  const { insights } = loadInsights();

  // Count insights per source
  const insightCounts = new Map<string, number>();
  for (const insight of insights) {
    const current = insightCounts.get(insight.source) || 0;
    insightCounts.set(insight.source, current + 1);
  }

  // Calculate stats
  const pagesWithImportance = pages.filter((p: PageEntry) => p.importance != null && p.importance > 0);
  const pagesWithInsights = pagesWithImportance.filter((p: PageEntry) => insightCounts.has(p.path));
  const pagesWithNoInsights = pagesWithImportance.filter((p: PageEntry) => !insightCounts.has(p.path));
  const highImpNoInsights = pagesWithNoInsights.filter((p: PageEntry) => p.importance >= 70);

  // Category breakdown
  const byCategory: Record<string, { total: number; withInsights: number; insightCount: number }> = {};
  for (const page of pagesWithImportance) {
    const cat = page.category || 'unknown';
    if (!byCategory[cat]) {
      byCategory[cat] = { total: 0, withInsights: 0, insightCount: 0 };
    }
    byCategory[cat].total++;
    const count = insightCounts.get(page.path) || 0;
    byCategory[cat].insightCount += count;
    if (count > 0) byCategory[cat].withInsights++;
  }

  const coverageStats = {
    totalInsights: insights.length,
    totalPages: pagesWithImportance.length,
    pagesWithInsights: pagesWithInsights.length,
    pagesWithNoInsights: pagesWithNoInsights.length,
    highImportanceNoInsights: highImpNoInsights.length,
    coverage: Math.round((pagesWithInsights.length / pagesWithImportance.length) * 100),
    avgInsightsPerPage: (insights.length / pagesWithInsights.length).toFixed(1),
    byCategory,
  };

  if (options.ci || options.json) {
    return { output: JSON.stringify(coverageStats, null, 2), exitCode: 0 };
  }

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Insight Coverage Statistics${c.reset}\n\n`;

  output += `${c.bold}Overview:${c.reset}\n`;
  output += `  Total insights: ${coverageStats.totalInsights}\n`;
  output += `  Total pages: ${coverageStats.totalPages}\n`;
  output += `  Pages with insights: ${coverageStats.pagesWithInsights} (${coverageStats.coverage}%)\n`;
  output += `  Pages without insights: ${c.yellow}${coverageStats.pagesWithNoInsights}${c.reset}\n`;
  output += `  High importance, no insights: ${c.red}${coverageStats.highImportanceNoInsights}${c.reset}\n`;
  output += `  Avg insights per page: ${coverageStats.avgInsightsPerPage}\n\n`;

  output += `${c.bold}By Category:${c.reset}\n`;
  for (const [cat, data] of Object.entries(byCategory).sort((a, b) => b[1].total - a[1].total)) {
    const pct = Math.round((data.withInsights / data.total) * 100);
    output += `  ${cat}: ${data.withInsights}/${data.total} pages (${pct}%), ${data.insightCount} insights\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Command registry
 */
export const commands: Record<string, (args: string[], options: Record<string, unknown>) => Promise<CommandResult>> = {
  list,
  targets,
  stats,
};

/**
 * Get help text
 */
export function getHelp(): string {
  return `
Gaps Domain - Find pages needing more insights

Commands:
  list                 List gap candidates (default)
  targets              Show top extraction targets
  stats                Show coverage statistics

Options:
  --ci                 JSON output for CI pipelines
  --json               Output as JSON
  --limit=N            Number of results (default: 20)
  --min-score=N        Minimum gap score (default: 60)
  --no-insights        Only show pages with 0 insights
  --empty              Alias for --no-insights

Examples:
  crux gaps list
  crux gaps list --no-insights --limit=10
  crux gaps targets --json
  crux gaps stats
`;
}
