#!/usr/bin/env node

/**
 * Page Creator - Cost-Optimized Pipeline
 *
 * Uses Perplexity for research (cheap, good at web search)
 * Uses Claude for synthesis and validation iteration
 *
 * Cost breakdown (standard tier):
 * - Research: ~$0.10 (12 Perplexity queries)
 * - SCRY search: Free
 * - Extraction: ~$0.50 (Gemini Flash)
 * - Synthesis: ~$2.00 (Claude Sonnet)
 * - Validation loop: ~$1.50 (Claude Code SDK, iterates until passing)
 * Total: ~$4-5 vs $10+ with all-Claude approach
 *
 * Usage:
 *   node tooling/content/page-creator.mjs "SecureBio" --tier standard
 *   node tooling/content/page-creator.mjs "Community Notes" --tier premium
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { batchResearch, generateResearchQueries, callOpenRouter, MODELS } from '../lib/openrouter.mjs';
import { checkSidebarCoverage } from '../lib/sidebar-utils.mjs';
import { sources, hashId, SOURCES_DIR } from '../lib/knowledge-db.mjs';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');
const TEMP_DIR = path.join(ROOT, '.claude/temp/page-creator');

// ============ Configuration ============

const TIERS = {
  budget: {
    name: 'Budget',
    estimatedCost: '$2-3',
    phases: ['canonical-links', 'research-perplexity', 'synthesize-fast', 'verify-sources', 'validate-loop', 'validate-full', 'grade'],
    description: 'Perplexity research + fast synthesis'
  },
  standard: {
    name: 'Standard',
    estimatedCost: '$4-6',
    phases: ['canonical-links', 'research-perplexity', 'register-sources', 'fetch-sources', 'research-scry', 'synthesize', 'verify-sources', 'validate-loop', 'review', 'validate-full', 'grade'],
    description: 'Full research + source fetching + Sonnet synthesis + validation loop'
  },
  premium: {
    name: 'Premium',
    estimatedCost: '$8-12',
    phases: ['canonical-links', 'research-perplexity-deep', 'register-sources', 'fetch-sources', 'research-scry', 'synthesize-quality', 'verify-sources', 'review', 'validate-loop', 'validate-full', 'grade'],
    description: 'Deep research + source fetching + quality synthesis + review'
  }
};

// Build-breaking validation rules (must all pass)
const CRITICAL_RULES = [
  'dollar-signs',
  'comparison-operators',
  'frontmatter-schema',
  'entitylink-ids',
  'internal-links',
  'fake-urls',
  'component-props',
  'citation-urls'
];

// Quality rules (should pass, but won't block)
const QUALITY_RULES = [
  'tilde-dollar',
  'markdown-lists',
  'consecutive-bold-labels',
  'placeholders',
  'vague-citations',
  'temporal-artifacts'
];

// ============ Duplicate Detection ============

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Calculate similarity ratio (0-1, where 1 is identical)
 */
function similarity(a, b) {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  const distance = levenshteinDistance(aLower, bLower);
  const maxLen = Math.max(aLower.length, bLower.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

/**
 * Normalize a string to a slug for comparison
 */
function toSlug(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Check if a page with similar name already exists
 * Returns { exists: boolean, matches: Array<{title, path, similarity}> }
 */
async function checkForExistingPage(topic) {
  const registryPath = path.join(ROOT, 'app/src/data/pathRegistry.json');
  const databasePath = path.join(ROOT, 'app/src/data/database.json');

  const matches = [];
  const topicSlug = toSlug(topic);
  const topicLower = topic.toLowerCase();

  // Check pathRegistry for slug matches
  if (fs.existsSync(registryPath)) {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    for (const [id, urlPath] of Object.entries(registry)) {
      if (id.startsWith('__index__')) continue;

      // Exact slug match
      if (id === topicSlug) {
        matches.push({ title: id, path: urlPath, similarity: 1.0, type: 'exact-id' });
        continue;
      }

      // Fuzzy slug match
      const sim = similarity(id, topicSlug);
      if (sim >= 0.7) {
        matches.push({ title: id, path: urlPath, similarity: sim, type: 'fuzzy-id' });
      }
    }
  }

  // Check database.json for title matches
  // database.json is { experts: [...], organizations: [...], ... }
  if (fs.existsSync(databasePath)) {
    const database = JSON.parse(fs.readFileSync(databasePath, 'utf-8'));
    // Flatten all entity arrays into one list
    const allEntities = Object.values(database).flat();

    for (const entity of allEntities) {
      // Skip resources (they don't have paths) - only check actual wiki entities
      if (!entity.path) continue;

      // Check both 'title' and 'name' fields (experts use 'name', others use 'title')
      const entityName = entity.title || entity.name;
      if (!entityName) continue;

      const entityNameLower = entityName.toLowerCase();

      // Exact title match
      if (entityNameLower === topicLower) {
        const existingMatch = matches.find(m => m.path === entity.path);
        if (!existingMatch) {
          matches.push({ title: entityName, path: entity.path, similarity: 1.0, type: 'exact-title' });
        }
        continue;
      }

      // Fuzzy title match
      const sim = similarity(entityName, topic);
      if (sim >= 0.7) {
        const existingMatch = matches.find(m => m.path === entity.path);
        if (!existingMatch) {
          matches.push({ title: entityName, path: entity.path, similarity: sim, type: 'fuzzy-title' });
        }
      }
    }
  }

  // Sort by similarity descending
  matches.sort((a, b) => b.similarity - a.similarity);

  return {
    exists: matches.some(m => m.similarity >= 0.9),
    matches: matches.slice(0, 5) // Return top 5 matches
  };
}

// ============ Deployment ============

/**
 * Move final.mdx to destination and check sidebar coverage
 */
/**
 * Create a new category directory with index.mdx
 * Note: Next.js auto-detects pages from the filesystem, so no sidebar config needed.
 */
function createCategoryDirectory(destPath, categoryLabel) {
  const fullDestDir = path.join(ROOT, 'content/docs', destPath);

  // Create directory
  ensureDir(fullDestDir);

  // Create index.mdx
  const indexPath = path.join(fullDestDir, 'index.mdx');
  if (!fs.existsSync(indexPath)) {
    const indexContent = `---
title: ${categoryLabel}
description: Overview of ${categoryLabel.toLowerCase()}.
sidebar:
  label: Overview
  order: 0
---

This section contains pages about ${categoryLabel.toLowerCase()}.
`;
    fs.writeFileSync(indexPath, indexContent);
    console.log(`✓ Created index.mdx for ${categoryLabel}`);
  } else {
    console.log(`  index.mdx already exists`);
  }

  return { success: true, created: true };
}

function deployToDestination(topic, destPath) {
  const topicDir = getTopicDir(topic);
  const finalPath = path.join(topicDir, 'final.mdx');

  if (!fs.existsSync(finalPath)) {
    return { success: false, error: 'No final.mdx found to deploy' };
  }

  // Full destination path
  const sanitizedTopic = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const fullDestDir = path.join(ROOT, 'content/docs', destPath);
  const fullDestPath = path.join(fullDestDir, `${sanitizedTopic}.mdx`);

  // Ensure destination directory exists
  ensureDir(fullDestDir);

  // Check sidebar coverage (uses shared utility)
  const sidebarCheck = checkSidebarCoverage(destPath);

  // Copy file to destination
  fs.copyFileSync(finalPath, fullDestPath);

  return {
    success: true,
    deployedTo: fullDestPath,
    sidebarCoverage: sidebarCheck
  };
}

// ============ Cross-Link Validation ============

/**
 * Check EntityLinks in a deployed file and warn about missing cross-links
 */
function validateCrossLinks(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Count outbound EntityLinks
  const entityLinkMatches = content.match(/<EntityLink\s+id="([^"]+)"/g) || [];
  const uniqueEntityLinks = new Set(
    entityLinkMatches.map(m => m.match(/id="([^"]+)"/)[1])
  );

  const result = {
    outboundCount: uniqueEntityLinks.size,
    outboundIds: [...uniqueEntityLinks],
    warnings: []
  };

  // Check for common missing patterns
  const contentLower = content.toLowerCase();

  // Check if "created by" or "developed by" exists without EntityLink nearby
  const creatorPatterns = [
    /created by\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/g,
    /developed by\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/g,
    /built by\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/g,
    /founded by\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/g,
  ];

  for (const pattern of creatorPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      // Check if this name appears in an EntityLink
      const nameSlug = name.toLowerCase().replace(/\s+/g, '-');
      if (!result.outboundIds.some(id => id.includes(nameSlug) || nameSlug.includes(id))) {
        result.warnings.push(`Possible unlinked creator: "${name}" - consider adding EntityLink if they exist in wiki`);
      }
    }
  }

  // Warn if no outbound links at all
  if (result.outboundCount === 0) {
    result.warnings.push('No outbound EntityLinks found - consider linking to related entities');
  } else if (result.outboundCount < 2) {
    result.warnings.push(`Only ${result.outboundCount} outbound EntityLink(s) - consider adding more cross-references`);
  }

  return result;
}

// ============ Utility Functions ============

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function log(phase, message) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${timestamp}] [${phase}] ${message}`);
}

function getTopicDir(topic) {
  const sanitized = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return path.join(TEMP_DIR, sanitized);
}

function saveResult(topic, filename, data) {
  const dir = getTopicDir(topic);
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  if (typeof data === 'string') {
    fs.writeFileSync(filePath, data);
  } else {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }
  return filePath;
}

function loadResult(topic, filename) {
  const filePath = path.join(getTopicDir(topic), filename);
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  if (filename.endsWith('.json')) {
    return JSON.parse(content);
  }
  return content;
}

// ============ Auto-Import Components ============

/**
 * Wiki components that need to be imported from @components/wiki
 */
const WIKI_COMPONENTS = [
  'EntityLink',
  'DataInfoBox',
  'InfoBox',
  'Backlinks',
  'Mermaid',
  'R',
  'DataExternalLinks',
  'EstimateBox',
  'QuoteBox',
  'Timeline',
  'ComparisonTable',
];

/**
 * Ensure all used wiki components are properly imported.
 * Call this after synthesis to fix missing imports before validation.
 */
function ensureComponentImports(filePath) {
  if (!fs.existsSync(filePath)) return { fixed: false, added: [] };

  const content = fs.readFileSync(filePath, 'utf-8');

  // Find used components (not in code blocks)
  const usedComponents = new Set();
  const componentRegex = /<([A-Z][a-zA-Z0-9]*)/g;
  let match;

  // Simple code block detection
  const codeBlockRanges = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    codeBlockRanges.push([match.index, match.index + match[0].length]);
  }

  const isInCodeBlock = (pos) => {
    return codeBlockRanges.some(([start, end]) => pos >= start && pos < end);
  };

  while ((match = componentRegex.exec(content)) !== null) {
    if (!isInCodeBlock(match.index)) {
      const componentName = match[1];
      if (WIKI_COMPONENTS.includes(componentName)) {
        usedComponents.add(componentName);
      }
    }
  }

  if (usedComponents.size === 0) {
    return { fixed: false, added: [] };
  }

  // Find what's already imported from @components/wiki
  const wikiImportRegex = /import\s*\{([^}]+)\}\s*from\s*['"]@components\/wiki['"]/;
  const wikiImportMatch = content.match(wikiImportRegex);
  const importedComponents = new Set();

  if (wikiImportMatch) {
    const importList = wikiImportMatch[1];
    importList.split(',').map(c => c.trim()).filter(Boolean).forEach(c => importedComponents.add(c));
  }

  // Also check for individual imports
  for (const comp of usedComponents) {
    const individualImportRegex = new RegExp(`import.*\\b${comp}\\b.*from`);
    if (individualImportRegex.test(content)) {
      importedComponents.add(comp);
    }
  }

  // Find missing imports
  const missing = [...usedComponents].filter(c => !importedComponents.has(c));

  if (missing.length === 0) {
    return { fixed: false, added: [] };
  }

  // Fix the imports
  let fixedContent = content;

  if (wikiImportMatch) {
    // Add to existing import
    const existingImports = wikiImportMatch[1].trim();
    const newImports = `${existingImports}, ${missing.join(', ')}`;
    const quoteChar = wikiImportMatch[0].includes("'") ? "'" : '"';
    fixedContent = content.replace(
      wikiImportRegex,
      `import {${newImports}} from ${quoteChar}@components/wiki${quoteChar}`
    );
  } else {
    // Add new import after frontmatter
    const importStatement = `import { ${missing.join(', ')} } from '@components/wiki';`;
    const lines = content.split('\n');

    // Find end of frontmatter
    let fmCount = 0;
    let insertIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '---') {
        fmCount++;
        if (fmCount === 2) {
          insertIdx = i + 1;
          break;
        }
      }
    }

    lines.splice(insertIdx, 0, importStatement);
    fixedContent = lines.join('\n');
  }

  fs.writeFileSync(filePath, fixedContent);
  return { fixed: true, added: missing };
}

// ============ Phase: Find Canonical Links ============

const CANONICAL_DOMAINS = [
  { domain: 'en.wikipedia.org', name: 'Wikipedia', priority: 1 },
  { domain: 'www.wikidata.org', name: 'Wikidata', priority: 2 },
  { domain: 'lesswrong.com', name: 'LessWrong', priority: 3 },
  { domain: 'forum.effectivealtruism.org', name: 'EA Forum', priority: 3 },
  { domain: 'www.britannica.com', name: 'Britannica', priority: 4 },
  { domain: 'arxiv.org', name: 'arXiv', priority: 5 },
  { domain: 'scholar.google.com', name: 'Google Scholar', priority: 5 },
  { domain: 'twitter.com', name: 'Twitter/X', priority: 6 },
  { domain: 'x.com', name: 'Twitter/X', priority: 6 },
  { domain: 'github.com', name: 'GitHub', priority: 6 },
  { domain: 'linkedin.com', name: 'LinkedIn', priority: 7 },
];

async function findCanonicalLinks(topic) {
  log('canonical', 'Searching for canonical reference links...');

  const { perplexityResearch } = await import('../lib/openrouter.mjs');

  // Search for canonical pages
  const searchQuery = `Find official and reference pages for "${topic}". Include:
- Wikipedia page URL (if exists)
- Wikidata ID and URL (if exists)
- LessWrong profile or wiki page (if exists)
- EA Forum profile or posts (if exists)
- Official website (if organization or person)
- Twitter/X profile (if exists)
- GitHub (if relevant)

For each, provide the exact URL. Only include links that actually exist.`;

  try {
    const result = await perplexityResearch(searchQuery, { maxTokens: 1500 });

    // Extract URLs from response
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    const foundUrls = (result.content.match(urlRegex) || []).map(url => {
      // Clean trailing punctuation
      return url.replace(/[.,;:!?]+$/, '').replace(/\)+$/, '');
    });

    // Also include citations from Perplexity
    const allUrls = [...new Set([...foundUrls, ...(result.citations || [])])];

    // Categorize by domain
    const canonicalLinks = [];
    const seenDomains = new Set();

    for (const url of allUrls) {
      try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.replace(/^www\./, '');

        // Check against known canonical domains
        for (const { domain, name, priority } of CANONICAL_DOMAINS) {
          const domainHost = domain.replace(/^www\./, '');
          if (hostname === domainHost || hostname.endsWith('.' + domainHost)) {
            if (!seenDomains.has(name)) {
              canonicalLinks.push({ name, url, priority, domain: hostname });
              seenDomains.add(name);
            }
            break;
          }
        }

        // Check for official/personal website (not a known platform)
        if (!seenDomains.has('Official Website') &&
            !CANONICAL_DOMAINS.some(d => hostname.includes(d.domain.replace(/^www\./, '')))) {
          // Heuristic: if it looks like a personal/org site
          if (hostname.split('.').length <= 3 && !hostname.includes('google') && !hostname.includes('bing')) {
            canonicalLinks.push({ name: 'Official Website', url, priority: 0, domain: hostname });
            seenDomains.add('Official Website');
          }
        }
      } catch (e) {
        // Invalid URL, skip
      }
    }

    // Sort by priority
    canonicalLinks.sort((a, b) => a.priority - b.priority);

    log('canonical', `Found ${canonicalLinks.length} canonical links`);
    canonicalLinks.forEach(link => {
      log('canonical', `  ${link.name}: ${link.url}`);
    });

    // Save results
    const data = {
      topic,
      links: canonicalLinks,
      rawContent: result.content,
      allFoundUrls: allUrls,
      timestamp: new Date().toISOString(),
    };
    saveResult(topic, 'canonical-links.json', data);

    return { success: true, links: canonicalLinks, cost: result.cost || 0 };
  } catch (error) {
    log('canonical', `Error finding canonical links: ${error.message}`);
    return { success: false, error: error.message, links: [] };
  }
}

// ============ Phase: Perplexity Research ============

async function runPerplexityResearch(topic, depth = 'standard') {
  log('research', `Starting Perplexity research (${depth})...`);

  // Generate queries based on depth
  let queries = generateResearchQueries(topic);

  if (depth === 'lite') {
    queries = queries.slice(0, 6); // Just core queries
  } else if (depth === 'deep') {
    // Add more specific queries
    queries.push(
      { query: `${topic} technical details methodology approach`, category: 'technical' },
      { query: `${topic} comparison alternatives competitors`, category: 'comparison' },
      { query: `${topic} future plans roadmap strategy`, category: 'future' },
      { query: `${topic} academic papers research publications citations`, category: 'academic' },
    );
  }

  log('research', `Running ${queries.length} Perplexity queries...`);

  const results = await batchResearch(queries, { concurrency: 3 });

  let totalCost = 0;
  const researchSources = [];

  for (const result of results) {
    totalCost += result.cost || 0;
    researchSources.push({
      category: result.category,
      query: result.query,
      content: result.content,
      citations: result.citations || [],  // Perplexity source URLs for [1], [2], etc.
      tokens: result.usage?.total_tokens || 0,
      cost: result.cost || 0,
    });
    log('research', `  ${result.category}: ${result.usage?.total_tokens || 0} tokens, $${(result.cost || 0).toFixed(4)}`);
  }

  log('research', `Total research cost: $${totalCost.toFixed(4)}`);

  // Save results
  const outputPath = saveResult(topic, 'perplexity-research.json', {
    topic,
    depth,
    queryCount: queries.length,
    totalCost,
    timestamp: new Date().toISOString(),
    sources: researchSources,
  });

  log('research', `Saved to ${outputPath}`);

  return { success: true, cost: totalCost, queryCount: queries.length };
}

// ============ Phase: Register Sources ============

/**
 * Extract citation URLs from Perplexity research and register them in the knowledge DB
 */
async function registerResearchSources(topic) {
  log('register-sources', 'Extracting and registering citation URLs...');

  const researchPath = path.join(getTopicDir(topic), 'perplexity-research.json');
  if (!fs.existsSync(researchPath)) {
    log('register-sources', 'No Perplexity research found, skipping');
    return { success: false, error: 'No research data' };
  }

  const research = JSON.parse(fs.readFileSync(researchPath, 'utf-8'));
  const allUrls = new Set();

  // Extract citation URLs from all research responses
  for (const source of (research.sources || [])) {
    if (source.citations && Array.isArray(source.citations)) {
      for (const url of source.citations) {
        if (url && typeof url === 'string' && url.startsWith('http')) {
          allUrls.add(url);
        }
      }
    }
  }

  log('register-sources', `Found ${allUrls.size} unique citation URLs`);

  const registered = [];
  const existing = [];

  for (const url of allUrls) {
    try {
      // Check if already in database
      const existingSource = sources.getByUrl(url);
      if (existingSource) {
        existing.push(url);
        continue;
      }

      // Determine source type from URL
      let sourceType = 'web';
      if (url.includes('arxiv.org')) sourceType = 'paper';
      else if (url.includes('scholar.google')) sourceType = 'paper';
      else if (url.includes('lesswrong.com')) sourceType = 'blog';
      else if (url.includes('forum.effectivealtruism.org')) sourceType = 'blog';
      else if (url.includes('substack.com')) sourceType = 'blog';
      else if (url.includes('medium.com')) sourceType = 'blog';

      // Register in database
      const id = hashId(url);
      sources.upsert({
        id,
        url,
        title: null, // Will be extracted during fetch
        sourceType,
      });

      registered.push(url);
    } catch (error) {
      log('register-sources', `  Failed to register ${url}: ${error.message}`);
    }
  }

  log('register-sources', `Registered ${registered.length} new sources, ${existing.length} already existed`);

  // Save registration results
  saveResult(topic, 'registered-sources.json', {
    topic,
    totalUrls: allUrls.size,
    registered: registered.length,
    existing: existing.length,
    urls: [...allUrls],
    timestamp: new Date().toISOString(),
  });

  return { success: true, registered: registered.length, existing: existing.length, total: allUrls.size };
}

// ============ Phase: Fetch Sources ============

/**
 * Fetch content from registered sources using Firecrawl
 * Rate limited to avoid API limits (7s between requests)
 */
async function fetchRegisteredSources(topic, options = {}) {
  const { maxSources = 10, skipExisting = true } = options;

  log('fetch-sources', 'Fetching source content with Firecrawl...');

  // Check for Firecrawl API key
  const FIRECRAWL_KEY = process.env.FIRECRAWL_KEY;
  if (!FIRECRAWL_KEY) {
    log('fetch-sources', '⚠️  FIRECRAWL_KEY not set - skipping source fetching');
    log('fetch-sources', '   Add FIRECRAWL_KEY to .env to enable content fetching');
    return { success: false, error: 'No API key', fetched: 0 };
  }

  // Load registered sources for this topic
  const registeredPath = path.join(getTopicDir(topic), 'registered-sources.json');
  if (!fs.existsSync(registeredPath)) {
    log('fetch-sources', 'No registered sources found');
    return { success: false, error: 'No registered sources' };
  }

  const registration = JSON.parse(fs.readFileSync(registeredPath, 'utf-8'));
  const urlsToFetch = [];

  // Filter to sources that need fetching
  for (const url of registration.urls) {
    const source = sources.getByUrl(url);
    if (!source) continue;

    if (skipExisting && source.fetch_status === 'fetched' && source.content) {
      continue; // Already fetched
    }

    urlsToFetch.push({ id: source.id, url });
    if (urlsToFetch.length >= maxSources) break;
  }

  if (urlsToFetch.length === 0) {
    log('fetch-sources', 'All sources already fetched');
    return { success: true, fetched: 0, skipped: registration.urls.length };
  }

  log('fetch-sources', `Fetching ${urlsToFetch.length} sources (max ${maxSources})...`);

  // Initialize Firecrawl
  const FirecrawlApp = (await import('@mendable/firecrawl-js')).default;
  const firecrawl = new FirecrawlApp({ apiKey: FIRECRAWL_KEY });

  let fetched = 0;
  let failed = 0;
  const DELAY_MS = 7000; // 7 seconds between requests (Firecrawl rate limit)

  for (let i = 0; i < urlsToFetch.length; i++) {
    const { id, url } = urlsToFetch[i];

    try {
      log('fetch-sources', `  [${i + 1}/${urlsToFetch.length}] Fetching: ${url.slice(0, 60)}...`);

      const result = await firecrawl.scrape(url, {
        formats: ['markdown'],
      });

      if (result.markdown) {
        // Save content to database
        const cacheFile = `${id}.txt`;
        sources.markFetched(id, result.markdown, cacheFile);

        // Also save to cache file for backup
        const cachePath = path.join(SOURCES_DIR, `${id}.txt`);
        fs.writeFileSync(cachePath, result.markdown);

        // Update metadata if available
        const metadata = result.metadata || {};
        if (metadata.publishedTime) {
          sources.updateMetadata(id, {
            year: new Date(metadata.publishedTime).getFullYear(),
          });
        }

        log('fetch-sources', `     ✓ ${result.markdown.length.toLocaleString()} chars`);
        fetched++;
      } else {
        throw new Error('No markdown content returned');
      }
    } catch (error) {
      log('fetch-sources', `     ✗ ${error.message}`);
      sources.markFailed(id, error.message);
      failed++;
    }

    // Rate limit delay (except for last item)
    if (i < urlsToFetch.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  log('fetch-sources', `Fetched ${fetched} sources, ${failed} failed`);

  // Save fetch results
  saveResult(topic, 'fetch-results.json', {
    topic,
    fetched,
    failed,
    total: urlsToFetch.length,
    timestamp: new Date().toISOString(),
  });

  return { success: true, fetched, failed };
}

/**
 * Get fetched content for quote verification
 * Returns combined content from all fetched sources for this topic
 */
function getFetchedSourceContent(topic) {
  const registeredPath = path.join(getTopicDir(topic), 'registered-sources.json');
  if (!fs.existsSync(registeredPath)) {
    return null;
  }

  const registration = JSON.parse(fs.readFileSync(registeredPath, 'utf-8'));
  const contents = [];

  for (const url of registration.urls) {
    const source = sources.getByUrl(url);
    if (source?.content) {
      contents.push({
        url,
        content: source.content,
      });
    }
  }

  if (contents.length === 0) {
    return null;
  }

  return {
    sourceCount: contents.length,
    combinedContent: contents.map(c => c.content).join('\n\n---\n\n'),
    sources: contents.map(c => ({ url: c.url, length: c.content.length })),
  };
}

// ============ Phase: SCRY Research ============

async function runScryResearch(topic) {
  log('scry', 'Searching SCRY (EA Forum, LessWrong)...');

  const SCRY_PUBLIC_KEY = 'exopriors_public_readonly_v1_2025';

  const searches = [
    { table: 'mv_eaforum_posts', query: topic },
    { table: 'mv_lesswrong_posts', query: topic },
    { table: 'mv_eaforum_posts', query: `${topic} criticism` },
  ];

  const results = [];

  for (const search of searches) {
    try {
      const sql = `SELECT title, uri, snippet, original_author, original_timestamp::date as date
        FROM scry.search('${search.query.replace(/'/g, "''")}', '${search.table}')
        WHERE title IS NOT NULL AND kind = 'post'
        LIMIT 10`;

      const response = await fetch('https://api.exopriors.com/v1/scry/query', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SCRY_PUBLIC_KEY}`,
          'Content-Type': 'text/plain',
        },
        body: sql,
      });

      const data = await response.json();

      if (data.rows) {
        const platform = search.table.includes('eaforum') ? 'EA Forum' : 'LessWrong';
        log('scry', `  ${platform} "${search.query}": ${data.rows.length} results`);
        results.push(...data.rows.map(row => ({
          ...row,
          platform,
          searchQuery: search.query,
        })));
      }
    } catch (error) {
      log('scry', `  Error searching ${search.table}: ${error.message}`);
    }
  }

  // Deduplicate by URI
  const seen = new Set();
  const unique = results.filter(r => {
    if (seen.has(r.uri)) return false;
    seen.add(r.uri);
    return true;
  });

  saveResult(topic, 'scry-research.json', {
    topic,
    resultCount: unique.length,
    timestamp: new Date().toISOString(),
    results: unique,
  });

  log('scry', `Found ${unique.length} unique community posts`);

  return { success: true, resultCount: unique.length };
}

// ============ Phase: Process Directions ============

/**
 * Extract URLs from directions text and fetch their content
 */
/**
 * Extract URLs from text with cleanup for trailing punctuation
 */
function extractUrls(text) {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  const rawMatches = text.match(urlRegex) || [];

  return rawMatches.map(url => {
    let cleaned = url;

    // Strip trailing punctuation (but not / or alphanumeric)
    cleaned = cleaned.replace(/[.,;:!?]+$/, '');

    // Handle unbalanced parentheses - strip trailing ) if more ) than (
    const openParens = (cleaned.match(/\(/g) || []).length;
    const closeParens = (cleaned.match(/\)/g) || []).length;
    if (closeParens > openParens) {
      const excess = closeParens - openParens;
      for (let i = 0; i < excess; i++) {
        cleaned = cleaned.replace(/\)$/, '');
      }
    }

    return cleaned;
  });
}

async function processDirections(topic, directions) {
  if (!directions) return { success: true, hasDirections: false };

  log('directions', 'Processing user directions...');

  // Extract URLs from the directions text
  const urls = extractUrls(directions);

  log('directions', `Found ${urls.length} URL(s) in directions`);

  const fetchedContent = [];

  for (const url of urls) {
    try {
      log('directions', `Fetching: ${url}`);
      const response = await fetch(url);

      if (!response.ok) {
        log('directions', `  ⚠ Failed to fetch (${response.status})`);
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      let content = '';

      if (contentType.includes('application/pdf')) {
        // Handle PDF files
        try {
          const pdfParse = (await import('pdf-parse')).default;
          const buffer = await response.arrayBuffer();
          const pdfData = await pdfParse(Buffer.from(buffer));
          content = pdfData.text
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 15000);
          log('directions', `  ✓ Parsed PDF: ${content.length} chars`);
        } catch (pdfError) {
          log('directions', `  ⚠ PDF parse failed: ${pdfError.message}`);
          continue;
        }
      } else {
        // Handle HTML
        const html = await response.text();

        // Simple HTML to text conversion - strip tags, decode entities
        content = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 15000); // Limit content size
      }

      if (content.length > 100) {
        fetchedContent.push({
          url,
          content,
          charCount: content.length
        });
        log('directions', `  ✓ Fetched ${content.length} chars`);
      }
    } catch (error) {
      log('directions', `  ⚠ Error fetching ${url}: ${error.message}`);
    }
  }

  // Save directions and fetched content
  const directionsData = {
    originalDirections: directions,
    extractedUrls: urls,
    fetchedContent,
    timestamp: new Date().toISOString()
  };

  saveResult(topic, 'directions.json', directionsData);
  log('directions', `Saved directions with ${fetchedContent.length} fetched URL(s)`);

  return { success: true, hasDirections: true, urlCount: urls.length, fetchedCount: fetchedContent.length };
}

// ============ Phase: Synthesis ============

function getSynthesisPrompt(topic, quality = 'standard') {
  const researchData = loadResult(topic, 'perplexity-research.json');
  const scryData = loadResult(topic, 'scry-research.json');
  const directionsData = loadResult(topic, 'directions.json');
  const canonicalLinksData = loadResult(topic, 'canonical-links.json');

  // Format canonical links for display
  let canonicalLinksSection = '';
  if (canonicalLinksData?.links?.length > 0) {
    const linksTable = canonicalLinksData.links
      .map(link => `| ${link.name} | [${link.domain || 'Link'}](${link.url}) |`)
      .join('\n');
    canonicalLinksSection = `## Canonical Links Found

**IMPORTANT: Include this table near the top of the article (after Quick Assessment):**

| Source | Link |
|--------|------|
${linksTable}

`;
  }

  // Count total available citation URLs
  let totalCitations = 0;

  // Format research with citation URLs included
  const researchContent = researchData?.sources?.map(s => {
    let section = `### ${s.category.toUpperCase()}\n${s.content}`;
    // If we have citation URLs, append them so the writer can use real links
    if (s.citations && s.citations.length > 0) {
      totalCitations += s.citations.length;
      section += `\n\n**Source URLs for [1], [2], etc. citations above:**\n${s.citations.map((url, i) => `[${i + 1}]: ${url}`).join('\n')}`;
    } else {
      section += `\n\n**WARNING: No source URLs available for this section. Do not invent URLs.**`;
    }
    return section;
  }).join('\n\n') || 'No Perplexity research available';

  const scryContent = scryData?.results?.slice(0, 10).map(r =>
    `- [${r.title}](${r.uri}) by ${r.original_author} (${r.platform})\n  ${r.snippet?.slice(0, 200) || ''}`
  ).join('\n') || 'No SCRY results available';

  // Add citation availability warning
  const citationWarning = totalCitations > 0
    ? `✅ ${totalCitations} source URLs available in research data - USE THESE for citations`
    : `⚠️ NO SOURCE URLs available in research data - use descriptive citations only, NO FAKE URLs`;

  // Format user directions and fetched URL content
  let directionsSection = '';
  if (directionsData) {
    const parts = [];

    if (directionsData.originalDirections) {
      parts.push(`### User Instructions\n${directionsData.originalDirections}`);
    }

    if (directionsData.fetchedContent && directionsData.fetchedContent.length > 0) {
      const fetchedParts = directionsData.fetchedContent.map(fc =>
        `#### Content from ${fc.url}\n${fc.content.slice(0, 8000)}`
      );
      parts.push(`### Content from User-Provided URLs\n${fetchedParts.join('\n\n')}`);
    }

    if (parts.length > 0) {
      directionsSection = `## User-Provided Directions\n\n**IMPORTANT: Follow these directions carefully. They take precedence over default instructions.**\n\n${parts.join('\n\n')}`;
    }
  }

  return `# Write Wiki Article: ${topic}

You are writing a wiki article for LongtermWiki, an AI safety knowledge base.

## Research Data

### WEB RESEARCH (from Perplexity)
${researchContent}

### COMMUNITY DISCUSSIONS (from EA Forum/LessWrong)
${scryContent}

## Citation Status
${citationWarning}

${directionsSection}

${canonicalLinksSection}
## Requirements

1. **CRITICAL: Use ONLY real URLs from the research data**
   - Format: claim[^1] with [^1]: [Source Title](actual-url) at bottom
   - Look for "Source URLs for [1], [2]" sections in the research data
   - NEVER invent URLs like "example.com", "/posts/example", or "undefined"
   - NEVER make up plausible-looking URLs - if you don't have a real URL, use text-only citation
   - If no URL available: [^1]: Source name - description (no link)
   - **NEVER use vague citations** like "Interview", "Earnings call", "Conference talk", "Reports"
   - Always specify: exact name, date, and context (e.g., "Tesla Q4 2021 earnings call", "MIT Aeronautics Centennial Symposium (Oct 2014)")
2. **CRITICAL: NEVER invent quotes**
   - Only use EXACT text from the research data when using quotation marks
   - If you want to attribute a view to someone, paraphrase WITHOUT quotation marks
   - BAD: Ben Pace wrote "this is problematic because..." (if not verbatim in research)
   - GOOD: Ben Pace argued this approach was problematic (paraphrase without quotes)
   - GOOD: According to the post, "exact text from research" (verbatim quote)
   - When attributing quotes to specific people, the quote MUST appear in the research data
   - This is especially important for EA/rationalist community members whose names you may recognize
3. **Escape dollar signs** - Write \\$100M not $100M
4. **Use EntityLink for internal refs** - <EntityLink id="open-philanthropy">Open Philanthropy</EntityLink>
5. **Include criticism section** if research supports it
6. **60%+ prose** - Not just tables and bullet points
7. **Limited info fallback** - If research is sparse, write a shorter article rather than padding with filler
8. **Present information as current** - NEVER write "as of the research data" or "through late 2024"
   - BAD: "As of the research data (through late 2024), no ratifications..."
   - GOOD: "As of early 2026, the convention remains in..." or just "No ratifications have been reported"
   - Don't reference when sources were gathered - present facts as current knowledge
9. **Maintain logical consistency** - Ensure claims within each section align with the section's thesis
   - If a section is titled "Lack of X", don't describe the subject as having X
   - If discussing limitations, don't use quotes that suggest the opposite
10. **Maintain critical distance** - Don't take sources at face value
   - Use attribution phrases: "According to X...", "X claims that...", "X characterized this as..."
   - Consider source incentives: companies may overstate their achievements, critics may overstate problems
   - Include skeptical perspectives even if research is mostly positive or negative
   - For controversial claims, note that significance/interpretation is debated

## EntityLink Usage - CRITICAL

**Format**: \`<EntityLink id="entity-id">Display Text</EntityLink>\`

**IMPORTANT**:
- IDs are simple slugs like "open-philanthropy", NOT paths like "organizations/funders/open-philanthropy"
- ONLY use EntityLinks for entities that exist in the wiki
- If unsure whether an entity exists, use plain text instead of guessing an ID
- NEVER invent EntityLink IDs - if you're not certain, don't use EntityLink

**PRIORITY CROSS-LINKING** (most important):
- **Creators/Authors**: If the subject was created by someone in the wiki, ALWAYS EntityLink them
  - Example: For a tool page, link to its creator: "created by <EntityLink id="vipul-naik">Vipul Naik</EntityLink>"
  - Example: For a research project, link to the lead researcher
- **Related Projects**: Link to sibling projects by the same creator
  - Example: "part of an ecosystem including <EntityLink id="timelines-wiki">Timelines Wiki</EntityLink>"
- **Funders/Organizations**: Link to funding sources and affiliated organizations
- **Key People**: Link to researchers, founders, and notable figures mentioned substantively

**Common valid IDs** (partial list - use plain text if entity not listed):
open-philanthropy, anthropic, openai, deepmind, miri, lesswrong, redwood-research,
eliezer-yudkowsky, paul-christiano, dario-amodei, scheming, misuse-risks, cea,
80000-hours, arc-evals, metr, epoch-ai, fhi, cais, sff, ltff, fli,
vipul-naik, issa-rice, timelines-wiki, donations-list-website, ai-watch, org-watch

## Output Format

Write the complete MDX article to: .claude/temp/page-creator/${topic.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/draft.mdx

Include proper frontmatter:
---
title: "${topic}"
description: "..."
importance: 50
lastEdited: "${new Date().toISOString().split('T')[0]}"
sidebar:
  order: 50
ratings:
  novelty: 5
  rigor: 6
  actionability: 5
  completeness: 6
---
import {EntityLink, Backlinks, KeyPeople, KeyQuestions, Section} from '@components/wiki';

## Article Sections
- Quick Assessment (table)
- Key Links (table with Wikipedia, LessWrong, EA Forum, official site, etc. - if found)
- Overview (2-3 paragraphs)
- History
- [Topic-specific sections]
- Criticisms/Concerns (if applicable)
- Key Uncertainties
- Sources (footnotes)
- <Backlinks />`;
}

async function runSynthesis(topic, quality = 'standard') {
  log('synthesis', `Generating article (${quality})...`);

  const prompt = getSynthesisPrompt(topic, quality);

  // Use Claude Code SDK for synthesis
  return new Promise((resolve, reject) => {
    const model = quality === 'quality' ? 'opus' : 'sonnet';
    const budget = quality === 'quality' ? 3.0 : 2.0;

    const claude = spawn('npx', [
      '@anthropic-ai/claude-code',
      '-p',
      '--print',
      '--dangerously-skip-permissions',
      '--model', model,
      '--max-budget-usd', String(budget),
      '--allowedTools', 'Read,Write,Glob'
    ], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    claude.stdin.write(prompt);
    claude.stdin.end();

    let stdout = '';
    claude.stdout.on('data', data => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    claude.on('close', code => {
      if (code === 0) {
        resolve({ success: true, model, budget });
      } else {
        reject(new Error(`Synthesis failed with code ${code}`));
      }
    });
  });
}

// ============ Phase: Source Verification ============

async function runSourceVerification(topic) {
  log('verify-sources', 'Checking content against research sources...');

  const topicDir = getTopicDir(topic);
  const researchPath = path.join(topicDir, 'perplexity-research.json');
  const draftPath = path.join(topicDir, 'draft.mdx');

  if (!fs.existsSync(researchPath) || !fs.existsSync(draftPath)) {
    log('verify-sources', 'Missing research or draft, skipping verification');
    return { success: true, warnings: [] };
  }

  const research = JSON.parse(fs.readFileSync(researchPath, 'utf-8'));
  const draft = fs.readFileSync(draftPath, 'utf-8');

  // Combine all research text for searching (from Perplexity summaries)
  const perplexityText = research.sources
    ?.map(r => r.content || '')
    .join('\n') || '';

  // Also get fetched source content (actual page content from Firecrawl)
  const fetchedContent = getFetchedSourceContent(topic);
  if (fetchedContent) {
    log('verify-sources', `Using ${fetchedContent.sourceCount} fetched sources for verification (${Math.round(fetchedContent.combinedContent.length / 1000)}k chars)`);
  } else {
    log('verify-sources', 'No fetched source content available, using Perplexity summaries only');
  }

  // Combine Perplexity summaries + fetched content for comprehensive search
  const allSourceContent = fetchedContent
    ? perplexityText + '\n\n' + fetchedContent.combinedContent
    : perplexityText;

  const researchText = allSourceContent.toLowerCase();

  // Also keep original case version for quote matching
  const researchTextOriginal = allSourceContent;

  const warnings = [];

  // ============ Check 1: Verify names exist in research ============
  // Pattern to find author attribution statements
  const authorPatterns = [
    /authored by\s+([^.\n]+)/gi,
    /written by\s+([^.\n]+)/gi,
    /paper was authored by\s+([^.\n]+)/gi,
    /including\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:,\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)*(?:,?\s+and\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)?)/g,
  ];

  // Extract names from draft
  const mentionedNames = new Set();
  for (const pattern of authorPatterns) {
    let match;
    while ((match = pattern.exec(draft)) !== null) {
      const nameStr = match[1];
      const names = nameStr
        .replace(/\s+and\s+/gi, ', ')
        .split(',')
        .map(n => n.trim())
        .filter(n => n.length > 0 && /^[A-Z]/.test(n));

      for (const name of names) {
        if (name.split(/\s+/).length >= 2) {
          mentionedNames.add(name);
        }
      }
    }
  }

  // Check if each name appears in the research
  for (const name of mentionedNames) {
    const nameLower = name.toLowerCase();
    const lastName = name.split(/\s+/).pop()?.toLowerCase();

    if (!researchText.includes(nameLower) && lastName && !researchText.includes(lastName)) {
      warnings.push({
        type: 'unverified-name',
        name,
        message: `Name "${name}" not found in research sources - possible hallucination`,
      });
    }
  }

  // ============ Check 2: Verify attributed quotes exist in research ============
  // Patterns to find quotes attributed to specific people
  // e.g., "X said '...'" or "X wrote '...'" or "X argued '...'" or "According to X, '...'"
  const attributedQuotePatterns = [
    // Person said/wrote/argued/stated/noted/observed/commented "quote"
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:said|wrote|argued|stated|noted|observed|commented|claimed|explained|described|characterized|called)\s*(?:it\s+)?[:\s]*["\u201c]([^"\u201d]+)["\u201d]/gi,
    // According to Person, "quote"
    /[Aa]ccording to\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)[,:\s]+["\u201c]([^"\u201d]+)["\u201d]/gi,
    // Person's words: "quote" or In Person's words, "quote"
    /(?:[Ii]n\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)(?:'s)?\s+words[,:\s]+["\u201c]([^"\u201d]+)["\u201d]/gi,
    // As Person put it, "quote"
    /[Aa]s\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+put it[,:\s]+["\u201c]([^"\u201d]+)["\u201d]/gi,
    // Person described X as "quote"
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+described\s+\w+\s+as\s+["\u201c]([^"\u201d]+)["\u201d]/gi,
    // Person characterized X as "quote"
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+characterized\s+\w+\s+as\s+["\u201c]([^"\u201d]+)["\u201d]/gi,
    // Person criticized X as "quote"
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+criticized\s+[^"\u201c]+\s+as\s+["\u201c]([^"\u201d]+)["\u201d]/gi,
  ];

  const attributedQuotes = [];
  for (const pattern of attributedQuotePatterns) {
    let match;
    while ((match = pattern.exec(draft)) !== null) {
      const person = match[1].trim();
      const quote = match[2].trim();
      // Only check quotes of reasonable length (short phrases might be coincidental)
      if (quote.length >= 15) {
        attributedQuotes.push({ person, quote, fullMatch: match[0] });
      }
    }
  }

  // Check if each attributed quote exists in research
  for (const { person, quote, fullMatch } of attributedQuotes) {
    // Normalize quote for searching (remove extra spaces, lowercase)
    const quoteNormalized = quote.toLowerCase().replace(/\s+/g, ' ').trim();
    const researchNormalized = researchText.replace(/\s+/g, ' ');

    // Check if a substantial portion of the quote appears in research
    // We check for the first 30 chars and last 30 chars to allow for minor variations
    const quoteStart = quoteNormalized.slice(0, 30);
    const quoteEnd = quoteNormalized.slice(-30);

    const foundInResearch = researchNormalized.includes(quoteNormalized) ||
      (quoteStart.length >= 20 && researchNormalized.includes(quoteStart)) ||
      (quoteEnd.length >= 20 && researchNormalized.includes(quoteEnd));

    if (!foundInResearch) {
      warnings.push({
        type: 'unverified-quote',
        person,
        quote: quote.length > 60 ? quote.slice(0, 60) + '...' : quote,
        message: `Quote attributed to "${person}" not found in research - possible hallucination: "${quote.slice(0, 50)}..."`,
      });
    }
  }

  // ============ Check 3: Flag all Person + quote patterns for review ============
  // Even if we can't verify, flag these for manual review
  const allQuoteAttributions = [];
  const simpleAttributionPattern = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:said|wrote|argued|stated|noted|called it|described it as)\s*[:\s]*["\u201c][^"\u201d]{10,}["\u201d]/gi;
  let simpleMatch;
  while ((simpleMatch = simpleAttributionPattern.exec(draft)) !== null) {
    allQuoteAttributions.push({
      person: simpleMatch[1],
      context: simpleMatch[0].slice(0, 100),
    });
  }

  if (allQuoteAttributions.length > 0) {
    log('verify-sources', `📋 Found ${allQuoteAttributions.length} quote attribution(s) to review:`);
    for (const attr of allQuoteAttributions.slice(0, 5)) {
      log('verify-sources', `  - ${attr.person}: "${attr.context.slice(0, 60)}..."`);
    }
    if (allQuoteAttributions.length > 5) {
      log('verify-sources', `  ... and ${allQuoteAttributions.length - 5} more`);
    }
  }

  // ============ Check 4: Undefined URLs ============
  const undefinedUrlMatches = draft.match(/\]\(undefined\)/g);
  if (undefinedUrlMatches) {
    warnings.push({
      type: 'undefined-urls',
      count: undefinedUrlMatches.length,
      message: `${undefinedUrlMatches.length} footnote(s) have undefined URLs`,
    });
  }

  // ============ Summary ============
  if (warnings.length > 0) {
    log('verify-sources', `⚠️  Found ${warnings.length} potential issue(s):`);
    for (const w of warnings) {
      log('verify-sources', `  - ${w.message}`);
    }
    // Save warnings to file for review
    saveResult(topic, 'source-warnings.json', warnings);
  } else {
    log('verify-sources', '✓ All extracted claims found in research');
  }

  // Save all quote attributions for manual review regardless of warnings
  if (allQuoteAttributions.length > 0) {
    saveResult(topic, 'quote-attributions.json', allQuoteAttributions);
  }

  return { success: true, warnings };
}

// ============ Phase: Validation Loop ============

async function runValidationLoop(topic, maxIterations = 3) {
  log('validate', 'Starting validation loop...');

  const draftPath = path.join(getTopicDir(topic), 'draft.mdx');
  if (!fs.existsSync(draftPath)) {
    log('validate', 'No draft found, skipping validation');
    return { success: false, error: 'No draft found' };
  }

  const validationPrompt = `# Validate and Fix Wiki Article

Read the draft article at: ${draftPath}

## Validation Tasks - Fix ALL Issues

### Critical Issues (MUST fix - these break the build):

1. **Run precommit validation**:
   \`node tooling/crux.mjs validate\`

2. **Fix escaping issues**:
   - Escape unescaped $ signs as \\$
   - Escape < before numbers as \\< or use &lt;
   - Use ≈ instead of ~ in table cells (~ renders as strikethrough)
   - Use ≈\\$ instead of ~\\$ (tilde + escaped dollar causes errors)

3. **Fix EntityLinks** (verify IDs resolve):
   - Read app/src/data/pathRegistry.json to see which entity IDs exist
   - For EVERY EntityLink in the draft, verify the id exists as a key in pathRegistry
   - EntityLink IDs must be simple slugs (e.g., "open-philanthropy"), NOT paths (e.g., "organizations/funders/open-philanthropy")
   - If an EntityLink id doesn't exist in pathRegistry:
     - Check for similar IDs (e.g., "center-for-ai-safety" should be "cais")
     - Or REMOVE the EntityLink entirely and use plain text instead
   - It's better to use plain text than to use an invalid EntityLink ID

4. **Fix broken citations**:
   - Ensure all [^N] footnote citations have actual URLs, not "undefined"
   - NEVER use fake URLs like "example.com", "/posts/example", etc.
   - If no real URL available, use text-only citation: [^1]: Source name - description

### Quality Issues (MUST fix - these cause rendering problems):

5. **Fix markdown list formatting**:
   - Numbered lists starting at N>1 need blank line before
   - Check with: \`node tooling/crux.mjs validate unified --rules=markdown-lists\`

6. **Fix consecutive bold labels**:
   - Bold lines like "**Label:** text" need blank line between them
   - Check with: \`node tooling/crux.mjs validate unified --rules=consecutive-bold-labels\`

7. **Remove placeholders**:
   - No TODO markers or placeholder text like "[insert X here]"

### Final Steps:

8. **Check wiki conventions**:
   - All factual claims have footnote citations
   - Proper frontmatter fields present (title, description, importance, lastEdited, ratings)
   - Import statement: \`import {...} from '@components/wiki';\`

9. **Write the final fixed version** to:
   ${path.join(getTopicDir(topic), 'final.mdx')}

10. **Report** what was fixed.

Keep iterating until ALL checks pass. Run validation again after each fix.`;

  return new Promise((resolve, reject) => {
    const claude = spawn('npx', [
      '@anthropic-ai/claude-code',
      '-p',
      '--print',
      '--dangerously-skip-permissions',
      '--model', 'sonnet',
      '--max-budget-usd', '2.0',
      '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep'
    ], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    claude.stdin.write(validationPrompt);
    claude.stdin.end();

    let stdout = '';
    claude.stdout.on('data', data => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    claude.on('close', code => {
      const finalPath = path.join(getTopicDir(topic), 'final.mdx');
      const hasOutput = fs.existsSync(finalPath);
      resolve({
        success: code === 0 && hasOutput,
        hasOutput,
        exitCode: code
      });
    });
  });
}

// ============ Phase: Full Validation (programmatic) ============

async function runFullValidation(topic) {
  log('validate-full', 'Running comprehensive validation...');

  const finalPath = path.join(getTopicDir(topic), 'final.mdx');
  if (!fs.existsSync(finalPath)) {
    log('validate-full', 'No final.mdx found, skipping');
    return { success: false, error: 'No final.mdx found' };
  }

  const results = {
    critical: { passed: 0, failed: 0, errors: [] },
    quality: { passed: 0, failed: 0, warnings: [] },
    compile: { success: false, error: null }
  };

  // 1. Run MDX compilation check on the single file
  log('validate-full', 'Checking MDX compilation...');
  try {
    const { execSync } = await import('child_process');
    // Use compile --quick which only checks changed files
    execSync('node tooling/crux.mjs validate compile --quick', {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 60000
    });
    results.compile.success = true;
    log('validate-full', '  ✓ MDX compiles');
  } catch (error) {
    results.compile.error = error.message;
    log('validate-full', '  ✗ MDX compilation failed');
  }

  // 1b. Direct frontmatter check on temp file (catches issues before deployment)
  try {
    const tempContent = fs.readFileSync(finalPath, 'utf-8');

    // Check for unquoted lastEdited dates
    const unquotedDateMatch = tempContent.match(/lastEdited:\s*(\d{4}-\d{2}-\d{2})(?:\s*$|\s*\n)/m);
    if (unquotedDateMatch) {
      const lineContent = tempContent.split('\n').find(l => l.includes('lastEdited:')) || '';
      if (!lineContent.includes('"') && !lineContent.includes("'")) {
        // Fix it in place
        const fixedContent = tempContent.replace(
          /lastEdited:\s*(\d{4}-\d{2}-\d{2})/,
          'lastEdited: "$1"'
        );
        fs.writeFileSync(finalPath, fixedContent);
        log('validate-full', '  ✓ Fixed unquoted lastEdited date');
      }
    }

    // Check for unquoted createdAt dates (should be unquoted YAML date, not string)
    // This is the opposite - createdAt should NOT be quoted
  } catch (fmError) {
    log('validate-full', `  ⚠ Could not check frontmatter: ${fmError.message}`);
  }

  // 2. Run unified rules on the file
  log('validate-full', 'Running validation rules...');

  // Helper to extract JSON from npm output (filters out npm log lines)
  const extractJson = (output) => {
    const lines = output.split('\n');
    const jsonStartIdx = lines.findIndex(line => line.trim().startsWith('{'));
    if (jsonStartIdx === -1) return null;
    // Join all lines from the JSON start to the end
    const jsonStr = lines.slice(jsonStartIdx).join('\n');
    return JSON.parse(jsonStr);
  };

  // Critical rules (build-breaking)
  const topicSlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  for (const rule of CRITICAL_RULES) {
    try {
      const { execSync } = await import('child_process');
      let output;
      let hasParseError = false;

      try {
        output = execSync(
          `node tooling/crux.mjs validate unified --rules=${rule} --ci 2>&1`,
          { cwd: ROOT, stdio: 'pipe', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        ).toString();
      } catch (execError) {
        // Command may exit non-zero if there are errors in other files
        // Capture stdout/stderr and check if our file has issues
        output = execError.stdout?.toString() || execError.stderr?.toString() || '';
      }

      // Try to parse JSON output
      let json = null;
      try {
        json = extractJson(output);
      } catch (parseErr) {
        // JSON truncated - fall back to grep approach
        hasParseError = true;
      }

      if (json) {
        // JSON parsing succeeded - filter for our file
        const fileIssues = json.issues?.filter(i =>
          i.file?.includes(topicSlug) &&
          i.severity === 'error'
        ) || [];

        if (fileIssues.length > 0) {
          results.critical.failed++;
          results.critical.errors.push({ rule, issues: fileIssues });
          log('validate-full', `  ✗ ${rule}: ${fileIssues.length} error(s)`);
        } else {
          results.critical.passed++;
          log('validate-full', `  ✓ ${rule}`);
        }
      } else if (hasParseError) {
        // JSON truncated - use grep fallback for our file
        // Run again in non-CI mode and grep for our file
        try {
          const grepOutput = execSync(
            `node tooling/crux.mjs validate unified --rules=${rule} 2>&1 | grep -i "${topicSlug}" || true`,
            { cwd: ROOT, stdio: 'pipe', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
          ).toString();

          const errorCount = (grepOutput.match(/error/gi) || []).length;
          if (errorCount > 0) {
            results.critical.failed++;
            results.critical.errors.push({ rule, error: `${errorCount} error(s) found via grep` });
            log('validate-full', `  ✗ ${rule}: ${errorCount} error(s)`);
          } else {
            results.critical.passed++;
            log('validate-full', `  ✓ ${rule}`);
          }
        } catch {
          // Grep fallback failed - assume no issues for our file
          results.critical.passed++;
          log('validate-full', `  ✓ ${rule} (no issues for this file)`);
        }
      } else {
        // No JSON output - treat as success
        results.critical.passed++;
        log('validate-full', `  ✓ ${rule}`);
      }
    } catch (error) {
      // If parsing or other error, mark as failed
      results.critical.failed++;
      results.critical.errors.push({ rule, error: error.message });
      log('validate-full', `  ✗ ${rule}: check failed`);
    }
  }

  // Quality rules (non-blocking)
  for (const rule of QUALITY_RULES) {
    try {
      const { execSync } = await import('child_process');
      const output = execSync(
        `node tooling/crux.mjs validate unified --rules=${rule} --ci 2>&1`,
        { cwd: ROOT, stdio: 'pipe', timeout: 30000 }
      ).toString();

      const json = extractJson(output);
      if (!json) {
        results.quality.passed++;
        log('validate-full', `  ✓ ${rule}`);
        continue;
      }

      const fileIssues = json.issues?.filter(i =>
        i.file?.includes(topic.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
      ) || [];

      if (fileIssues.length > 0) {
        results.quality.failed++;
        results.quality.warnings.push({ rule, issues: fileIssues });
        log('validate-full', `  ⚠ ${rule}: ${fileIssues.length} warning(s)`);
      } else {
        results.quality.passed++;
        log('validate-full', `  ✓ ${rule}`);
      }
    } catch (error) {
      // Quality rules don't block
      log('validate-full', `  ? ${rule}: check skipped`);
    }
  }

  // Summary
  const success = results.compile.success && results.critical.failed === 0;
  log('validate-full', `\nValidation summary: ${success ? 'PASSED' : 'FAILED'}`);
  log('validate-full', `  Critical: ${results.critical.passed}/${results.critical.passed + results.critical.failed} passed`);
  log('validate-full', `  Quality: ${results.quality.passed}/${results.quality.passed + results.quality.failed} passed`);

  // Save results
  saveResult(topic, 'validation-results.json', results);

  return { success, results };
}

// ============ Phase: Grading ============

const GRADING_SYSTEM_PROMPT = `You are an expert evaluator of AI safety content. Score this page on:

- importance (0-100): How significant for understanding AI risk
- quality dimensions (0-10 each): novelty, rigor, actionability, completeness
- llmSummary: 1-2 sentence summary with key conclusions
- balanceFlags: Array of any balance/bias issues detected (see below)

Be harsh but fair. Typical wiki content scores 3-5 on quality dimensions. 7+ is exceptional.

IMPORTANT: This content may describe events after your knowledge cutoff. If the article cites specific sources (URLs, publications, official announcements), assume the described events are real even if you're unfamiliar with them. Do NOT mark well-sourced content as "fictional" or "fabricated" just because you haven't heard of it. Evaluate based on the quality of sourcing, writing, and relevance to AI safety.

BALANCE CHECK - Flag these issues in balanceFlags array:
- "no-criticism-section": Article lacks a Criticisms, Concerns, or Limitations section
- "single-source-dominance": >50% of citations come from one source (e.g., company's own blog)
- "missing-source-incentives": For controversial claims, source's incentives aren't discussed
- "one-sided-framing": Article presents only positive OR only negative perspective without balance
- "uncritical-claims": Major claims presented as fact without attribution ("X is..." vs "X claims...")

IMPORTANCE guidelines:
- 90-100: Essential for prioritization decisions
- 70-89: High value for practitioners
- 50-69: Useful context
- 30-49: Reference material
- 0-29: Peripheral or stubs

Respond with valid JSON only.`;

async function runGrading(topic) {
  log('grade', 'Running quality grading on temp file...');

  const finalPath = path.join(getTopicDir(topic), 'final.mdx');
  if (!fs.existsSync(finalPath)) {
    log('grade', 'No final.mdx found, skipping grading');
    return { success: false, error: 'No final.mdx found' };
  }

  // Read the file
  const content = fs.readFileSync(finalPath, 'utf-8');

  // Extract frontmatter and body
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    log('grade', 'Could not parse frontmatter');
    return { success: false, error: 'Invalid frontmatter' };
  }

  const [, fmYaml, body] = fmMatch;

  // Parse existing frontmatter
  let frontmatter;
  try {
    const { parse: parseYaml } = await import('yaml');
    frontmatter = parseYaml(fmYaml);
  } catch (e) {
    log('grade', `Frontmatter parse error: ${e.message}`);
    return { success: false, error: 'Frontmatter parse error' };
  }

  const title = frontmatter.title || topic;
  const description = frontmatter.description || '';

  // Call Claude API for grading
  log('grade', 'Calling Claude for grading...');

  try {
    const { createClient, parseJsonResponse } = await import('../lib/anthropic.mjs');
    const client = createClient();

    const userPrompt = `Grade this content page:

**Title**: ${title}
**Description**: ${description}

---
FULL CONTENT:
${body.slice(0, 30000)}
---

Respond with JSON:
{
  "importance": <0-100>,
  "ratings": {
    "novelty": <0-10>,
    "rigor": <0-10>,
    "actionability": <0-10>,
    "completeness": <0-10>
  },
  "llmSummary": "<1-2 sentences with conclusions>",
  "balanceFlags": ["<flag-id>", ...] or [] if none,
  "reasoning": "<brief explanation>"
}`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      system: GRADING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const text = response.content[0].text;
    const grades = parseJsonResponse(text);

    if (!grades || !grades.importance) {
      log('grade', 'Invalid grading response');
      return { success: false, error: 'Invalid response' };
    }

    log('grade', `Importance: ${grades.importance}, Quality: ${Math.round((grades.ratings.novelty + grades.ratings.rigor + grades.ratings.actionability + grades.ratings.completeness) * 2.5)}`);

    // Log balance flags if any
    const balanceFlags = grades.balanceFlags || [];
    if (balanceFlags.length > 0) {
      log('grade', `⚠️  Balance issues detected:`);
      for (const flag of balanceFlags) {
        log('grade', `   - ${flag}`);
      }
    } else {
      log('grade', `✓ No balance issues detected`);
    }

    // Calculate quality score (same formula as grade-content.mjs)
    const quality = Math.round(
      (grades.ratings.novelty + grades.ratings.rigor +
       grades.ratings.actionability + grades.ratings.completeness) * 2.5
    );

    // Update frontmatter
    frontmatter.importance = grades.importance;
    frontmatter.ratings = grades.ratings;
    frontmatter.quality = quality;
    frontmatter.llmSummary = grades.llmSummary;
    if (balanceFlags.length > 0) {
      frontmatter.balanceFlags = balanceFlags;
    }

    // Count metrics
    const wordCount = body.split(/\s+/).filter(w => w.length > 0).length;
    const citations = (body.match(/\[\^\d+\]/g) || []).length;
    const tables = (body.match(/^\|/gm) || []).length > 0 ? Math.floor((body.match(/^\|/gm) || []).length / 3) : 0;
    const diagrams = (body.match(/<Mermaid/g) || []).length;

    frontmatter.metrics = {
      wordCount,
      citations: new Set((body.match(/\[\^\d+\]/g) || [])).size,
      tables,
      diagrams
    };

    // Write updated file
    const { stringify: stringifyYaml } = await import('yaml');
    let yamlStr = stringifyYaml(frontmatter);
    // Fix: Ensure lastEdited is always quoted (YAML stringifier doesn't quote date-like strings)
    yamlStr = yamlStr.replace(/^(lastEdited:\s*)(\d{4}-\d{2}-\d{2})$/m, '$1"$2"');
    const newContent = `---\n${yamlStr}---\n${body}`;
    fs.writeFileSync(finalPath, newContent);

    log('grade', `✓ Graded: imp=${grades.importance}, qual=${quality}`);
    log('grade', `  Summary: ${grades.llmSummary?.slice(0, 100)}...`);

    return {
      success: true,
      importance: grades.importance,
      quality,
      ratings: grades.ratings,
      llmSummary: grades.llmSummary
    };

  } catch (error) {
    log('grade', `Grading API error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ============ Phase: Review ============

async function runReview(topic) {
  log('review', 'Running critical review...');

  const draftPath = path.join(getTopicDir(topic), 'draft.mdx');
  const reviewPrompt = `# Critical Review: ${topic}

Read the draft article at: ${draftPath}

You are a skeptical editor doing a final quality check. Look specifically for:

## HIGH PRIORITY - Logical Issues

1. **Section-content contradictions**: Does the content within a section contradict its heading?
   - Example: A section titled "Lack of Preventive Mechanisms" that then describes the subject as "preventive"
   - Example: A "Criticisms" section that only contains praise

2. **Self-contradicting quotes**: Are quotes used in contexts that contradict their meaning?
   - Example: Calling something "preventive, not punitive" while arguing it lacks prevention

3. **Temporal artifacts**: Does the text expose when research was conducted?
   - BAD: "As of the research data (through late 2024)..."
   - BAD: "Based on available sources from 2023..."
   - BAD: "No information was found in the sources..."
   - GOOD: "As of early 2026..." or state facts directly without referencing sources

## STANDARD CHECKS

4. **Uncited claims** - Major facts without footnote citations
5. **Missing topics** - Important aspects not covered based on the title
6. **One-sided framing** - Only positive or negative coverage
7. **Vague language** - "significant", "many experts" without specifics

## Output

Write findings to: ${path.join(getTopicDir(topic), 'review.json')}

Format:
{
  "overallQuality": 70,
  "logicalIssues": [
    {"section": "...", "problem": "...", "suggestion": "..."}
  ],
  "temporalArtifacts": ["line containing the artifact..."],
  "uncitedClaims": [...],
  "missingTopics": [...],
  "suggestions": [...]
}

If you find any logicalIssues or temporalArtifacts, also fix them directly in the draft file.`;

  return new Promise((resolve, reject) => {
    const claude = spawn('npx', [
      '@anthropic-ai/claude-code',
      '-p',
      '--print',
      '--dangerously-skip-permissions',
      '--model', 'sonnet',
      '--max-budget-usd', '1.0',
      '--allowedTools', 'Read,Write'
    ], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    claude.stdin.write(reviewPrompt);
    claude.stdin.end();

    claude.on('close', code => {
      resolve({ success: code === 0 });
    });
  });
}

// ============ Pipeline Runner ============

async function runPipeline(topic, tier = 'standard', directions = null) {
  const config = TIERS[tier];
  if (!config) {
    console.error(`Unknown tier: ${tier}`);
    process.exit(1);
  }

  // Build phases list - add directions processing if provided
  const phases = directions
    ? ['process-directions', ...config.phases]
    : config.phases;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Page Creator - Cost Optimized`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Topic: "${topic}"`);
  console.log(`Tier: ${config.name} (${config.estimatedCost})`);
  if (directions) {
    console.log(`Directions: ${directions.slice(0, 80)}${directions.length > 80 ? '...' : ''}`);
  }
  console.log(`Phases: ${phases.join(' → ')}`);
  console.log(`${'='.repeat(60)}\n`);

  // Store directions for later use
  const pipelineContext = { directions };

  const results = {
    topic,
    tier,
    startTime: new Date().toISOString(),
    phases: {},
    totalCost: 0
  };

  for (const phase of phases) {
    console.log(`\n${'─'.repeat(50)}`);
    log(phase, 'Starting...');

    try {
      let result;

      switch (phase) {
        case 'process-directions':
          result = await processDirections(topic, pipelineContext.directions);
          break;

        case 'canonical-links':
          result = await findCanonicalLinks(topic);
          results.totalCost += result.cost || 0;
          break;

        case 'research-perplexity':
          result = await runPerplexityResearch(topic, 'standard');
          results.totalCost += result.cost || 0;
          break;

        case 'research-perplexity-deep':
          result = await runPerplexityResearch(topic, 'deep');
          results.totalCost += result.cost || 0;
          break;

        case 'research-scry':
          result = await runScryResearch(topic);
          break;

        case 'register-sources':
          result = await registerResearchSources(topic);
          break;

        case 'fetch-sources':
          // Fetch up to 15 sources (balancing coverage vs API costs)
          result = await fetchRegisteredSources(topic, { maxSources: 15 });
          break;

        case 'synthesize':
          result = await runSynthesis(topic, 'standard');
          results.totalCost += result.budget || 0;
          break;

        case 'synthesize-fast':
          result = await runSynthesis(topic, 'fast');
          results.totalCost += 1.0;
          break;

        case 'synthesize-quality':
          result = await runSynthesis(topic, 'quality');
          results.totalCost += result.budget || 0;
          break;

        case 'verify-sources':
          result = await runSourceVerification(topic);
          if (result.warnings?.length > 0) {
            log(phase, `⚠️  Found ${result.warnings.length} potential hallucination(s) - review recommended`);
          }
          break;

        case 'review':
          result = await runReview(topic);
          results.totalCost += 1.0;
          break;

        case 'validate-loop':
          // Auto-fix missing component imports before validation
          {
            const draftPath = path.join(getTopicDir(topic), 'draft.mdx');
            const importResult = ensureComponentImports(draftPath);
            if (importResult.fixed) {
              log('validate-loop', `Auto-fixed missing imports: ${importResult.added.join(', ')}`);
            }
          }
          result = await runValidationLoop(topic);
          results.totalCost += 2.0;
          break;

        case 'validate-quick':
          // Just run validators, don't iterate
          result = { success: true };
          results.totalCost += 0.5;
          break;

        case 'validate-full':
          // Run comprehensive programmatic validation
          result = await runFullValidation(topic);
          if (!result.success) {
            log(phase, '❌ Critical validation failures - page may break build');
          }
          break;

        case 'grade':
          // Run quality grading
          result = await runGrading(topic);
          results.totalCost += 0.01; // Grading is very cheap
          break;

        default:
          log(phase, `Unknown phase: ${phase}`);
          continue;
      }

      results.phases[phase] = { success: true, ...result };
      log(phase, '✅ Complete');

    } catch (error) {
      log(phase, `❌ Failed: ${error.message}`);
      results.phases[phase] = { success: false, error: error.message };

      // Stop on critical failures
      if (phase.includes('research') || phase.includes('synthesize')) {
        break;
      }
    }
  }

  results.endTime = new Date().toISOString();

  // Save summary
  saveResult(topic, 'pipeline-results.json', results);

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('Pipeline Complete');
  console.log(`${'='.repeat(60)}`);
  console.log(`Estimated cost: ~$${results.totalCost.toFixed(2)}`);

  const finalPath = path.join(getTopicDir(topic), 'final.mdx');
  const draftPath = path.join(getTopicDir(topic), 'draft.mdx');

  if (fs.existsSync(finalPath)) {
    console.log(`\n📄 Final article: ${finalPath}`);
  } else if (fs.existsSync(draftPath)) {
    console.log(`\n📄 Draft article: ${draftPath}`);
  }

  return results;
}

// ============ CLI ============

function printHelp() {
  console.log(`
Page Creator - Cost-Optimized Pipeline

Uses Perplexity for research ($0.10) + Claude for synthesis ($2-3)
Total: $4-6 vs $10+ with all-Claude approach

Usage:
  node tooling/content/page-creator.mjs "<topic>" [options]

Options:
  --tier <tier>            Quality tier: budget, standard, premium (default: standard)
  --dest <path>            Deploy to content path (e.g., knowledge-base/people)
  --create-category <name> Create new category with index.mdx
  --directions <text>      Context, source URLs, and editorial guidance (see below)
  --phase <phase>          Run a single phase only (for resuming/testing)
  --force                  Skip duplicate page check (create even if similar page exists)
  --help                   Show this help

Directions:
  Pass a text block with any combination of:
  - Source URLs (will be fetched and included in research)
  - Context the user knows about the topic
  - Editorial guidance (e.g., "be skeptical", "focus on X")

  Example:
    --directions "Primary source: https://example.com/article
    I've heard criticisms that this is overhyped.
    Focus on skeptical perspectives and consider source incentives."

Destination Examples:
  --dest knowledge-base/people
  --dest knowledge-base/organizations/safety-orgs
  --dest knowledge-base/organizations/political-advocacy

Phases:
  canonical-links       Find Wikipedia, LessWrong, EA Forum, official sites
  research-perplexity   Perplexity web research
  register-sources      Register citation URLs in knowledge database
  fetch-sources         Fetch actual page content via Firecrawl
  research-scry         Scry knowledge base search
  synthesize            Claude synthesis to MDX
  verify-sources        Check quotes against fetched source content
  validate-loop         Iterative Claude validation
  validate-full         Comprehensive programmatic validation
  grade                 Quality grading

Tiers:
${Object.entries(TIERS).map(([key, config]) =>
    `  ${key.padEnd(10)} ${config.estimatedCost.padEnd(10)} ${config.description}`
  ).join('\n')}

Examples:
  node tooling/content/page-creator.mjs "MIRI" --tier standard
  node tooling/content/page-creator.mjs "Anthropic" --tier premium
  node tooling/content/page-creator.mjs "Lighthaven" --phase grade
  node tooling/content/page-creator.mjs "Some Event" --dest knowledge-base/incidents --create-category "Incidents"
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const topic = args.find(arg => !arg.startsWith('--'));
  const tierIndex = args.indexOf('--tier');
  const tier = tierIndex !== -1 ? args[tierIndex + 1] : 'standard';
  const phaseIndex = args.indexOf('--phase');
  const singlePhase = phaseIndex !== -1 ? args[phaseIndex + 1] : null;
  const destIndex = args.indexOf('--dest');
  const destPath = destIndex !== -1 ? args[destIndex + 1] : null;
  const directionsIndex = args.indexOf('--directions');
  const directions = directionsIndex !== -1 ? args[directionsIndex + 1] : null;
  const createCategoryIndex = args.indexOf('--create-category');
  const createCategory = createCategoryIndex !== -1 ? args[createCategoryIndex + 1] : null;
  const forceCreate = args.includes('--force');

  if (!topic) {
    console.error('Error: Topic required');
    printHelp();
    process.exit(1);
  }

  // Check for existing pages with similar names (skip for single phases)
  if (!singlePhase && !forceCreate) {
    console.log(`\nChecking for existing pages similar to "${topic}"...`);
    const { exists, matches } = await checkForExistingPage(topic);

    if (matches.length > 0) {
      console.log('\n⚠️  Found similar existing pages:');
      for (const match of matches) {
        const simPercent = Math.round(match.similarity * 100);
        const indicator = match.similarity >= 0.9 ? '🔴' : match.similarity >= 0.8 ? '🟡' : '🟢';
        console.log(`  ${indicator} ${match.title} (${simPercent}% similar)`);
        console.log(`     Path: ${match.path}`);
      }

      if (exists) {
        console.log('\n❌ A page with this name likely already exists.');
        console.log('   Use --force to create anyway, or choose a different topic.\n');
        process.exit(1);
      } else {
        console.log('\n   These are partial matches. Proceeding with page creation...\n');
      }
    } else {
      console.log('   No similar pages found. Proceeding...\n');
    }
  }

  ensureDir(TEMP_DIR);

  // If running a single phase, execute just that phase
  if (singlePhase) {
    console.log(`Running single phase: ${singlePhase} for "${topic}"`);
    let result;
    switch (singlePhase) {
      case 'process-directions':
        if (!directions) {
          console.error('Error: --directions required for process-directions phase');
          process.exit(1);
        }
        result = await processDirections(topic, directions);
        break;
      case 'canonical-links':
        result = await findCanonicalLinks(topic);
        break;
      case 'research-perplexity':
        result = await runPerplexityResearch(topic);
        break;
      case 'research-scry':
        result = await runScryResearch(topic);
        break;
      case 'register-sources':
        result = await registerResearchSources(topic);
        break;
      case 'fetch-sources':
        result = await fetchRegisteredSources(topic, { maxSources: 15 });
        break;
      case 'synthesize':
        result = await runSynthesis(topic, tier === 'premium' ? 'opus' : 'sonnet', 2.0);
        break;
      case 'verify-sources':
        result = await runSourceVerification(topic);
        break;
      case 'validate-loop':
        // Auto-fix missing component imports before validation
        {
          const draftPath = path.join(getTopicDir(topic), 'draft.mdx');
          const importResult = ensureComponentImports(draftPath);
          if (importResult.fixed) {
            log('validate-loop', `Auto-fixed missing imports: ${importResult.added.join(', ')}`);
          }
        }
        result = await runValidationLoop(topic);
        break;
      case 'validate-full':
        result = await runFullValidation(topic);
        break;
      case 'grade':
        result = await runGrading(topic);
        break;
      default:
        console.error(`Unknown phase: ${singlePhase}`);
        process.exit(1);
    }
    console.log('Result:', JSON.stringify(result, null, 2));
    return;
  }

  await runPipeline(topic, tier, directions);

  // Deploy to destination if --dest provided
  if (destPath) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log('Deploying to content directory...');

    // Create category if requested
    if (createCategory) {
      console.log(`Creating category: ${createCategory}`);
      createCategoryDirectory(destPath, createCategory);
    }

    const deployResult = deployToDestination(topic, destPath);

    if (deployResult.success) {
      console.log(`✓ Deployed to: ${deployResult.deployedTo}`);

      // Check sidebar coverage
      if (deployResult.sidebarCoverage?.covered) {
        console.log(`✓ Sidebar: Covered by autogenerate (${deployResult.sidebarCoverage.matchedPath})`);
      } else if (deployResult.sidebarCoverage) {
        console.log(`\n⚠️  WARNING: Page may not appear in navigation!`);
        console.log(`   The path "${destPath}" may not be covered by the navigation config.`);
        if (deployResult.sidebarCoverage.availablePaths) {
          console.log(`\n   Available paths:`);
          deployResult.sidebarCoverage.availablePaths.slice(0, 10).forEach(p => {
            console.log(`     --dest ${p}`);
          });
        }
      }

      // Cross-linking validation
      const entitySlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const crossLinkCheck = validateCrossLinks(deployResult.deployedTo);

      console.log(`\n${'─'.repeat(50)}`);
      if (crossLinkCheck.warnings.length > 0) {
        console.log(`${'\x1b[33m'}⚠️  Cross-linking issues detected:${'\x1b[0m'}`);
        crossLinkCheck.warnings.forEach(w => console.log(`   - ${w}`));
        console.log(`\n   Outbound EntityLinks (${crossLinkCheck.outboundCount}): ${crossLinkCheck.outboundIds.join(', ') || 'none'}`);
      } else {
        console.log(`${'\x1b[32m'}✓ Cross-linking looks good (${crossLinkCheck.outboundCount} outbound EntityLinks)${'\x1b[0m'}`);
      }

      console.log(`\n${'\x1b[33m'}📌 Cross-linking reminder:${'\x1b[0m'}`);
      console.log(`   After running 'pnpm build', check cross-links:`);
      console.log(`   ${'\x1b[36m'}node tooling/crux.mjs analyze entity-links ${entitySlug}${'\x1b[0m'}`);
      console.log(`\n   This shows pages that mention this entity but don't link to it.`);
      console.log(`   Consider adding EntityLinks to improve wiki connectivity.`);
    } else {
      console.log(`✗ Deployment failed: ${deployResult.error}`);
    }
  } else {
    // No --dest provided, just remind user
    console.log(`\n💡 Tip: Use --dest <path> to deploy directly to content directory`);
    console.log(`   Example: --dest knowledge-base/people`);
  }
}

main().catch(console.error);
