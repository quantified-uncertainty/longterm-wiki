/**
 * Matrix Command Handlers
 *
 * Analyze entity matrix scores from database.json and identify
 * high-impact improvement targets for automated content loops.
 *
 * Usage:
 *   crux matrix scores [--type=<entityType>] [--sort=gap|score|pages] [--weights=quality:30,...]
 *   crux matrix pages  [--type=<entityType>] [--dimension=content|coverage|quality]
 *                       [--limit=20] [--min-words=100] [--exclude=file] [--include-stubs]
 *   crux matrix next-task [--dimension=content|coverage|quality] [--format=prompt|json]
 *   crux matrix mark-done <pageId>  Mark a page as improved (add to exclusion list)
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';

const STUB_THRESHOLD = 100;
const EXCLUSION_FILE = join(PROJECT_ROOT, '.matrix-improved.txt');

interface CommandOptions extends BaseOptions {
  type?: string; sort?: string; limit?: string; dimension?: string;
  format?: string; ci?: boolean; threshold?: string; minWords?: string;
  exclude?: string; weights?: string; includeStubs?: boolean;
}

interface PageEntry {
  id: string; wikiId?: string; title: string; entityType?: string;
  quality: number | null; readerImportance: number | null; wordCount?: number;
  lastUpdated: string | null;
  coverage?: { passing: number; total: number; items: Record<string, string> };
  citationHealth?: { total: number; withQuotes: number; accuracyChecked: number; avgScore: number | null };
  readerRank?: number; contentFormat?: string; subcategory?: string;
}

interface EntityTypeStats {
  type: string; pageCount: number; avgWordCount: number; avgQuality: number | null;
  avgCoverageScore: number; avgCitationDensity: number; medianDaysSinceUpdate: number;
  contentScore: number; qualityScore: number; coverageScore: number;
}

function loadPages(): PageEntry[] {
  const dbPath = join(PROJECT_ROOT, 'apps/web/src/data/database.json');
  return (JSON.parse(readFileSync(dbPath, 'utf-8')).pages || []) as PageEntry[];
}

function daysSince(dateStr: string | null): number {
  if (!dateStr) return 999;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? 999 : Math.round((Date.now() - d.getTime()) / 86400000);
}

function loadExclusionList(filePath?: string): Set<string> {
  const path = filePath || EXCLUSION_FILE;
  if (!existsSync(path)) return new Set();
  return new Set(readFileSync(path, 'utf-8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
}

function appendToExclusionList(pageId: string, filePath?: string): void {
  const path = filePath || EXCLUSION_FILE;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${pageId}\n`);
}

interface ScoreWeights { quality: number; coverage: number; citations: number; freshness: number; pages: number }
const DEFAULT_WEIGHTS: ScoreWeights = { quality: 30, coverage: 25, citations: 20, freshness: 15, pages: 10 };

function parseWeights(weightsStr?: string): ScoreWeights {
  if (!weightsStr) return DEFAULT_WEIGHTS;
  const w = { ...DEFAULT_WEIGHTS };
  for (const part of weightsStr.split(',')) {
    const [key, val] = part.split(':');
    if (key && val && key in w) (w as Record<string, number>)[key] = parseFloat(val);
  }
  const sum = w.quality + w.coverage + w.citations + w.freshness + w.pages;
  if (sum > 0 && Math.abs(sum - 100) > 0.1) {
    const f = 100 / sum;
    w.quality *= f; w.coverage *= f; w.citations *= f; w.freshness *= f; w.pages *= f;
  }
  return w;
}

function computeEntityTypeStats(pages: PageEntry[], weights?: ScoreWeights): EntityTypeStats[] {
  const w = weights || DEFAULT_WEIGHTS;
  const byType = new Map<string, PageEntry[]>();
  for (const p of pages) {
    if (p.subcategory === 'dashboards' || p.contentFormat === 'dashboard') continue;
    const t = p.entityType || 'none';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(p);
  }
  const stats: EntityTypeStats[] = [];
  for (const [type, typePages] of byType) {
    const n = typePages.length;
    if (n === 0) continue;
    const avgWordCount = Math.round(typePages.reduce((s, p) => s + (p.wordCount || 0), 0) / n);
    const wQ = typePages.filter(p => p.quality != null);
    const avgQuality = wQ.length > 0 ? Math.round(wQ.reduce((s, p) => s + p.quality!, 0) / wQ.length) : null;
    const wC = typePages.filter(p => p.coverage && p.coverage.total > 0);
    const avgCoverageScore = wC.length > 0
      ? Math.round(wC.reduce((s, p) => s + (p.coverage!.passing / p.coverage!.total) * 100, 0) / wC.length) : 0;
    const wCit = typePages.filter(p => p.citationHealth && p.wordCount);
    const avgCitationDensity = wCit.length > 0
      ? Math.round(wCit.reduce((s, p) => s + (p.citationHealth!.total / (p.wordCount! / 1000)), 0) / wCit.length * 10) / 10 : 0;
    const daysList = typePages.map(p => daysSince(p.lastUpdated)).sort((a, b) => a - b);
    const medianDaysSinceUpdate = daysList[Math.floor(daysList.length / 2)];
    const contentScore = Math.round(
      (avgQuality ?? 0) * (w.quality / 100) +
      avgCoverageScore * (w.coverage / 100) +
      Math.min(avgCitationDensity / 10, 1) * 100 * (w.citations / 100) +
      Math.max(0, 100 - (medianDaysSinceUpdate / 3.65)) * (w.freshness / 100) +
      Math.min(n / 5, 1) * 100 * (w.pages / 100)
    );
    stats.push({ type, pageCount: n, avgWordCount, avgQuality, avgCoverageScore, avgCitationDensity,
      medianDaysSinceUpdate, contentScore, qualityScore: avgQuality ?? 0, coverageScore: avgCoverageScore });
  }
  return stats;
}

interface PageImpact {
  id: string; wikiId: string; title: string; entityType: string;
  quality: number; coveragePct: number; wordCount: number; daysSinceUpdate: number;
  importance: number; impactScore: number; reasons: string[];
  isStub: boolean; action: 'create' | 'improve';
}

function computePageImpact(pages: PageEntry[], dimension: string,
  opts?: { minWords?: number; excludeIds?: Set<string>; includeStubs?: boolean }): PageImpact[] {
  const results: PageImpact[] = [];
  const minWords = opts?.minWords ?? 0;
  const excludeIds = opts?.excludeIds ?? new Set<string>();
  const includeStubs = opts?.includeStubs ?? true;

  for (const p of pages) {
    if (!p.entityType) continue;
    if (p.subcategory === 'dashboards' || p.contentFormat === 'dashboard' || p.contentFormat === 'index') continue;
    if (excludeIds.has(p.id) || excludeIds.has(p.wikiId || '')) continue;
    const wc = p.wordCount || 0;
    const isStub = wc < STUB_THRESHOLD;
    if (!includeStubs && isStub) continue;
    if (minWords > 0 && wc < minWords && !isStub) continue;

    const quality = p.quality ?? 0;
    const coveragePct = p.coverage && p.coverage.total > 0
      ? Math.round((p.coverage.passing / p.coverage.total) * 100) : 0;
    const days = daysSince(p.lastUpdated);
    const importance = p.readerImportance ?? 0;
    const reasons: string[] = [];
    if (isStub) reasons.push('stub (needs create)');
    let impactScore = 0;

    if (dimension === 'content' || dimension === 'all') {
      if (quality < 40) reasons.push(`low quality (${quality})`);
      if (quality < 60) impactScore += (60 - quality) * 2;
      if (!isStub && wc < 1000) reasons.push(`short (${wc}w)`);
      if (!isStub && wc < 1500) impactScore += Math.round((1500 - wc) / 30);
      if (isStub) impactScore += 80;
      if (days > 180) reasons.push(`stale (${days}d)`);
      if (days > 90) impactScore += Math.min(Math.round(days / 10), 30);
      if (importance > 50) impactScore += Math.round(importance / 5);
    }
    if (dimension === 'coverage' || dimension === 'all') {
      if (coveragePct < 40) reasons.push(`low coverage (${coveragePct}%)`);
      impactScore += Math.round((100 - coveragePct) * 0.8);
      if (p.coverage?.items) {
        const red = Object.entries(p.coverage.items).filter(([, s]) => s === 'red');
        if (red.length > 3) reasons.push(`${red.length} red items`);
      }
    }
    if (dimension === 'quality' || dimension === 'all') {
      if (quality < 50) reasons.push(`quality ${quality}`);
      impactScore += Math.round((100 - quality) * 0.5);
    }
    if (importance > 60) impactScore = Math.round(impactScore * 1.3);
    else if (importance > 30) impactScore = Math.round(impactScore * 1.1);

    if (impactScore > 0) {
      results.push({ id: p.id, wikiId: p.wikiId || p.id, title: p.title,
        entityType: p.entityType, quality, coveragePct, wordCount: wc, daysSinceUpdate: days,
        importance, impactScore, reasons, isStub, action: isStub ? 'create' : 'improve' });
    }
  }
  return results.sort((a, b) => b.impactScore - a.impactScore);
}

async function scoresCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const pages = loadPages();
  const weights = parseWeights(options.weights as string | undefined);
  const stats = computeEntityTypeStats(pages, weights);
  let filtered = options.type
    ? stats.filter(s => s.type === options.type)
    : stats.filter(s => s.type !== 'none' && s.type !== 'internal');
  const sortBy = (options.sort as string) || 'gap';
  if (sortBy === 'gap' || sortBy === 'content') filtered.sort((a, b) => a.contentScore - b.contentScore);
  else if (sortBy === 'score') filtered.sort((a, b) => b.contentScore - a.contentScore);
  else if (sortBy === 'pages') filtered.sort((a, b) => b.pageCount - a.pageCount);
  else if (sortBy === 'quality') filtered.sort((a, b) => (a.avgQuality ?? 0) - (b.avgQuality ?? 0));
  else if (sortBy === 'coverage') filtered.sort((a, b) => a.avgCoverageScore - b.avgCoverageScore);
  if (options.ci) return { exitCode: 0, output: JSON.stringify(filtered, null, 2) };
  const lines: string[] = [
    `\x1b[1mEntity Matrix: Content Dimension Scores\x1b[0m`,
    `\x1b[2m${filtered.length} entity types, ${pages.length} total pages\x1b[0m`, '',
    `${'Type'.padEnd(22)} ${'Pgs'.padStart(4)} ${'Words'.padStart(6)} ${'Qual'.padStart(5)} ${'Cov%'.padStart(5)} ${'Cit/kw'.padStart(7)} ${'Days'.padStart(5)} ${'Score'.padStart(6)}`,
    `${'─'.repeat(22)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(5)} ${'─'.repeat(6)}`,
  ];
  for (const s of filtered) {
    const q = s.avgQuality != null ? String(s.avgQuality) : '—';
    const c = s.contentScore < 40 ? '\x1b[31m' : s.contentScore < 60 ? '\x1b[33m' : '\x1b[32m';
    lines.push(`${s.type.padEnd(22)} ${String(s.pageCount).padStart(4)} ${String(s.avgWordCount).padStart(6)} ${q.padStart(5)} ${(s.avgCoverageScore + '%').padStart(5)} ${String(s.avgCitationDensity).padStart(7)} ${String(s.medianDaysSinceUpdate).padStart(5)} ${c}${String(s.contentScore).padStart(6)}\x1b[0m`);
  }
  const avg = filtered.length > 0 ? Math.round(filtered.reduce((s, e) => s + e.contentScore, 0) / filtered.length) : 0;
  lines.push('', `\x1b[1mOverall content score: ${avg}%\x1b[0m`,
    `\x1b[2mSort: --sort=${sortBy} | Filter: --type=<name> | Weights: --weights=quality:30,... | JSON: --ci\x1b[0m`);
  return { exitCode: 0, output: lines.join('\n') };
}

async function pagesCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const pages = loadPages();
  const dimension = (options.dimension as string) || 'content';
  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  const minWords = options.minWords ? parseInt(options.minWords, 10) : 0;
  const excludeIds = loadExclusionList(options.exclude as string | undefined);
  const includeStubs = !!options.includeStubs;
  const threshold = options.threshold ? parseInt(options.threshold, 10) : undefined;
  let impacts = computePageImpact(pages, dimension, { minWords, excludeIds, includeStubs });
  if (options.type) impacts = impacts.filter(p => p.entityType === options.type);
  if (threshold !== undefined) impacts = impacts.filter(p => p.quality < threshold || p.coveragePct < threshold);
  const limited = impacts.slice(0, limit);
  if (options.ci) return { exitCode: 0, output: JSON.stringify(limited, null, 2) };
  if (options.format === 'ids') return { exitCode: 0, output: limited.map(p => p.wikiId).join(',') };
  const stubCount = impacts.filter(p => p.isStub).length;
  const lines: string[] = [
    `\x1b[1mTop ${limited.length} pages for improvement (dimension: ${dimension})\x1b[0m`,
    excludeIds.size > 0 ? `\x1b[2m${excludeIds.size} pages excluded via .matrix-improved.txt\x1b[0m` : '',
    stubCount > 0 && !includeStubs ? `\x1b[2m${stubCount} stubs hidden (use --include-stubs)\x1b[0m` : '', '',
    `${'#'.padStart(3)} ${'ID'.padEnd(8)} ${'Act'.padEnd(8)} ${'Title'.padEnd(36)} ${'Type'.padEnd(16)} ${'Q'.padStart(3)} ${'Cov'.padStart(4)} ${'Imp'.padStart(6)} ${'Reasons'}`,
    `${'─'.repeat(3)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(36)} ${'─'.repeat(16)} ${'─'.repeat(3)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(30)}`,
  ].filter(Boolean);
  limited.forEach((p, i) => {
    const title = p.title.length > 35 ? p.title.slice(0, 32) + '...' : p.title;
    const ac = p.action === 'create' ? '\x1b[33m' : '\x1b[32m';
    lines.push(`${String(i + 1).padStart(3)} ${p.wikiId.padEnd(8)} ${ac}${p.action.padEnd(8)}\x1b[0m ${title.padEnd(36)} ${p.entityType.padEnd(16)} ${String(p.quality).padStart(3)} ${(p.coveragePct + '%').padStart(4)} ${String(p.impactScore).padStart(6)} ${p.reasons.join(', ')}`);
  });
  lines.push('', `\x1b[2mOptions: --dimension --type --limit --min-words --include-stubs --exclude=file --format=ids --ci\x1b[0m`);
  return { exitCode: 0, output: lines.join('\n') };
}

async function nextTaskCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const pages = loadPages();
  const dimension = (options.dimension as string) || 'content';
  const format = (options.format as string) || 'prompt';
  const excludeIds = loadExclusionList(options.exclude as string | undefined);
  const includeStubs = !!options.includeStubs;
  let impacts = computePageImpact(pages, dimension, { excludeIds, includeStubs });
  impacts = impacts.filter(p =>
    options.type ? p.entityType === options.type : p.entityType !== 'internal'
  );
  if (impacts.length === 0) {
    return format === 'json'
      ? { exitCode: 0, output: JSON.stringify({ task: null, message: 'NO_TASKS' }) }
      : { exitCode: 0, output: 'NO_TASKS' };
  }
  const top = impacts[0];
  if (format === 'json') return { exitCode: 0, output: JSON.stringify(top, null, 2) };
  const isCreate = top.action === 'create';
  const cmd = isCreate
    ? `pnpm crux content create "${top.title}" --tier=standard`
    : `pnpm crux content improve ${top.wikiId} --tier=standard --apply`;
  return { exitCode: 0, output: `## Task: ${isCreate ? 'Create' : 'Improve'} "${top.title}" (${top.wikiId})

**Action**: \`${top.action}\`${top.isStub ? ' (stub — needs full content creation)' : ''}
**Entity type**: ${top.entityType}
**Current quality**: ${top.quality}/100
**Coverage**: ${top.coveragePct}%
**Word count**: ${top.wordCount}
**Days since update**: ${top.daysSinceUpdate}
**Importance**: ${top.importance}/100
**Impact score**: ${top.impactScore}
**Issues**: ${top.reasons.join(', ')}

### Steps

1. Run \`pnpm crux agent-checklist init "${isCreate ? 'Create' : 'Improve'} ${top.title}" --type=content\`
2. Run \`${cmd}\`
3. Run \`pnpm crux fix escaping && pnpm crux fix markdown\`
4. Run \`pnpm crux validate gate --fix\`
5. Run \`pnpm crux matrix mark-done ${top.wikiId}\`
6. Commit changes
7. Open PR via \`/agent-session-ready-PR\`` };
}

async function markDoneCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const pageId = args.find(a => !a.startsWith('--'));
  if (!pageId) return { exitCode: 1, output: 'Usage: crux matrix mark-done <pageId>' };
  const excludePath = (options.exclude as string) || EXCLUSION_FILE;
  appendToExclusionList(pageId, excludePath);
  if (options.ci) return { exitCode: 0, output: JSON.stringify({ marked: pageId, file: excludePath }) };
  return { exitCode: 0, output: `\x1b[32m✓\x1b[0m Marked ${pageId} as done (added to ${excludePath})` };
}

export const commands = {
  scores: scoresCommand,
  pages: pagesCommand,
  'next-task': nextTaskCommand,
  'mark-done': markDoneCommand,
  default: scoresCommand,
};

export function getHelp(): string {
  return `
Matrix Domain — Entity matrix analysis and improvement targeting

Commands:
  scores      Show content dimension scores per entity type
  pages       List pages ranked by improvement potential
  next-task   Output the highest-impact improvement task (create or improve)
  mark-done   Mark a page as improved (excluded from future picks)

Options:
  --type=<entityType>     Filter to specific entity type
  --dimension=<dim>       content, coverage, quality, all (default: content)
  --sort=<key>            gap (default), score, pages, quality, coverage
  --limit=N               Number of pages (default: 20)
  --min-words=N           Minimum word count filter
  --include-stubs         Include stub pages (< ${STUB_THRESHOLD} words)
  --exclude=<file>        Exclusion list file (default: .matrix-improved.txt)
  --weights=<w>           quality:30,coverage:25,citations:20,freshness:15,pages:10
  --threshold=N           Only pages below this quality/coverage score
  --format=prompt|json|ids Output format
  --ci                    JSON output

Examples:
  crux matrix                                    # Entity type scorecard
  crux matrix scores --weights=quality:50,coverage:50  # Custom weights
  crux matrix pages --include-stubs              # Show stub pages too
  crux matrix pages --format=ids --limit=10      # IDs for batch piping
  crux matrix next-task                          # Prompt for next improve task
  crux matrix next-task --include-stubs          # Include stub pages (create tasks)
  crux matrix next-task --type=person            # Only person pages
  crux matrix mark-done E357                     # Exclude from future picks
`;
}
