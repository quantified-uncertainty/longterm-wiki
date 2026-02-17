/**
 * Metrics Extractor Module
 *
 * Extracts structural quality metrics from MDX content.
 * Used by build-data.mjs to compute page quality scores.
 *
 * Visual detection delegates to visual-detection.ts which derives
 * its patterns from the canonical VisualType in data/schema.ts.
 */

import {
  countDiagrams,
  countTables,
  countVisuals,
} from './visual-detection.ts';
import { stripFrontmatter } from './patterns.ts';

export type { VisualCounts } from './visual-detection.ts';
export { countVisuals, countDiagrams, countTables } from './visual-detection.ts';

export interface SectionCount {
  h2: number;
  h3: number;
  total: number;
}

/** Content format used for format-aware structural scoring. */
export type ContentFormat = 'article' | 'table' | 'diagram' | 'index' | 'dashboard';

export interface ContentMetrics {
  wordCount: number;
  tableCount: number;
  diagramCount: number;
  internalLinks: number;
  externalLinks: number;
  footnoteCount: number;
  sectionCount: SectionCount;
  codeBlockCount: number;
  bulletRatio: number;
  hasOverview: boolean;
  hasConclusion: boolean;
  structuralScore: number;
  structuralScoreNormalized: number;
  /** Content format used for scoring. */
  contentFormat?: ContentFormat;
  /** Per-type visual counts (mermaid, squiggle, cause-effect, etc.) */
  visualCounts?: VisualCounts;
}

export interface QualityDiscrepancy {
  current: number;
  suggested: number;
  discrepancy: number;
  flag: 'large' | 'minor' | 'ok';
}

/**
 * Extract all structural metrics from MDX content.
 * @param contentFormat — drives format-aware structural scoring (default: 'article')
 */
export function extractMetrics(content: string, filePath: string = '', contentFormat: ContentFormat = 'article'): ContentMetrics {
  // Remove frontmatter for analysis
  const bodyContent = stripFrontmatter(content);

  // Remove import statements
  const contentNoImports = bodyContent.replace(/^import\s+.*$/gm, '');

  // Use shared visual detection for comprehensive counting
  const visualCounts = countVisuals(contentNoImports);

  const metrics: ContentMetrics = {
    // Raw counts — table/diagram counts now include ALL visual types
    wordCount: countWords(contentNoImports),
    tableCount: countTables(contentNoImports),
    diagramCount: countDiagrams(contentNoImports),
    internalLinks: countInternalLinks(contentNoImports),
    externalLinks: countExternalLinks(contentNoImports),
    footnoteCount: countFootnoteRefs(contentNoImports),
    sectionCount: countSections(contentNoImports),
    codeBlockCount: countCodeBlocks(contentNoImports),

    // Ratios
    bulletRatio: calculateBulletRatio(contentNoImports),

    // Boolean checks
    hasOverview: hasSection(contentNoImports, /^##\s+overview/im),
    hasConclusion: hasSection(contentNoImports, /^##\s+(conclusion|summary|implications|key\s+takeaways)/im),

    // Structural score (0-15 raw)
    structuralScore: 0,

    // Normalized score (0-50)
    structuralScoreNormalized: 0,

    // Content format used for scoring
    contentFormat,

    // Detailed per-type visual counts
    visualCounts,
  };

  // Calculate structural score (format-aware)
  metrics.structuralScore = calculateStructuralScore(metrics, contentFormat);
  metrics.structuralScoreNormalized = Math.round((metrics.structuralScore / 15) * 50);

  return metrics;
}

/**
 * Count words in content (excluding code blocks and JSX)
 */
export function countWords(content: string): number {
  let text = content;
  // Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, '');
  // Remove inline code
  text = text.replace(/`[^`]+`/g, '');
  // Remove JSX components
  // Handle Mermaid components with template literals containing special chars
  text = text.replace(/<Mermaid[^`]*`[\s\S]*?`\s*}\s*\/>/g, '');
  // Handle other self-closing JSX (simple cases)
  text = text.replace(/<[A-Z][a-zA-Z]*\s+[^/]*\/>/g, '');
  text = text.replace(/<[A-Z][a-zA-Z]*\s*\/>/g, '');
  // Handle paired JSX tags
  text = text.replace(/<[A-Z][a-zA-Z]*[^>]*>[\s\S]*?<\/[A-Z][a-zA-Z]*>/g, '');
  // Remove markdown links but keep text (BEFORE removing URLs!)
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove URLs
  text = text.replace(/https?:\/\/\S+/g, '');
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, '');
  // Count words
  const words = text.split(/\s+/).filter(w => w.length > 0);
  return words.length;
}

/**
 * Count internal links (links to other pages in the knowledge base)
 */
export function countInternalLinks(content: string): number {
  // Match markdown links to internal paths
  const internalLinkPattern = /\]\(\/[^)]+\)/g;
  const mdLinks = content.match(internalLinkPattern) || [];

  // Match entity links like <EntityLink id="...">
  const entityLinkPattern = /<EntityLink[^>]*>/g;
  const entityLinks = content.match(entityLinkPattern) || [];

  // Match R component links
  const rLinkPattern = /<R\s+id=/g;
  const rLinks = content.match(rLinkPattern) || [];

  return mdLinks.length + entityLinks.length + rLinks.length;
}

/**
 * Count external links (links to outside sources)
 */
export function countExternalLinks(content: string): number {
  // Match markdown links to external URLs
  const externalLinkPattern = /\]\(https?:\/\/[^)]+\)/g;
  const matches = content.match(externalLinkPattern) || [];
  return matches.length;
}

/**
 * Count unique GFM footnote references [^N] (excluding definitions)
 */
export function countFootnoteRefs(content: string): number {
  const refs = new Set<string>();
  const pattern = /\[\^(\d+)\]/g;
  for (const line of content.split('\n')) {
    if (/^\[\^\d+\]:/.test(line.trim())) continue; // Skip definitions
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      refs.add(match[1]);
    }
  }
  return refs.size;
}

/**
 * Count h2 and h3 sections
 */
function countSections(content: string): SectionCount {
  const h2Pattern = /^##\s+/gm;
  const h3Pattern = /^###\s+/gm;
  const h2s = content.match(h2Pattern) || [];
  const h3s = content.match(h3Pattern) || [];
  return { h2: h2s.length, h3: h3s.length, total: h2s.length + h3s.length };
}

/**
 * Count code blocks
 */
function countCodeBlocks(content: string): number {
  const codeBlockPattern = /```[\s\S]*?```/g;
  const matches = content.match(codeBlockPattern) || [];
  return matches.length;
}

/**
 * Calculate ratio of content in bullet points (0-1)
 */
function calculateBulletRatio(content: string): number {
  // Remove code blocks first
  let text = content.replace(/```[\s\S]*?```/g, '');

  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return 0;

  // Count bullet lines (- or * or numbered)
  const bulletPattern = /^\s*[-*]\s+|^\s*\d+\.\s+/;
  const bulletLines = lines.filter(l => bulletPattern.test(l));

  return bulletLines.length / lines.length;
}

/**
 * Check if content has a specific section
 */
function hasSection(content: string, pattern: RegExp): boolean {
  return pattern.test(content);
}

/**
 * Calculate structural score (0-15).
 * Scoring formulas are tailored to content format.
 */
function calculateStructuralScore(metrics: ContentMetrics, contentFormat: ContentFormat = 'article'): number {
  if (contentFormat === 'table') return calculateTableScore(metrics);
  if (contentFormat === 'diagram') return calculateDiagramScore(metrics);
  if (contentFormat === 'index' || contentFormat === 'dashboard') return calculateIndexScore(metrics);
  return calculateArticleScore(metrics);
}

/** Article scoring (default) — prose-centric, rewards depth */
function calculateArticleScore(metrics: ContentMetrics): number {
  let score = 0;
  if (metrics.wordCount >= 800) score += 2;
  else if (metrics.wordCount >= 300) score += 1;
  if (metrics.tableCount >= 3) score += 3;
  else if (metrics.tableCount >= 2) score += 2;
  else if (metrics.tableCount >= 1) score += 1;
  if (metrics.diagramCount >= 2) score += 2;
  else if (metrics.diagramCount >= 1) score += 1;
  if (metrics.internalLinks >= 4) score += 2;
  else if (metrics.internalLinks >= 1) score += 1;
  const citationCount = metrics.footnoteCount + metrics.externalLinks;
  if (citationCount >= 6) score += 3;
  else if (citationCount >= 3) score += 2;
  else if (citationCount >= 1) score += 1;
  if (metrics.bulletRatio < 0.3) score += 2;
  else if (metrics.bulletRatio < 0.5) score += 1;
  if (metrics.hasOverview) score += 1;
  return score;
}

/** Table scoring — rewards data richness, not prose volume */
function calculateTableScore(metrics: ContentMetrics): number {
  let score = 0;
  if (metrics.tableCount >= 3) score += 5;
  else if (metrics.tableCount >= 2) score += 4;
  else if (metrics.tableCount >= 1) score += 3;
  if (metrics.wordCount >= 400) score += 2;
  else if (metrics.wordCount >= 100) score += 1;
  if (metrics.internalLinks >= 4) score += 2;
  else if (metrics.internalLinks >= 1) score += 1;
  const citations = metrics.footnoteCount + metrics.externalLinks;
  if (citations >= 3) score += 2;
  else if (citations >= 1) score += 1;
  const sections = metrics.sectionCount.total;
  if (sections >= 3) score += 2;
  else if (sections >= 1) score += 1;
  if (metrics.hasOverview) score += 1;
  if (metrics.diagramCount >= 1) score += 1;
  return Math.min(15, score);
}

/** Diagram scoring — rewards visualizations and explanatory text */
function calculateDiagramScore(metrics: ContentMetrics): number {
  let score = 0;
  if (metrics.diagramCount >= 3) score += 5;
  else if (metrics.diagramCount >= 2) score += 4;
  else if (metrics.diagramCount >= 1) score += 3;
  if (metrics.wordCount >= 400) score += 2;
  else if (metrics.wordCount >= 100) score += 1;
  if (metrics.internalLinks >= 4) score += 2;
  else if (metrics.internalLinks >= 1) score += 1;
  const citations = metrics.footnoteCount + metrics.externalLinks;
  if (citations >= 3) score += 2;
  else if (citations >= 1) score += 1;
  const sections = metrics.sectionCount.total;
  if (sections >= 3) score += 2;
  else if (sections >= 1) score += 1;
  if (metrics.hasOverview) score += 1;
  if (metrics.tableCount >= 1) score += 1;
  return Math.min(15, score);
}

/** Index/dashboard scoring — rewards navigation structure and links */
function calculateIndexScore(metrics: ContentMetrics): number {
  let score = 0;
  if (metrics.internalLinks >= 20) score += 5;
  else if (metrics.internalLinks >= 10) score += 4;
  else if (metrics.internalLinks >= 5) score += 3;
  else if (metrics.internalLinks >= 1) score += 1;
  const sections = metrics.sectionCount.total;
  if (sections >= 6) score += 3;
  else if (sections >= 3) score += 2;
  else if (sections >= 1) score += 1;
  if (metrics.wordCount >= 200) score += 2;
  else if (metrics.wordCount >= 50) score += 1;
  if (metrics.tableCount >= 2) score += 2;
  else if (metrics.tableCount >= 1) score += 1;
  if (metrics.diagramCount >= 1) score += 2;
  if (metrics.hasOverview) score += 1;
  return Math.min(15, score);
}

/**
 * Suggest quality rating based on structural score and frontmatter.
 *
 * Mapping: structural score 0-15 → quality 0-100.
 * Index/dashboard pages return 0 (not graded).
 * Stub pages are capped at 35.
 */
export function suggestQuality(structuralScore: number, frontmatter: Record<string, unknown> = {}): number {
  // Non-graded formats return 0 — they don't participate in quality assessment
  const format = (frontmatter.contentFormat as string) || 'article';
  if (format === 'index' || format === 'dashboard') {
    return 0;
  }

  // Linear mapping: score 0 → quality 0, score 15 → quality 100
  let quality = Math.round((structuralScore / 15) * 100);

  // Cap stub pages at 35 - they're explicitly marked as minimal placeholders
  if (frontmatter.pageType === 'stub') {
    quality = Math.min(quality, 35);
  }

  // Clamp to 0-100
  return Math.min(100, Math.max(0, quality));
}

/**
 * Get quality discrepancy between current and suggested
 */
export function getQualityDiscrepancy(currentQuality: number, structuralScore: number): QualityDiscrepancy {
  const suggested = suggestQuality(structuralScore);
  const discrepancy = currentQuality - suggested;

  return {
    current: currentQuality,
    suggested,
    discrepancy,
    // 20+ points is a full tier difference
    flag: Math.abs(discrepancy) >= 20 ? 'large' : Math.abs(discrepancy) >= 10 ? 'minor' : 'ok',
  };
}
