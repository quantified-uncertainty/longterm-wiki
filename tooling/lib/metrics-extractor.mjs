/**
 * Metrics Extractor Module
 *
 * Extracts structural quality metrics from MDX content.
 * Used by build-data.mjs to compute page quality scores.
 */

/**
 * Extract all structural metrics from MDX content
 * @param {string} content - Raw MDX file content
 * @param {string} filePath - File path for content-type detection
 * @returns {object} Metrics object
 */
export function extractMetrics(content, filePath = '') {
  // Remove frontmatter for analysis
  const bodyContent = content.replace(/^---\n[\s\S]*?\n---\n?/, '');

  // Remove import statements
  const contentNoImports = bodyContent.replace(/^import\s+.*$/gm, '');

  const metrics = {
    // Raw counts
    wordCount: countWords(contentNoImports),
    tableCount: countTables(contentNoImports),
    diagramCount: countDiagrams(contentNoImports),
    internalLinks: countInternalLinks(contentNoImports),
    externalLinks: countExternalLinks(contentNoImports),
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
  };

  // Calculate structural score
  metrics.structuralScore = calculateStructuralScore(metrics);
  metrics.structuralScoreNormalized = Math.round((metrics.structuralScore / 15) * 50);

  return metrics;
}

/**
 * Count words in content (excluding code blocks and JSX)
 */
export function countWords(content) {
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
 * Count markdown tables
 */
export function countTables(content) {
  // Match table rows (lines with | at start and end)
  const tableRowPattern = /^\|.+\|$/gm;
  const rows = content.match(tableRowPattern) || [];

  // Count separator rows to determine table count
  const separatorPattern = /^\|[\s-:|]+\|$/gm;
  const separators = content.match(separatorPattern) || [];

  return separators.length;
}

/**
 * Count Mermaid diagrams
 */
export function countDiagrams(content) {
  // Match Mermaid component usage
  const mermaidComponent = /<Mermaid[^>]*>/g;
  const componentMatches = content.match(mermaidComponent) || [];

  // Also match mermaid code blocks
  const mermaidCodeBlock = /```mermaid/g;
  const codeBlockMatches = content.match(mermaidCodeBlock) || [];

  return componentMatches.length + codeBlockMatches.length;
}

/**
 * Count internal links (links to other pages in the knowledge base)
 */
export function countInternalLinks(content) {
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
export function countExternalLinks(content) {
  // Match markdown links to external URLs
  const externalLinkPattern = /\]\(https?:\/\/[^)]+\)/g;
  const matches = content.match(externalLinkPattern) || [];
  return matches.length;
}

/**
 * Count h2 and h3 sections
 */
function countSections(content) {
  const h2Pattern = /^##\s+/gm;
  const h3Pattern = /^###\s+/gm;
  const h2s = content.match(h2Pattern) || [];
  const h3s = content.match(h3Pattern) || [];
  return { h2: h2s.length, h3: h3s.length, total: h2s.length + h3s.length };
}

/**
 * Count code blocks
 */
function countCodeBlocks(content) {
  const codeBlockPattern = /```[\s\S]*?```/g;
  const matches = content.match(codeBlockPattern) || [];
  return matches.length;
}

/**
 * Calculate ratio of content in bullet points (0-1)
 */
function calculateBulletRatio(content) {
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
function hasSection(content, pattern) {
  return pattern.test(content);
}

/**
 * Calculate structural score (0-15)
 * Based on countable/measurable aspects of content
 */
function calculateStructuralScore(metrics) {
  let score = 0;

  // Word count: 0-2 pts
  if (metrics.wordCount >= 800) score += 2;
  else if (metrics.wordCount >= 300) score += 1;

  // Tables: 0-3 pts
  if (metrics.tableCount >= 3) score += 3;
  else if (metrics.tableCount >= 2) score += 2;
  else if (metrics.tableCount >= 1) score += 1;

  // Diagrams: 0-2 pts
  if (metrics.diagramCount >= 2) score += 2;
  else if (metrics.diagramCount >= 1) score += 1;

  // Internal links: 0-2 pts
  if (metrics.internalLinks >= 4) score += 2;
  else if (metrics.internalLinks >= 1) score += 1;

  // External links/citations: 0-3 pts
  if (metrics.externalLinks >= 6) score += 3;
  else if (metrics.externalLinks >= 3) score += 2;
  else if (metrics.externalLinks >= 1) score += 1;

  // Bullet ratio (lower is better): 0-2 pts
  if (metrics.bulletRatio < 0.3) score += 2;
  else if (metrics.bulletRatio < 0.5) score += 1;

  // Has overview section: 0-1 pt
  if (metrics.hasOverview) score += 1;

  return score;
}

/**
 * Suggest quality rating based on structural score and frontmatter
 * @param {number} structuralScore - Raw structural score (0-15)
 * @param {object} frontmatter - Page frontmatter (optional)
 * @returns {number} Suggested quality rating (0-100)
 *
 * Mapping: structural score 0-15 → quality 0-100
 * - 12+ → 80+ (comprehensive)
 * - 9-11 → 60-79 (good)
 * - 6-8 → 40-59 (adequate)
 * - 3-5 → 20-39 (draft)
 * - 0-2 → 0-19 (stub)
 *
 * Adjustments:
 * - Stub pages: capped at 35 (explicitly marked as minimal)
 */
export function suggestQuality(structuralScore, frontmatter = {}) {
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
 * @returns {object} { current, suggested, discrepancy, flag }
 */
export function getQualityDiscrepancy(currentQuality, structuralScore) {
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
