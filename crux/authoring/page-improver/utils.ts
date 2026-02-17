/**
 * Utility functions for the page-improver pipeline.
 *
 * Includes frontmatter repair, section stripping, page loading,
 * and shared constants.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPhaseLogger } from '../../lib/output.ts';
import { getApiKey } from '../../lib/api-keys.ts';
import type { AnalysisResult, PageData, TierConfig } from './types.ts';
import { FRONTMATTER_RE } from '../../lib/patterns.ts';

// ── Shared constants ─────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT: string = path.join(__dirname, '../../..');

export const NODE_TSX: string = 'node --import tsx/esm --no-warnings';
export const TEMP_DIR: string = path.join(ROOT, '.claude/temp/page-improver');

export const SCRY_PUBLIC_KEY: string = getApiKey('SCRY_API_KEY') || 'exopriors_public_readonly_v1_2025';

export const log = createPhaseLogger();

export const CRITICAL_RULES: string[] = [
  'dollar-signs',
  'comparison-operators',
  'frontmatter-schema',
  'entitylink-ids',
  'internal-links',
  'fake-urls',
  'component-props',
  'citation-urls',
];

export const QUALITY_RULES: string[] = [
  'tilde-dollar',
  'markdown-lists',
  'consecutive-bold-labels',
  'placeholders',
  'vague-citations',
  'temporal-artifacts',
  'evaluative-framing',
  'tone-markers',
  'false-certainty',
  'prescriptive-language',
  'unsourced-biographical-claims',
  'evaluative-flattery',
];

export const TIERS: Record<string, TierConfig> = {
  polish: {
    name: 'Polish',
    cost: '$2-3',
    phases: ['analyze', 'improve', 'validate'],
    description: 'Quick single-pass improvement without research'
  },
  standard: {
    name: 'Standard',
    cost: '$5-8',
    phases: ['analyze', 'research', 'improve', 'validate', 'review'],
    description: 'Light research + improvement + validation + review'
  },
  deep: {
    name: 'Deep Research',
    cost: '$10-15',
    phases: ['analyze', 'research-deep', 'improve', 'validate', 'review', 'gap-fill'],
    description: 'Full SCRY + web research, validation, multi-phase improvement'
  }
};

// ── File operations ──────────────────────────────────────────────────────────

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function writeTemp(pageId: string, filename: string, content: string | object): string {
  const dir = path.join(TEMP_DIR, pageId);
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return filePath;
}

export function getFilePath(pagePath: string): string {
  const cleanPath = pagePath.replace(/^\/|\/$/g, '');
  return path.join(ROOT, 'content/docs', cleanPath + '.mdx');
}

export function getImportPath(): string {
  return '@components/wiki';
}

// ── Page loading ─────────────────────────────────────────────────────────────

export function loadPages(): PageData[] {
  const pagesPath = path.join(ROOT, 'app/src/data/pages.json');
  if (!fs.existsSync(pagesPath)) {
    console.error('Error: pages.json not found. Run `pnpm build` first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(pagesPath, 'utf-8'));
}

function enrichWithFrontmatterRatings(page: PageData): PageData {
  try {
    const filePath = getFilePath(page.path);
    if (!fs.existsSync(filePath)) return page;
    const content = fs.readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(FRONTMATTER_RE);
    if (!fmMatch) return page;
    const fm = fmMatch[1];
    const ratingsMatch = fm.match(/^ratings:\s*\n((?:\s+\w+:\s*[\d.]+\n?)*)/m);
    if (ratingsMatch) {
      const ratings: Record<string, number> = {};
      const lines = ratingsMatch[1].split('\n');
      for (const line of lines) {
        const kv = line.match(/^\s+(\w+):\s*([\d.]+)/);
        if (kv) ratings[kv[1]] = parseFloat(kv[2]);
      }
      page.ratings = ratings;
    }
  } catch {
    // Silently ignore — ratings enrichment is best-effort
  }
  return page;
}

export function findPage(pages: PageData[], query: string): PageData | null {
  let page = pages.find(p => p.id === query);
  if (page) return enrichWithFrontmatterRatings(page);

  const matches = pages.filter(p =>
    p.id.includes(query) || p.title.toLowerCase().includes(query.toLowerCase())
  );
  if (matches.length === 1) return enrichWithFrontmatterRatings(matches[0]);
  if (matches.length > 1) {
    console.log('Multiple matches found:');
    matches.slice(0, 10).forEach(p => console.log(`  - ${p.id} (${p.title})`));
    process.exit(1);
  }
  return null;
}

// ── Content transforms ───────────────────────────────────────────────────────

/**
 * Validate and repair YAML frontmatter after model generation.
 * Catches common LLM errors like merged lines, missing newlines, etc.
 */
export function repairFrontmatter(content: string): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return content;

  let fm = fmMatch[2];
  const rest = content.slice(fmMatch[0].length);

  // Fix 1: Lines where a YAML key:value is merged with another key on the same line.
  fm = fm.replace(/^([ \t]+\w+:[ \t]*\S+?)([a-zA-Z_][\w]*:[ \t])/gm, '$1\n$2');

  // Fix 2: Remove backslash-escaping from YAML string values.
  fm = fm.replace(/^(\w+:.*)\\\$/gm, '$1$');
  fm = fm.replace(/^([ \t]+\w+:.*)\\\$/gm, '$1$');

  // Fix 3: Top-level keys that got incorrectly indented under a block.
  const knownSubKeys = new Set([
    'novelty', 'rigor', 'actionability', 'completeness',
    'objectivity', 'focus', 'concreteness',
    'order', 'label',
  ]);
  const topLevelKeys = new Set([
    'title', 'description', 'sidebar', 'quality', 'readerImportance', 'lastEdited',
    'update_frequency', 'evergreen', 'llmSummary', 'ratings', 'clusters',
    'draft', 'aliases', 'redirects', 'tags',
  ]);
  const lines = fm.split('\n');
  const repaired: string[] = [];
  for (const line of lines) {
    const indentedKeyMatch = line.match(/^(\s{2,})(\w+):\s/);
    if (indentedKeyMatch) {
      const key = indentedKeyMatch[2];
      if (topLevelKeys.has(key) && !knownSubKeys.has(key)) {
        repaired.push(line.replace(/^\s+/, ''));
        continue;
      }
    }
    repaired.push(line);
  }
  fm = repaired.join('\n');

  return '---\n' + fm + '\n---' + rest;
}

const RELATED_SECTION_PATTERNS = [
  /^## Related Pages\s*$/,
  /^## See Also\s*$/,
  /^## Related Content\s*$/,
];

/**
 * Remove manual "Related Pages" / "See Also" / "Related Content" sections.
 * These are now rendered automatically by the RelatedPages React component.
 */
export function stripRelatedPagesSections(content: string): string {
  const lines = content.split('\n');

  const sectionStarts: { index: number; heading: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^## /.test(lines[i].trimEnd())) {
      sectionStarts.push({ index: i, heading: lines[i].trimEnd() });
    }
  }

  const rangesToRemove: { start: number; end: number }[] = [];
  for (const { index, heading } of sectionStarts) {
    if (!RELATED_SECTION_PATTERNS.some(p => p.test(heading))) continue;

    const nextSection = sectionStarts.find(s => s.index > index);
    let endIndex = nextSection ? nextSection.index : lines.length;
    while (endIndex > index && lines[endIndex - 1].trim() === '') endIndex--;

    let startIndex = index;
    let checkIdx = index - 1;
    while (checkIdx >= 0 && lines[checkIdx].trim() === '') checkIdx--;
    if (checkIdx >= 0 && /^---\s*$/.test(lines[checkIdx])) startIndex = checkIdx;
    while (startIndex > 0 && lines[startIndex - 1].trim() === '') startIndex--;

    rangesToRemove.push({ start: startIndex, end: endIndex });
  }

  rangesToRemove.sort((a, b) => b.start - a.start);
  for (const { start, end } of rangesToRemove) {
    lines.splice(start, end - start);
  }

  let result = lines.join('\n');

  // Clean up Backlinks import if no <Backlinks usage remains
  const contentWithoutImports = result.replace(/^import\s.*$/gm, '');
  if (!/<Backlinks[\s/>]/.test(contentWithoutImports)) {
    result = result.replace(
      /^(import\s*\{)([^}]*)(}\s*from\s*['"]@components\/wiki['"];?\s*)$/gm,
      (match, prefix, imports, suffix) => {
        const importList = imports.split(',').map((s: string) => s.trim()).filter(Boolean);
        if (!importList.includes('Backlinks')) return match;
        const filtered = importList.filter((s: string) => s !== 'Backlinks');
        if (filtered.length === 0) return '';
        return `${prefix}${filtered.join(', ')}${suffix}`;
      }
    );
    result = result.replace(/\n{3,}/g, '\n\n');
  }

  result = result.replace(/\n{3,}$/g, '\n');
  if (!result.endsWith('\n')) result += '\n';

  return result;
}

/** Build objectivity context from previous ratings and analysis. */
export function buildObjectivityContext(page: PageData, analysis: AnalysisResult): string {
  const parts: string[] = [];
  const objScore = page.ratings?.objectivity;

  if (objScore !== undefined && objScore < 6) {
    parts.push(`## ⚠️ Objectivity Alert`);
    parts.push(`This page's previous objectivity rating was **${objScore}/10** (below the 6.0 threshold).`);
    parts.push(`Pay special attention to neutrality — this page has a history of biased framing.`);
    parts.push('');
  }

  const objectivityIssues = (analysis as Record<string, unknown>).objectivityIssues as string[] | undefined;
  if (objectivityIssues && objectivityIssues.length > 0) {
    if (parts.length === 0) parts.push('## Objectivity Issues Found in Analysis');
    else parts.push('### Specific Issues Identified');
    for (const issue of objectivityIssues) {
      parts.push(`- ${issue}`);
    }
    parts.push('');
    parts.push('**Fix all of these objectivity issues** in your improvement. Replace evaluative language with neutral descriptions backed by data.');
    parts.push('');
  }

  return parts.length > 0 ? '\n' + parts.join('\n') + '\n' : '';
}
