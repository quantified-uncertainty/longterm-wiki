/**
 * Generate LLM Accessibility Files
 *
 * Generates llms.txt, llms-core.txt, and llms-full.txt from existing page data.
 * These files help LLMs discover and understand site content.
 *
 * Run automatically as part of build-data.mjs, or standalone:
 *   node scripts/generate-llm-files.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

// Configuration
const CONFIG = {
  // Minimum reader importance score for inclusion in core docs
  coreReaderImportanceThreshold: 60,
  // Target token count for core docs (approximate, 1 token ≈ 4 chars)
  coreTargetTokens: 30000,
  // Site metadata
  site: {
    name: 'LongtermWiki',
    url: 'https://www.longtermwiki.com',
    description:
      'A comprehensive knowledge base for AI safety research, covering risks, responses, organizations, and the AI transition model.',
  },
  // Categories to organize content (matched against page.category field)
  categories: [
    { key: 'risks', label: 'AI Risks' },
    { key: 'responses', label: 'Responses & Alignment' },
    { key: 'capabilities', label: 'Capabilities' },
    { key: 'organizations', label: 'Organizations' },
    { key: 'people', label: 'People' },
    { key: 'funders', label: 'Funders' },
    { key: 'concepts', label: 'Concepts' },
    { key: 'forecasting', label: 'Forecasting' },
    { key: 'ai-transition-model', label: 'AI Transition Model' },
    { key: 'analysis', label: 'Analysis' },
  ],
};

import { CONTENT_DIR as LONGTERM_CONTENT_DIR, OUTPUT_DIR as LOCAL_OUTPUT_DIR, PROJECT_ROOT, DATA_DIR as YAML_DATA_DIR } from './lib/content-types.mjs';

const DATA_DIR = LOCAL_OUTPUT_DIR;  // Read generated pages.json from local output
const CONTENT_DIR = LONGTERM_CONTENT_DIR;  // Read MDX from longterm
const OUTPUT_DIR = join(PROJECT_ROOT, 'public');

/**
 * Load ID registry from database.json to map page slugs to numeric IDs (E1, E2, ...)
 */
function loadIdRegistry() {
  const dbPath = join(DATA_DIR, 'database.json');
  if (!existsSync(dbPath)) {
    return {};
  }
  const db = JSON.parse(readFileSync(dbPath, 'utf-8'));
  // database.json has idRegistry.bySlug (slug → E##)
  return db.idRegistry?.bySlug || {};
}

// Loaded once and reused across all generators
let _slugToNumericId = null;

function getSlugToNumericId() {
  if (!_slugToNumericId) {
    _slugToNumericId = loadIdRegistry();
  }
  return _slugToNumericId;
}

/**
 * Get the canonical URL for a page (using /wiki/E{n} numeric IDs)
 */
function getPageUrl(page) {
  const map = getSlugToNumericId();
  const numericId = map[page.id];
  const wikiPath = numericId ? `/wiki/${numericId}` : `/wiki/${page.id}`;
  return `${CONFIG.site.url}${wikiPath}`;
}

/**
 * Load pages.json data
 */
function loadPages() {
  const pagesPath = join(DATA_DIR, 'pages.json');
  if (!existsSync(pagesPath)) {
    throw new Error('pages.json not found. Run build-data.mjs first.');
  }
  return JSON.parse(readFileSync(pagesPath, 'utf-8'));
}

/**
 * Extract content from MDX file, stripping frontmatter and imports
 */
function extractContent(filePath) {
  const fullPath = join(CONTENT_DIR, filePath);
  if (!existsSync(fullPath)) {
    return null;
  }

  let content = readFileSync(fullPath, 'utf-8');

  // Remove frontmatter (between --- markers)
  content = content.replace(/^---\n[\s\S]*?\n---\n/, '');

  // Remove import statements
  content = content.replace(/^import\s+.*?;\n/gm, '');
  content = content.replace(/^import\s+{[\s\S]*?}\s+from\s+['"].*?['"];\n/gm, '');

  // Remove JSX component tags that don't render as text
  // Keep content inside tags where possible
  content = content.replace(/<DataInfoBox[^>]*\/>/g, '');
  content = content.replace(/<DataExternalLinks[^>]*\/>/g, '');
  content = content.replace(/<Backlinks[^>]*\/>/g, '');

  // Remove multi-line JSX components (Mermaid diagrams, etc.)
  // Match <Component ...> ... </Component> across multiple lines
  content = content.replace(/<Mermaid[\s\S]*?\/>/g, '[Diagram]');
  content = content.replace(/<(Mermaid|Tabs|TabItem|Card|Accordion)[^>]*>[\s\S]*?<\/\1>/g, '');

  // Convert EntityLink to plain text: <EntityLink id="foo">text</EntityLink> -> text
  content = content.replace(/<EntityLink[^>]*>([^<]*)<\/EntityLink>/g, '$1');

  // Convert R (resource) links to plain text
  content = content.replace(/<R[^>]*>([^<]*)<\/R>/g, '$1');

  // Remove self-closing component tags
  content = content.replace(/<[A-Z][a-zA-Z]*[^>]*\/>/g, '');

  // Clean up extra whitespace
  content = content.replace(/\n{3,}/g, '\n\n');
  content = content.trim();

  return content;
}

/**
 * Estimate token count (rough: 1 token ≈ 4 characters)
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Get current date in ISO format
 */
function getDate() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get version from package.json
 */
function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    return pkg.version || '0.0.1';
  } catch {
    return '0.0.1';
  }
}

/**
 * Categorize pages by their category field
 */
function categorizePages(pages) {
  const categorized = {};

  for (const cat of CONFIG.categories) {
    categorized[cat.key] = [];
  }
  categorized['other'] = [];

  const categoryKeys = new Set(CONFIG.categories.map((c) => c.key));

  for (const page of pages) {
    if (page.category && categoryKeys.has(page.category)) {
      categorized[page.category].push(page);
    } else {
      categorized['other'].push(page);
    }
  }

  return categorized;
}

/**
 * Generate llms.txt - Site index and navigation
 */
function generateLlmsTxt(pages) {
  const categorized = categorizePages(pages);
  const version = getVersion();
  const date = getDate();

  let content = `# ${CONFIG.site.name}

> Version: ${version} | Generated: ${date}
>
> ${CONFIG.site.description}

This file provides an index of site content for LLMs. For full documentation, see: ${CONFIG.site.url}

## LLM Context Files

- [Core Documentation (llms-core.txt)](${CONFIG.site.url}/llms-core.txt): High reader-importance pages (~30K tokens) - fits in chat context
- [Full Documentation (llms-full.txt)](${CONFIG.site.url}/llms-full.txt): Complete content - for embeddings/RAG
- [Sitemap](${CONFIG.site.url}/sitemap.xml): XML sitemap of all pages
- Per-page plain text: append \`.txt\` to any wiki URL (e.g. ${CONFIG.site.url}/wiki/E1.txt)

## Site Structure

`;

  // Add each category with top pages
  for (const cat of CONFIG.categories) {
    const catPages = categorized[cat.key];
    if (catPages.length === 0) continue;

    // Sort by reader importance, take top 10
    const topPages = catPages
      .filter((p) => p.readerImportance !== null)
      .sort((a, b) => (b.readerImportance || 0) - (a.readerImportance || 0))
      .slice(0, 10);

    if (topPages.length === 0) continue;

    content += `### ${cat.label}\n\n`;
    for (const page of topPages) {
      const importance = page.readerImportance ? ` (reader importance: ${page.readerImportance})` : '';
      content += `- [${page.title}](${getPageUrl(page)})${importance}\n`;
    }
    content += '\n';
  }

  // Summary stats
  const totalPages = pages.length;
  const pagesWithSummary = pages.filter((p) => p.llmSummary).length;
  const highImportance = pages.filter((p) => p.readerImportance >= CONFIG.coreReaderImportanceThreshold).length;

  content += `## Statistics

- Total pages: ${totalPages}
- Pages with LLM summaries: ${pagesWithSummary}
- High reader-importance pages (≥${CONFIG.coreReaderImportanceThreshold}): ${highImportance}

## Usage Notes

- Each page has an \`llmSummary\` field optimized for LLM consumption
- Pages are rated by \`readerImportance\` (0-100) and \`quality\` (0-100)
- Pages include \`hallucinationRisk\` (level: low/medium/high, score: 0-100, factors[])
- All content is AI-generated; higher risk scores indicate pages more likely to contain hallucinations
- Verification priority = readerImportance × hallucinationRisk.score / 100
- Risk factors include: biographical-claims, no-citations, low-citation-density, specific-factual-claims, low-rigor-score
- Machine-readable risk data is available in pages.json for automated triage
- Use llms-core.txt for quick context, llms-full.txt for comprehensive knowledge
`;

  return content;
}

/**
 * Generate llms-core.txt - High reader-importance pages with summaries
 */
function generateLlmsCoreTxt(pages) {
  const version = getVersion();
  const date = getDate();

  // Filter to high reader-importance pages with summaries
  const corePagesRaw = pages
    .filter((p) => p.readerImportance >= CONFIG.coreReaderImportanceThreshold && p.llmSummary)
    .sort((a, b) => (b.readerImportance || 0) - (a.readerImportance || 0));

  // Build content, respecting token budget
  let content = `# ${CONFIG.site.name} - Core Documentation

> Version: ${version} | Generated: ${date}
>
> High reader-importance pages for understanding AI safety research.
> For complete documentation, see: ${CONFIG.site.url}

================================================================================

`;

  let tokenCount = estimateTokens(content);
  const includedPages = [];

  for (const page of corePagesRaw) {
    const pageUrl = getPageUrl(page);
    const pageContent = `
------------------------------------------------------------
## ${page.title}
URL: ${pageUrl}
Reader Importance: ${page.readerImportance} | Quality: ${page.quality || 'unrated'} | Hallucination Risk: ${page.hallucinationRisk?.level || 'unknown'} (${page.hallucinationRisk?.score ?? '?'}/100)
------------------------------------------------------------

${page.llmSummary}

`;

    const pageTokens = estimateTokens(pageContent);
    if (tokenCount + pageTokens > CONFIG.coreTargetTokens) {
      break;
    }

    content += pageContent;
    tokenCount += pageTokens;
    includedPages.push(page);
  }

  // Add footer with stats
  content += `
================================================================================

## Index

${includedPages.map((p) => `- ${p.title}: ${getPageUrl(p)}`).join('\n')}

---
Generated: ${date} | Pages included: ${includedPages.length} | Estimated tokens: ~${Math.round(tokenCount / 1000)}K
`;

  return { content, pageCount: includedPages.length, tokenCount };
}

/**
 * Generate llms-full.txt - Complete documentation
 */
function generateLlmsFullTxt(pages) {
  const version = getVersion();
  const date = getDate();
  const categorized = categorizePages(pages);

  let content = `# ${CONFIG.site.name} - Full Documentation

> Version: ${version} | Generated: ${date}
>
> Complete content from ${CONFIG.site.name}.
> For web version, see: ${CONFIG.site.url}

================================================================================

`;

  let totalTokens = estimateTokens(content);
  let includedCount = 0;
  let skippedCount = 0;

  // Process each category
  for (const cat of CONFIG.categories) {
    const catPages = categorized[cat.key];
    if (catPages.length === 0) continue;

    // Sort by reader importance
    const sortedPages = catPages
      .filter((p) => p.readerImportance !== null)
      .sort((a, b) => (b.readerImportance || 0) - (a.readerImportance || 0));

    if (sortedPages.length === 0) continue;

    content += `\n${'='.repeat(80)}\n`;
    content += `# ${cat.label.toUpperCase()}\n`;
    content += `${'='.repeat(80)}\n\n`;

    for (const page of sortedPages) {
      const pageContent = extractContent(page.filePath);
      if (!pageContent) {
        skippedCount++;
        continue;
      }

      const pageUrl = getPageUrl(page);
      const header = `
------------------------------------------------------------
## ${page.title}
URL: ${pageUrl}
Reader Importance: ${page.readerImportance || 'unrated'} | Quality: ${page.quality || 'unrated'} | Hallucination Risk: ${page.hallucinationRisk?.level || 'unknown'} (${page.hallucinationRisk?.score ?? '?'}/100)
${page.llmSummary ? `Summary: ${page.llmSummary}` : ''}
------------------------------------------------------------

`;

      content += header + pageContent + '\n\n';
      totalTokens += estimateTokens(header + pageContent);
      includedCount++;
    }
  }

  // Add footer
  content += `
================================================================================

Generated: ${date}
Pages included: ${includedCount}
Pages skipped: ${skippedCount}
Estimated tokens: ~${Math.round(totalTokens / 1000)}K
`;

  return { content, pageCount: includedCount, tokenCount: totalTokens };
}

/**
 * Generate per-page .txt files for individual LLM access.
 * Writes one file per page to public/wiki/{numericId}.txt
 */
function generatePerPageTxt(pages) {
  const wikiDir = join(OUTPUT_DIR, 'wiki');

  // Clean stale .txt files before regenerating
  if (existsSync(wikiDir)) {
    for (const file of readdirSync(wikiDir)) {
      if (file.endsWith('.txt')) {
        unlinkSync(join(wikiDir, file));
      }
    }
  } else {
    mkdirSync(wikiDir, { recursive: true });
  }

  const map = getSlugToNumericId();
  let generated = 0;
  let skipped = 0;

  for (const page of pages) {
    const numericId = map[page.id];
    if (!numericId) {
      skipped++;
      continue;
    }

    const body = extractContent(page.filePath);
    if (!body) {
      skipped++;
      continue;
    }

    const risk = page.hallucinationRisk;
    const meta = [
      `# ${page.title}`,
      '',
      `URL: ${getPageUrl(page)}`,
      page.readerImportance != null ? `Reader Importance: ${page.readerImportance}` : null,
      page.quality != null ? `Quality: ${page.quality}` : null,
      risk ? `Hallucination Risk: ${risk.level} (${risk.score}/100)${risk.factors.length ? ' — ' + risk.factors.join(', ') : ''}` : null,
      page.llmSummary ? `Summary: ${page.llmSummary}` : null,
      '',
      '---',
      '',
    ].filter((line) => line !== null).join('\n');

    writeFileSync(join(wikiDir, `${numericId}.txt`), meta + body + '\n');
    generated++;
  }

  return { generated, skipped };
}

/**
 * Main function - generate all LLM files
 */
export function generateLLMFiles() {
  console.log('\nGenerating LLM accessibility files...');

  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Load page data
  const pages = loadPages();
  console.log(`  Loaded ${pages.length} pages`);

  // Generate llms.txt
  const llmsTxt = generateLlmsTxt(pages);
  writeFileSync(join(OUTPUT_DIR, 'llms.txt'), llmsTxt);
  console.log(`  ✓ llms.txt (site index)`);

  // Generate llms-core.txt
  const { content: coreTxt, pageCount: corePages, tokenCount: coreTokens } = generateLlmsCoreTxt(pages);
  writeFileSync(join(OUTPUT_DIR, 'llms-core.txt'), coreTxt);
  console.log(`  ✓ llms-core.txt (${corePages} pages, ~${Math.round(coreTokens / 1000)}K tokens)`);

  // Generate llms-full.txt
  const { content: fullTxt, pageCount: fullPages, tokenCount: fullTokens } = generateLlmsFullTxt(pages);
  writeFileSync(join(OUTPUT_DIR, 'llms-full.txt'), fullTxt);
  console.log(`  ✓ llms-full.txt (${fullPages} pages, ~${Math.round(fullTokens / 1000)}K tokens)`);

  // Generate per-page .txt files
  const { generated: perPageCount, skipped: perPageSkipped } = generatePerPageTxt(pages);
  console.log(`  ✓ wiki/*.txt (${perPageCount} pages, ${perPageSkipped} skipped)`);

  return {
    llmsTxt: { size: llmsTxt.length },
    llmsCore: { pages: corePages, tokens: coreTokens },
    llmsFull: { pages: fullPages, tokens: fullTokens },
    perPage: { generated: perPageCount, skipped: perPageSkipped },
  };
}

// Run standalone if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateLLMFiles();
}
