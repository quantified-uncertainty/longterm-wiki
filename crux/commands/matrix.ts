/**
 * Matrix Command Handlers
 *
 * Analyze entity matrix scores from database.json and identify
 * high-impact improvement targets for automated content loops.
 *
 * Usage:
 *   crux matrix scores [--type=<entityType>] [--sort=gap|score|pages]
 *   crux matrix pages  [--type=<entityType>] [--dimension=content|coverage|quality]
 *                       [--limit=20] [--sort=impact|quality|coverage|freshness]
 *   crux matrix next-task [--dimension=content|coverage|quality] [--format=prompt|json]
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandOptions extends BaseOptions {
  type?: string;
  sort?: string;
  limit?: string;
  dimension?: string;
  format?: string;
  ci?: boolean;
  threshold?: string;
}

interface PageEntry {
  id: string;
  numericId?: string;
  title: string;
  entityType?: string;
  quality: number | null;
  readerImportance: number | null;
  wordCount?: number;
  lastUpdated: string | null;
  coverage?: {
    passing: number;
    total: number;
    items: Record<string, string>;
  };
  citationHealth?: {
    total: number;
    withQuotes: number;
    accuracyChecked: number;
    avgScore: number | null;
  };
  readerRank?: number;
  contentFormat?: string;
  subcategory?: string;
}

interface EntityTypeStats {
  type: string;
  pageCount: number;
  avgWordCount: number;
  avgQuality: number | null;
  avgCoverageScore: number;
  avgCitationDensity: number;
  medianDaysSinceUpdate: number;
  contentScore: number;
  qualityScore: number;
  coverageScore: number;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadPages(): PageEntry[] {
  const dbPath = join(PROJECT_ROOT, 'apps/web/src/data/database.json');
  const raw = readFileSync(dbPath, 'utf-8');
  const db = JSON.parse(raw);
  return (db.pages || []) as PageEntry[];
}

function daysSince(dateStr: string | null): number {
  if (!dateStr) return 999;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 999;
  return Math.round((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

function computeEntityTypeStats(pages: PageEntry[]): EntityTypeStats[] {
  const byType = new Map<string, PageEntry[]>();

  for (const p of pages) {
    // Skip internal/dashboard pages
    if (p.subcategory === 'dashboards' || p.contentFormat === 'dashboard') continue;
    const t = p.entityType || 'none';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(p);
  }

  const stats: EntityTypeStats[] = [];

  for (const [type, typePages] of byType) {
    const n = typePages.length;
    if (n === 0) continue;

    // Average word count
    const totalWords = typePages.reduce((s, p) => s + (p.wordCount || 0), 0);
    const avgWordCount = Math.round(totalWords / n);

    // Average quality (null-safe)
    const withQuality = typePages.filter(p => p.quality != null);
    const avgQuality = withQuality.length > 0
      ? Math.round(withQuality.reduce((s, p) => s + p.quality!, 0) / withQuality.length)
      : null;

    // Average coverage score (passing/total as percentage)
    const withCoverage = typePages.filter(p => p.coverage && p.coverage.total > 0);
    const avgCoverageScore = withCoverage.length > 0
      ? Math.round(withCoverage.reduce((s, p) => s + (p.coverage!.passing / p.coverage!.total) * 100, 0) / withCoverage.length)
      : 0;

    // Average citation density (citations per 1000 words)
    const withCitations = typePages.filter(p => p.citationHealth && p.wordCount);
    const avgCitationDensity = withCitations.length > 0
      ? Math.round(withCitations.reduce((s, p) =>
        s + (p.citationHealth!.total / (p.wordCount! / 1000)), 0) / withCitations.length * 10) / 10
      : 0;

    // Median days since update
    const daysList = typePages.map(p => daysSince(p.lastUpdated)).sort((a, b) => a - b);
    const medianDaysSinceUpdate = daysList[Math.floor(daysList.length / 2)];

    // Composite content score (0-100):
    // - 30% avg quality
    // - 25% avg coverage
    // - 20% citation density (0-10 per kw → 0-100)
    // - 15% freshness (0 days = 100, 365+ days = 0)
    // - 10% page count density (>5 pages = full marks for entity types that should have multiple)
    const qualityComponent = (avgQuality ?? 0) * 0.30;
    const coverageComponent = avgCoverageScore * 0.25;
    const citDensityNorm = Math.min(avgCitationDensity / 10, 1) * 100;
    const citationComponent = citDensityNorm * 0.20;
    const freshnessNorm = Math.max(0, 100 - (medianDaysSinceUpdate / 3.65));
    const freshnessComponent = freshnessNorm * 0.15;
    const pageCountNorm = Math.min(n / 5, 1) * 100;
    const pageCountComponent = pageCountNorm * 0.10;

    const contentScore = Math.round(
      qualityComponent + coverageComponent + citationComponent + freshnessComponent + pageCountComponent
    );

    stats.push({
      type,
      pageCount: n,
      avgWordCount,
      avgQuality,
      avgCoverageScore,
      avgCitationDensity,
      medianDaysSinceUpdate,
      contentScore,
      qualityScore: avgQuality ?? 0,
      coverageScore: avgCoverageScore,
    });
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Page improvement potential
// ---------------------------------------------------------------------------

interface PageImpact {
  id: string;
  numericId: string;
  title: string;
  entityType: string;
  quality: number;
  coveragePct: number;
  wordCount: number;
  daysSinceUpdate: number;
  importance: number;
  impactScore: number;
  reasons: string[];
}

function computePageImpact(pages: PageEntry[], dimension: string): PageImpact[] {
  const results: PageImpact[] = [];

  for (const p of pages) {
    if (!p.entityType) continue;
    if (p.subcategory === 'dashboards' || p.contentFormat === 'dashboard') continue;
    if (p.contentFormat === 'index') continue;

    const quality = p.quality ?? 0;
    const coveragePct = p.coverage && p.coverage.total > 0
      ? Math.round((p.coverage.passing / p.coverage.total) * 100)
      : 0;
    const wordCount = p.wordCount || 0;
    const days = daysSince(p.lastUpdated);
    const importance = p.readerImportance ?? 0;
    const reasons: string[] = [];

    let impactScore = 0;

    if (dimension === 'content' || dimension === 'all') {
      // Higher impact for: low quality, high importance, stale content, short pages
      if (quality < 40) reasons.push(`low quality (${quality})`);
      if (quality < 60) impactScore += (60 - quality) * 2;
      if (wordCount < 1000) reasons.push(`short (${wordCount}w)`);
      if (wordCount < 1500) impactScore += Math.round((1500 - wordCount) / 30);
      if (days > 180) reasons.push(`stale (${days}d)`);
      if (days > 90) impactScore += Math.min(Math.round(days / 10), 30);
      if (importance > 50) impactScore += Math.round(importance / 5);
    }

    if (dimension === 'coverage' || dimension === 'all') {
      if (coveragePct < 40) reasons.push(`low coverage (${coveragePct}%)`);
      impactScore += Math.round((100 - coveragePct) * 0.8);

      // Check specific missing items
      if (p.coverage?.items) {
        const red = Object.entries(p.coverage.items).filter(([, s]) => s === 'red');
        if (red.length > 3) reasons.push(`${red.length} red items`);
      }
    }

    if (dimension === 'quality' || dimension === 'all') {
      if (quality < 50) reasons.push(`quality ${quality}`);
      impactScore += Math.round((100 - quality) * 0.5);
    }

    // Importance multiplier
    if (importance > 60) impactScore = Math.round(impactScore * 1.3);
    else if (importance > 30) impactScore = Math.round(impactScore * 1.1);

    if (impactScore > 0) {
      results.push({
        id: p.id,
        numericId: p.numericId || p.id,
        title: p.title,
        entityType: p.entityType,
        quality,
        coveragePct,
        wordCount,
        daysSinceUpdate: days,
        importance,
        impactScore,
        reasons,
      });
    }
  }

  return results.sort((a, b) => b.impactScore - a.impactScore);
}

// ---------------------------------------------------------------------------
// scores command
// ---------------------------------------------------------------------------

async function scoresCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const pages = loadPages();
  const stats = computeEntityTypeStats(pages);
  const filterType = options.type;
  const sortBy = (options.sort as string) || 'gap';

  let filtered = filterType
    ? stats.filter(s => s.type === filterType)
    : stats.filter(s => s.type !== 'none' && s.type !== 'internal');

  // Sort
  if (sortBy === 'gap' || sortBy === 'content') {
    filtered.sort((a, b) => a.contentScore - b.contentScore);
  } else if (sortBy === 'score') {
    filtered.sort((a, b) => b.contentScore - a.contentScore);
  } else if (sortBy === 'pages') {
    filtered.sort((a, b) => b.pageCount - a.pageCount);
  } else if (sortBy === 'quality') {
    filtered.sort((a, b) => (a.avgQuality ?? 0) - (b.avgQuality ?? 0));
  } else if (sortBy === 'coverage') {
    filtered.sort((a, b) => a.avgCoverageScore - b.avgCoverageScore);
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(filtered, null, 2) };
  }

  const lines: string[] = [
    `\x1b[1mEntity Matrix: Content Dimension Scores\x1b[0m`,
    `\x1b[2m${filtered.length} entity types, ${pages.length} total pages\x1b[0m`,
    '',
    `${'Type'.padEnd(22)} ${'Pgs'.padStart(4)} ${'Words'.padStart(6)} ${'Qual'.padStart(5)} ${'Cov%'.padStart(5)} ${'Cit/kw'.padStart(7)} ${'Days'.padStart(5)} ${'Score'.padStart(6)}`,
    `${'─'.repeat(22)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(5)} ${'─'.repeat(6)}`,
  ];

  for (const s of filtered) {
    const q = s.avgQuality != null ? String(s.avgQuality) : '—';
    const scoreColor = s.contentScore < 40 ? '\x1b[31m' : s.contentScore < 60 ? '\x1b[33m' : '\x1b[32m';
    lines.push(
      `${s.type.padEnd(22)} ${String(s.pageCount).padStart(4)} ${String(s.avgWordCount).padStart(6)} ${q.padStart(5)} ${(s.avgCoverageScore + '%').padStart(5)} ${String(s.avgCitationDensity).padStart(7)} ${String(s.medianDaysSinceUpdate).padStart(5)} ${scoreColor}${String(s.contentScore).padStart(6)}\x1b[0m`
    );
  }

  const overallAvg = filtered.length > 0
    ? Math.round(filtered.reduce((s, e) => s + e.contentScore, 0) / filtered.length)
    : 0;
  lines.push('');
  lines.push(`\x1b[1mOverall content score: ${overallAvg}%\x1b[0m`);
  lines.push(`\x1b[2mSort: --sort=${sortBy} | Filter: --type=<name> | JSON: --ci\x1b[0m`);

  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// pages command
// ---------------------------------------------------------------------------

async function pagesCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const pages = loadPages();
  const dimension = (options.dimension as string) || 'content';
  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  const filterType = options.type;
  const threshold = options.threshold ? parseInt(options.threshold, 10) : undefined;

  let impacts = computePageImpact(pages, dimension);

  if (filterType) {
    impacts = impacts.filter(p => p.entityType === filterType);
  }

  if (threshold !== undefined) {
    impacts = impacts.filter(p => p.quality < threshold || p.coveragePct < threshold);
  }

  const limited = impacts.slice(0, limit);

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(limited, null, 2) };
  }

  if (options.format === 'ids') {
    return { exitCode: 0, output: limited.map(p => p.numericId).join(',') };
  }

  const lines: string[] = [
    `\x1b[1mTop ${limited.length} pages for improvement (dimension: ${dimension})\x1b[0m`,
    '',
    `${'#'.padStart(3)} ${'ID'.padEnd(8)} ${'Title'.padEnd(40)} ${'Type'.padEnd(16)} ${'Q'.padStart(3)} ${'Cov'.padStart(4)} ${'Imp'.padStart(6)} ${'Reasons'}`,
    `${'─'.repeat(3)} ${'─'.repeat(8)} ${'─'.repeat(40)} ${'─'.repeat(16)} ${'─'.repeat(3)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(30)}`,
  ];

  limited.forEach((p, i) => {
    const title = p.title.length > 39 ? p.title.slice(0, 36) + '...' : p.title;
    lines.push(
      `${String(i + 1).padStart(3)} ${p.numericId.padEnd(8)} ${title.padEnd(40)} ${p.entityType.padEnd(16)} ${String(p.quality).padStart(3)} ${(p.coveragePct + '%').padStart(4)} ${String(p.impactScore).padStart(6)} ${p.reasons.join(', ')}`
    );
  });

  lines.push('');
  lines.push(`\x1b[2mOptions: --dimension=${dimension} --type=<name> --limit=${limit} --threshold=<N> --format=ids --ci\x1b[0m`);

  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// next-task command
// ---------------------------------------------------------------------------

async function nextTaskCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const pages = loadPages();
  const dimension = (options.dimension as string) || 'content';
  const format = (options.format as string) || 'prompt';

  const impacts = computePageImpact(pages, dimension);

  if (impacts.length === 0) {
    if (format === 'json') {
      return { exitCode: 0, output: JSON.stringify({ task: null, message: 'NO_TASKS' }) };
    }
    return { exitCode: 0, output: 'NO_TASKS' };
  }

  const top = impacts[0];

  if (format === 'json') {
    return { exitCode: 0, output: JSON.stringify(top, null, 2) };
  }

  // Generate a prompt for Claude Code
  const prompt = `## Task: Improve "${top.title}" (${top.numericId})

**Entity type**: ${top.entityType}
**Current quality**: ${top.quality}/100
**Coverage**: ${top.coveragePct}%
**Word count**: ${top.wordCount}
**Days since update**: ${top.daysSinceUpdate}
**Importance**: ${top.importance}/100
**Impact score**: ${top.impactScore}
**Issues**: ${top.reasons.join(', ')}

### Steps

1. Run \`pnpm crux agent-checklist init "Improve ${top.title}" --type=content\`
2. Run \`pnpm crux content improve ${top.numericId} --tier=standard --apply\`
3. Run \`pnpm crux fix escaping && pnpm crux fix markdown\`
4. Run \`pnpm crux validate gate --fix\`
5. Commit changes
6. Open PR via \`/agent-session-ready-PR\``;

  return { exitCode: 0, output: prompt };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands = {
  scores: scoresCommand,
  pages: pagesCommand,
  'next-task': nextTaskCommand,
  default: scoresCommand,
};

export function getHelp(): string {
  return `
Matrix Domain — Entity matrix analysis and improvement targeting

Commands:
  scores      Show content dimension scores per entity type
  pages       List pages ranked by improvement potential
  next-task   Output the highest-impact improvement task

Options:
  --type=<entityType>     Filter to specific entity type
  --dimension=<dim>       Dimension to analyze: content, coverage, quality, all (default: content)
  --sort=<key>            Sort by: gap (default), score, pages, quality, coverage
  --limit=N               Number of pages to show (pages only, default: 20)
  --threshold=N           Only show pages below this quality/coverage threshold
  --format=prompt|json|ids Output format (next-task/pages only)
  --ci                    JSON output

Examples:
  crux matrix                                    # Show entity type scores
  crux matrix scores --sort=gap                  # Sorted by biggest gap
  crux matrix pages --dimension=content          # Top pages to improve
  crux matrix pages --type=person --limit=10     # Person pages to improve
  crux matrix pages --format=ids --limit=10      # Just IDs for batch improve
  crux matrix next-task                          # Prompt for next task
  crux matrix next-task --format=json            # JSON task description
`;
}
