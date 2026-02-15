/**
 * Build Data Script
 *
 * Converts YAML files to JSON for browser import.
 * Also computes backlinks, tag index, and statistics.
 * Run this before building the site.
 *
 * Usage: node scripts/build-data.mjs
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, basename, relative } from 'path';
import { parse } from 'yaml';
import { extractMetrics, suggestQuality, getQualityDiscrepancy } from './lib/metrics-extractor.mjs';
import { computeRedundancy } from './lib/redundancy.mjs';
import { CONTENT_DIR, DATA_DIR, OUTPUT_DIR, PROJECT_ROOT } from './lib/content-types.mjs';
import { generateLLMFiles } from './generate-llm-files.mjs';
import { buildUrlToResourceMap, findUnconvertedLinks, countConvertedLinks } from './lib/unconverted-links.mjs';
import { generateMdxFromYaml } from './lib/mdx-generator.mjs';
import { computeStats } from './lib/statistics.mjs';
import { parseNumericValue, resolveComputedFacts } from './lib/computed-facts.mjs';
import { transformEntities } from './lib/entity-transform.mjs';
import { scanFrontmatterEntities } from './lib/frontmatter-scanner.mjs';
import { buildSearchIndex } from './lib/search.mjs';

const OUTPUT_FILE = join(OUTPUT_DIR, 'database.json');

// Files to combine
const DATA_FILES = [
  { key: 'experts', file: 'experts.yaml' },
  { key: 'organizations', file: 'organizations.yaml' },
  { key: 'estimates', file: 'estimates.yaml' },
  { key: 'cruxes', file: 'cruxes.yaml' },
  { key: 'glossary', file: 'glossary.yaml' },
  { key: 'entities', dir: 'entities' }, // Split by entity type
  { key: 'literature', file: 'literature.yaml' },
  { key: 'funders', file: 'funders.yaml' },
  { key: 'resources', dir: 'resources' }, // Split into multiple files
  { key: 'publications', file: 'publications.yaml' },
  { key: 'parameterGraph', file: 'parameter-graph.yaml', isObject: true }, // Graph structure (not array)
];

/**
 * Parse session log content and return a map of pageId → ChangeEntry[]
 *
 * Each session entry looks like:
 *   ## 2026-02-13 | branch-name | Short title
 *   **What was done:** Summary text.
 *   **Pages:** page-id-1, page-id-2
 *   ...
 *
 * Returns: { [pageId]: [{ date, branch, title, summary }] }
 */
function parseSessionLogContent(content) {
  const pageHistory = {};

  // Split into entries by ## headings
  const entryPattern = /^## (\d{4}-\d{2}-\d{2}) \| ([^\|]+?) \| (.+)$/gm;
  const entries = [];
  let match;

  while ((match = entryPattern.exec(content)) !== null) {
    entries.push({
      date: match[1],
      branch: match[2].trim(),
      title: match[3].trim(),
      startIndex: match.index,
    });
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const endIndex = i + 1 < entries.length ? entries[i + 1].startIndex : content.length;
    const body = content.slice(entry.startIndex, endIndex);

    // Extract "What was done" summary
    const summaryMatch = body.match(/\*\*What was done:\*\*\s*(.+?)(?:\n\n|\n\*\*|\n---)/s);
    const summary = summaryMatch ? summaryMatch[1].trim() : '';

    // Extract "Pages" list
    const pagesMatch = body.match(/\*\*Pages:\*\*\s*(.+?)(?:\n\n|\n\*\*|\n---)/s);
    if (!pagesMatch) continue; // No pages field — infrastructure-only session

    const pageIds = pagesMatch[1]
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0 && /^[a-z0-9][a-z0-9-]*$/.test(id));

    const changeEntry = {
      date: entry.date,
      branch: entry.branch,
      title: entry.title,
      summary,
    };

    for (const pageId of pageIds) {
      if (!pageHistory[pageId]) {
        pageHistory[pageId] = [];
      }
      pageHistory[pageId].push(changeEntry);
    }
  }

  return pageHistory;
}

/**
 * Collect all session log content from both the consolidated session-log.md
 * and individual session files in .claude/sessions/*.md, then parse into
 * a merged pageId → ChangeEntry[] map.
 *
 * Deduplicates entries that appear in both sources (same date+branch+title).
 */
function parseAllSessionLogs(consolidatedLogPath, sessionsDir) {
  const allContent = [];

  // Read consolidated log if it exists
  if (existsSync(consolidatedLogPath)) {
    allContent.push(readFileSync(consolidatedLogPath, 'utf-8'));
  }

  // Read individual session files
  if (existsSync(sessionsDir)) {
    const files = readdirSync(sessionsDir)
      .filter(f => f.endsWith('.md'))
      .sort();
    for (const file of files) {
      const filePath = join(sessionsDir, file);
      if (statSync(filePath).isFile()) {
        allContent.push(readFileSync(filePath, 'utf-8'));
      }
    }
  }

  if (allContent.length === 0) return {};

  // Parse each source separately, then merge with deduplication
  const merged = {};
  const seen = new Set(); // Track "date|branch|title" to deduplicate

  for (const content of allContent) {
    const partial = parseSessionLogContent(content);
    for (const [pageId, entries] of Object.entries(partial)) {
      if (!merged[pageId]) merged[pageId] = [];
      for (const entry of entries) {
        const key = `${entry.date}|${entry.branch}|${entry.title}|${pageId}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged[pageId].push(entry);
        }
      }
    }
  }

  return merged;
}

function loadYaml(filename) {
  const filepath = join(DATA_DIR, filename);
  if (!existsSync(filepath)) {
    console.warn(`File not found: ${filepath}`);
    return [];
  }
  const content = readFileSync(filepath, 'utf-8');
  return parse(content) || [];
}

/**
 * Load and merge all YAML files from a directory
 */
function loadYamlDir(dirname) {
  const dirpath = join(DATA_DIR, dirname);
  if (!existsSync(dirpath)) {
    console.warn(`Directory not found: ${dirpath}`);
    return [];
  }

  const files = readdirSync(dirpath).filter((f) => f.endsWith('.yaml'));
  const merged = [];

  for (const file of files) {
    const filepath = join(dirpath, file);
    const content = readFileSync(filepath, 'utf-8');
    const data = parse(content) || [];
    merged.push(...data);
  }

  return merged;
}

function countEntries(data) {
  if (Array.isArray(data)) {
    return data.length;
  }
  if (data && typeof data === 'object') {
    let count = 0;
    for (const value of Object.values(data)) {
      if (Array.isArray(value)) {
        count += value.length;
      }
    }
    return count || Object.keys(data).length;
  }
  return 0;
}

/**
 * Compute backlinks for all entities
 * Returns a map: entityId -> array of entities that link to it
 */
function computeBacklinks(entities) {
  const backlinks = {};

  for (const entity of entities) {
    // Check relatedEntries
    if (entity.relatedEntries) {
      for (const ref of entity.relatedEntries) {
        if (!backlinks[ref.id]) {
          backlinks[ref.id] = [];
        }
        backlinks[ref.id].push({
          id: entity.id,
          type: entity.type,
          title: entity.title,
          relationship: ref.relationship,
        });
      }
    }
  }

  return backlinks;
}

/**
 * Scan MDX content for <EntityLink id="..."> references.
 * Returns inbound map: targetEntityId -> array of source pages that link to it.
 * Must be called before rawContent is stripped from pages.
 */
function scanContentEntityLinks(pages, entityMap) {
  const inbound = {};
  let totalLinks = 0;

  for (const page of pages) {
    if (!page.rawContent) continue;

    const regex = /<EntityLink\s+[^>]*id="([^"]+)"/g;
    let match;
    const seen = new Set();

    while ((match = regex.exec(page.rawContent)) !== null) {
      const targetId = match[1];
      if (targetId === page.id) continue; // Skip self-links
      if (seen.has(targetId)) continue;
      seen.add(targetId);

      if (!inbound[targetId]) {
        inbound[targetId] = [];
      }
      const sourceEntity = entityMap.get(page.id);
      inbound[targetId].push({
        id: page.id,
        type: sourceEntity?.type || 'concept',
        title: page.title,
      });
      totalLinks++;
    }
  }

  return { inbound, totalLinks };
}

/**
 * Compute a bidirectional related-pages graph combining all signals.
 * Every connection is symmetric: if A relates to B, B relates to A.
 *
 * Signals (from strongest to weakest):
 *   1. Explicit YAML relatedEntries  (weight 10)
 *   2. Name/prefix matching          (weight 6)
 *   3. Content EntityLinks            (weight 5)
 *   4. Content similarity/redundancy  (weight 0–3, scaled by similarity)
 *   5. Shared tags                    (weight varies by specificity)
 *
 * Quality boost: Each neighbor's raw score is multiplied by a gentle factor
 * based on the target page's quality and importance ratings:
 *   boost = 1 + quality/40 + importance/400   (max ~1.45x)
 * Unrated pages default to average values (q=5, imp=50 → 1.25x) so they
 * aren't penalized vs rated pages. This nudges high-quality content up
 * without reordering strongly-related connections.
 *
 * Returns: entityId -> sorted array of { id, type, title, score, label? }
 */
function computeRelatedGraph(entities, pages, contentInbound, tagIndex) {
  const entityMap = new Map(entities.map(e => [e.id, e]));
  const pageMap = new Map(pages.map(p => [p.id, p]));

  // Accumulator: graph[entityId] = Map<relatedId, score>
  const graph = {};

  // Directional labels from YAML relatedEntries (not symmetric)
  // labels[from][to] = "analyzes"
  const labels = {};

  // Map for auto-generating reverse labels
  const INVERSE_LABEL = {
    'causes': 'caused by',
    'cause': 'caused by',
    'mitigates': 'mitigated by',
    'mitigated-by': 'mitigates',
    'mitigation': 'mitigated by',
    'requires': 'required by',
    'enables': 'enabled by',
    'blocks': 'blocked by',
    'supersedes': 'superseded by',
    'increases': 'increased by',
    'decreases': 'decreased by',
    'supports': 'supported by',
    'measures': 'measured by',
    'measured-by': 'measures',
    'analyzed-by': 'analyzes',
    'analyzes': 'analyzed by',
    'child-of': 'parent of',
    'composed-of': 'component of',
    'component': 'composed of',
    'addresses': 'addressed by',
    'affects': 'affected by',
    'amplifies': 'amplified by',
    'contributes-to': 'receives contribution from',
    'driven-by': 'drives',
    'driver': 'driven by',
    'drives': 'driven by',
    'leads-to': 'leads',
    'shaped-by': 'shapes',
    'prerequisite': 'depends on',
    'research': 'researched by',
    'models': 'modeled by',
  };

  function addEdge(a, b, weight) {
    if (a === b) return;
    for (const [from, to] of [[a, b], [b, a]]) {
      if (!graph[from]) graph[from] = new Map();
      graph[from].set(to, (graph[from].get(to) || 0) + weight);
    }
  }

  // 1. Explicit YAML relatedEntries (strongest signal)
  for (const entity of entities) {
    if (entity.relatedEntries) {
      for (const ref of entity.relatedEntries) {
        addEdge(entity.id, ref.id, 10);
        // Store directional label if present
        if (ref.relationship && ref.relationship !== 'related') {
          if (!labels[entity.id]) labels[entity.id] = {};
          labels[entity.id][ref.id] = ref.relationship.replace(/-/g, ' ');
          // Also store inverse label for the reverse direction
          const inverse = INVERSE_LABEL[ref.relationship];
          if (inverse) {
            if (!labels[ref.id]) labels[ref.id] = {};
            // Don't overwrite an explicit label with an inferred one
            if (!labels[ref.id][entity.id]) {
              labels[ref.id][entity.id] = inverse;
            }
          }
        }
      }
    }
  }

  // 2. Name/prefix matching (e.g. "anthropic" ↔ "anthropic-ipo")
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i].id, b = entities[j].id;
      if (b.startsWith(a + '-') || a.startsWith(b + '-')) {
        addEdge(a, b, 6);
      }
    }
  }

  // 3. Content EntityLinks (directional in content, but stored bidirectionally)
  for (const [targetId, sources] of Object.entries(contentInbound)) {
    for (const source of sources) {
      addEdge(source.id, targetId, 5);
    }
  }

  // 4. Content similarity from redundancy scores
  for (const page of pages) {
    if (!page.redundancy?.similarPages) continue;
    for (const sp of page.redundancy.similarPages) {
      addEdge(page.id, sp.id, (sp.similarity / 100) * 3);
    }
  }

  // 5. Shared tags — weighted by specificity (rarer tags are more informative)
  for (const entity of entities) {
    if (!entity.tags?.length) continue;
    for (const tag of entity.tags) {
      const tagEntities = tagIndex[tag] || [];
      const specificity = 1 / Math.log2(tagEntities.length + 2);
      for (const te of tagEntities) {
        if (te.id !== entity.id) {
          addEdge(entity.id, te.id, specificity * 2);
        }
      }
    }
  }

  // Convert to output: apply quality boost, then type-diverse selection.
  // Guarantees representation from each type before filling by score.
  const MAX_PER_ENTITY = 25;
  const MIN_PER_TYPE = 2;

  const output = {};
  for (const [entityId, neighbors] of Object.entries(graph)) {
    const scored = [...neighbors.entries()]
      .map(([targetId, rawScore]) => {
        // Gentle boost: nudge high-quality pages up without reordering strong links.
        // Unrated pages get average defaults so they aren't penalized.
        const targetPage = pageMap.get(targetId);
        const q = targetPage?.quality ?? 5;
        const imp = targetPage?.importance ?? 50;
        const boost = 1 + q / 40 + imp / 400;
        const e = entityMap.get(targetId);
        const entry = {
          id: targetId,
          type: e?.type || 'concept',
          title: e?.title || targetId,
          score: Math.round(rawScore * boost * 100) / 100,
        };
        // Attach directional label if one exists for this specific pair
        const lbl = labels[entityId]?.[targetId];
        if (lbl) entry.label = lbl;
        return entry;
      })
      .filter(entry => entry.score >= 1.0)
      .sort((a, b) => b.score - a.score);

    // Type-diverse selection: guarantee MIN_PER_TYPE from each type,
    // then fill remaining slots with highest-scoring entries.
    const selected = new Set();
    const byType = new Map();
    for (const entry of scored) {
      if (!byType.has(entry.type)) byType.set(entry.type, []);
      byType.get(entry.type).push(entry);
    }

    // Phase 1: take top MIN_PER_TYPE from each type
    for (const [, entries] of byType) {
      for (const entry of entries.slice(0, MIN_PER_TYPE)) {
        selected.add(entry.id);
      }
    }

    // Phase 2: fill remaining slots by score (may already be selected)
    for (const entry of scored) {
      if (selected.size >= MAX_PER_ENTITY) break;
      selected.add(entry.id);
    }

    // Build final list in score order
    const result = scored.filter(e => selected.has(e.id)).slice(0, MAX_PER_ENTITY);

    if (result.length > 0) {
      output[entityId] = result;
    }
  }

  return output;
}

/**
 * Build inverted tag index
 * Returns a map: tag -> array of entities with that tag
 */
function buildTagIndex(entities) {
  const index = {};

  for (const entity of entities) {
    if (!entity.tags) continue;

    for (const tag of entity.tags) {
      if (!index[tag]) {
        index[tag] = [];
      }
      index[tag].push({
        id: entity.id,
        type: entity.type,
        title: entity.title,
      });
    }
  }

  // Sort tags alphabetically
  const sortedIndex = {};
  for (const tag of Object.keys(index).sort()) {
    sortedIndex[tag] = index[tag];
  }

  return sortedIndex;
}

/**
 * Extract frontmatter from MDX/MD content using YAML parser
 * Properly handles nested objects like ratings
 */
function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  try {
    return parse(match[1]) || {};
  } catch (e) {
    console.warn('Failed to parse frontmatter:', e.message);
    return {};
  }
}

/**
 * Build pages registry by scanning all MDX/MD files
 * Extracts frontmatter including quality, lastUpdated, title, etc.
 * Also detects unconverted links (markdown links with matching resources)
 */
function buildPagesRegistry(urlToResource) {
  const pages = [];

  function scanDirectory(dir, urlPrefix = '') {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        scanDirectory(fullPath, `${urlPrefix}/${entry}`);
      } else if (entry.endsWith('.mdx') || entry.endsWith('.md')) {
        const id = basename(entry, entry.endsWith('.mdx') ? '.mdx' : '.md');
        const content = readFileSync(fullPath, 'utf-8');
        const fm = extractFrontmatter(content);

        // Skip index files for the pages list
        if (id === 'index') continue;

        const urlPath = `${urlPrefix}/${id}/`;

        // Extract structural metrics (format-aware scoring)
        const contentFormat = fm.contentFormat || 'article';
        const metrics = extractMetrics(content, fullPath, contentFormat);
        const currentQuality = fm.quality ? parseInt(fm.quality) : null;

        // Find unconverted links (markdown links that have matching resources)
        const unconvertedLinks = urlToResource ? findUnconvertedLinks(content, urlToResource) : [];

        // Count already converted links (<R> components)
        const convertedLinkCount = countConvertedLinks(content);

        pages.push({
          id,
          numericId: fm.numericId || null,
          _fullPath: fullPath,
          path: urlPath,
          filePath: relative(CONTENT_DIR, fullPath),
          title: fm.title || id.replace(/-/g, ' '),
          quality: currentQuality,
          importance: fm.importance ? parseInt(fm.importance) : null,
          // Content format: article (default), table, diagram, index, dashboard
          contentFormat: fm.contentFormat || 'article',
          // ITN framework fields (0-100 scale)
          tractability: fm.tractability ? parseInt(fm.tractability) : null,
          neglectedness: fm.neglectedness ? parseInt(fm.neglectedness) : null,
          uncertainty: fm.uncertainty ? parseInt(fm.uncertainty) : null,
          causalLevel: fm.causalLevel || null,
          lastUpdated: fm.lastUpdated || fm.lastEdited || null,
          llmSummary: fm.llmSummary || null,
          structuredSummary: fm.structuredSummary || null,
          description: fm.description || null,
          // Extract ratings for model pages
          ratings: fm.ratings || null,
          // Extract category from path (prefer subdirectory, fallback to top-level dir)
          category: urlPrefix.split('/').filter(Boolean)[1] || urlPrefix.split('/').filter(Boolean)[0] || 'other',
          // Subcategory from frontmatter (set by flatten-content migration)
          subcategory: fm.subcategory || null,
          // Topic clusters for filtering
          clusters: fm.clusters || ['ai-safety'],
          // Structural metrics
          metrics: {
            wordCount: metrics.wordCount,
            tableCount: metrics.tableCount,
            diagramCount: metrics.diagramCount,
            internalLinks: metrics.internalLinks,
            externalLinks: metrics.externalLinks,
            footnoteCount: metrics.footnoteCount,
            bulletRatio: Math.round(metrics.bulletRatio * 100) / 100,
            sectionCount: metrics.sectionCount.total,
            hasOverview: metrics.hasOverview,
            structuralScore: metrics.structuralScore,
          },
          // Suggested quality based on structure
          suggestedQuality: suggestQuality(metrics.structuralScore, fm),
          // Update frequency (days between updates)
          updateFrequency: fm.update_frequency ? parseInt(fm.update_frequency) : null,
          // Evergreen flag (false = point-in-time content like reports, excluded from update schedule)
          evergreen: fm.evergreen === false ? false : true,
          // Legacy field for backwards compatibility
          wordCount: metrics.wordCount,
          // Unconverted links (markdown links with matching resources)
          unconvertedLinks,
          unconvertedLinkCount: unconvertedLinks.length,
          // Already converted links (<R> components)
          convertedLinkCount,
          // Raw content for redundancy analysis (removed before JSON output)
          rawContent: content,
        });
      }
    }
  }

  // Scan all content directories
  scanDirectory(join(CONTENT_DIR, 'knowledge-base'), '/knowledge-base');

  const otherDirs = ['ai-transition-model', 'analysis', 'getting-started', 'browse', 'internal', 'style-guides', 'guides', 'insight-hunting', 'dashboard', 'project'];
  for (const topDir of otherDirs) {
    const dirPath = join(CONTENT_DIR, topDir);
    if (existsSync(dirPath)) {
      scanDirectory(dirPath, `/${topDir}`);
    }
  }

  return pages;
}

/**
 * Build path registry by scanning all MDX/MD files
 * Maps entity IDs (from filenames) to their URL paths.
 * Also adds entity-ID-to-path mappings from YAML data for entities
 * whose IDs differ from their page filenames (e.g. "tmc-compute" → "/ai-transition-model/compute/").
 */
function buildPathRegistry() {
  const registry = {};

  function scanDirectory(dir, urlPrefix = '') {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Recurse into subdirectory
        scanDirectory(fullPath, `${urlPrefix}/${entry}`);
      } else if (entry.endsWith('.mdx') || entry.endsWith('.md')) {
        // Extract ID from filename (remove extension)
        const id = basename(entry, entry.endsWith('.mdx') ? '.mdx' : '.md');

        // Skip index files - they use the directory path
        if (id === 'index') {
          // The directory itself is the URL
          registry[`__index__${urlPrefix}`] = `${urlPrefix}/`;
        } else {
          // Build the URL path
          const urlPath = `${urlPrefix}/${id}/`;
          registry[id] = urlPath;
        }
      }
    }
  }

  // Scan the knowledge-base directory
  scanDirectory(join(CONTENT_DIR, 'knowledge-base'), '/knowledge-base');

  // Also scan other top-level content directories
  const topLevelDirs = ['ai-transition-model', 'analysis', 'getting-started', 'browse', 'internal', 'style-guides', 'guides', 'insight-hunting', 'dashboard', 'project'];
  for (const topDir of topLevelDirs) {
    const dirPath = join(CONTENT_DIR, topDir);
    if (existsSync(dirPath)) {
      scanDirectory(dirPath, `/${topDir}`);
    }
  }

  // Add entity-to-path mappings from YAML entity data.
  // Many entities have IDs that differ from their page filenames
  // (e.g. entity "tmc-compute" has path "/ai-transition-model/compute/").
  // Also handle factor entities that follow "factors-{id}-overview" naming.
  const entityDir = join(DATA_DIR, 'entities');
  if (existsSync(entityDir)) {
    for (const file of readdirSync(entityDir)) {
      if (!file.endsWith('.yaml')) continue;
      const content = readFileSync(join(entityDir, file), 'utf-8');
      const entities = parse(content);
      if (!Array.isArray(entities)) continue;
      for (const entity of entities) {
        if (!entity.id || registry[entity.id]) continue;
        // Use explicit path field if present
        if (entity.path) {
          const normalized = entity.path.replace(/\/$/, '') + '/';
          registry[entity.id] = normalized;
        } else {
          // Try "factors-{id}-overview" pattern for factor entities
          const overviewId = `factors-${entity.id}-overview`;
          if (registry[overviewId]) {
            registry[entity.id] = registry[overviewId];
          }
        }
      }
    }
  }

  return registry;
}


function main() {
  console.log('Building data bundle...\n');

  const database = {};

  for (const { key, file, dir, isObject } of DATA_FILES) {
    const data = dir ? loadYamlDir(dir) : loadYaml(file);
    database[key] = data;
    if (isObject) {
      // Object with structure (e.g., parameterGraph with nodes/edges)
      const nodeCount = data?.nodes?.length || 0;
      const edgeCount = data?.edges?.length || 0;
      console.log(`  ${key}: ${nodeCount} nodes, ${edgeCount} edges`);
    } else {
      console.log(`  ${key}: ${countEntries(data)} entries`);
    }
  }

  // Compute derived data for entities
  // Load YAML entities
  const yamlEntities = database.entities || [];
  const yamlEntityIds = new Set(yamlEntities.map(e => e.id));

  // Auto-create entities from MDX frontmatter (for pages without YAML entities)
  const frontmatterEntities = scanFrontmatterEntities(yamlEntityIds, CONTENT_DIR);
  if (frontmatterEntities.length > 0) {
    console.log(`  frontmatter entities: ${frontmatterEntities.length} auto-created from MDX`);
  }

  // Merge: YAML entities take precedence, frontmatter fills gaps
  const entities = [...yamlEntities, ...frontmatterEntities];
  database.entities = entities;

  // =========================================================================
  // ID REGISTRY — derive from numericId fields in source files (YAML + MDX)
  //
  // IDs are stored in source files (YAML `numericId:` or MDX frontmatter).
  // This section reads them, detects conflicts, and assigns IDs to any
  // new entities that don't have one yet (writing back to source files).
  // The id-registry.json is generated as a derived build artifact only.
  // =========================================================================
  const ID_REGISTRY_FILE = join(DATA_DIR, 'id-registry.json');
  const slugToNumericId = {};
  const numericIdToSlug = {};
  const conflicts = [];

  // Collect numericIds from all entities (YAML + frontmatter)
  for (const entity of entities) {
    if (entity.numericId) {
      // Detect conflicts: two different entities claiming the same numericId
      if (numericIdToSlug[entity.numericId] && numericIdToSlug[entity.numericId] !== entity.id) {
        conflicts.push(`${entity.numericId} claimed by both "${numericIdToSlug[entity.numericId]}" and "${entity.id}"`);
      }
      numericIdToSlug[entity.numericId] = entity.id;
      slugToNumericId[entity.id] = entity.numericId;
    }
  }

  if (conflicts.length > 0) {
    console.error('\n  ERROR: numericId conflicts detected:');
    for (const c of conflicts) console.error(`    ${c}`);
    process.exit(1);
  }

  // Compute next available ID from existing assignments
  let nextId = 1;
  for (const numId of Object.keys(numericIdToSlug)) {
    const n = parseInt(numId.slice(1));
    if (n >= nextId) nextId = n + 1;
  }

  // Assign IDs to entities that don't have one yet, writing back to source
  let newAssignments = 0;
  for (const entity of entities) {
    if (!entity.numericId) {
      const numId = `E${nextId}`;
      entity.numericId = numId;
      numericIdToSlug[numId] = entity.id;
      slugToNumericId[entity.id] = numId;
      nextId++;
      newAssignments++;

      // Write the new numericId back to the source file
      if (entity._source === 'frontmatter' && entity._filePath) {
        // MDX frontmatter entity: inject numericId into frontmatter
        const content = readFileSync(entity._filePath, 'utf-8');
        const updated = content.replace(/^---\n/, `---\nnumericId: ${numId}\n`);
        writeFileSync(entity._filePath, updated);
        console.log(`    Assigned ${numId} → ${entity.id} (wrote to MDX frontmatter)`);
      } else {
        // YAML entity: would need to update YAML file
        // For now, warn — this should be handled by `crux content create`
        console.warn(`    WARNING: Assigned ${numId} → ${entity.id} (YAML entity without numericId — add manually)`);
      }
    }
  }

  // Generate id-registry.json as derived build artifact
  const idRegistry = { _nextId: nextId, entities: numericIdToSlug };
  writeFileSync(ID_REGISTRY_FILE, JSON.stringify(idRegistry, null, 2));
  copyFileSync(ID_REGISTRY_FILE, join(OUTPUT_DIR, 'id-registry.json'));

  if (newAssignments > 0) {
    console.log(`  idRegistry: assigned ${newAssignments} new IDs (total: ${Object.keys(numericIdToSlug).length})`);
  } else {
    console.log(`  idRegistry: all ${Object.keys(numericIdToSlug).length} entities have IDs`);
  }

  // Build lookup maps for database output
  const idRegistryOutput = {
    byNumericId: { ...numericIdToSlug },
    bySlug: { ...slugToNumericId },
  };
  database.idRegistry = idRegistryOutput;

  // Generate MDX stubs for entities with YAML-first content
  console.log('\nGenerating MDX from YAML content...');
  const { generated, skipped } = generateMdxFromYaml(entities, { dryRun: false });
  if (generated.length > 0) {
    console.log(`  generated: ${generated.length} MDX files from YAML content`);
    for (const g of generated) {
      console.log(`    ✓ ${g.id}`);
    }
  }
  if (skipped.length > 0) {
    console.log(`  skipped: ${skipped.length} files (have custom content)`);
  }

  console.log('\nComputing derived data...');

  // Compute backlinks
  const backlinks = computeBacklinks(entities);
  database.backlinks = backlinks;
  console.log(`  backlinks: ${Object.keys(backlinks).length} entities have incoming links`);

  // Build tag index
  const tagIndex = buildTagIndex(entities);
  database.tagIndex = tagIndex;
  console.log(`  tagIndex: ${Object.keys(tagIndex).length} unique tags`);

  // Compute statistics
  const stats = computeStats(entities, backlinks, tagIndex);
  database.stats = stats;
  console.log(`  stats: computed`);

  // Build path registry from content files
  const pathRegistry = buildPathRegistry();
  database.pathRegistry = pathRegistry;
  console.log(`  pathRegistry: ${Object.keys(pathRegistry).length} paths mapped`);

  // Load canonical facts from src/data/facts/*.yaml
  const factsDir = join(DATA_DIR, 'facts');
  const facts = {};
  if (existsSync(factsDir)) {
    const factFiles = readdirSync(factsDir).filter(f => f.endsWith('.yaml'));
    let totalFacts = 0;
    for (const file of factFiles) {
      const filepath = join(factsDir, file);
      const content = readFileSync(filepath, 'utf-8');
      const parsed = parse(content);
      if (parsed && parsed.entity && parsed.facts) {
        for (const [factId, factData] of Object.entries(parsed.facts)) {
          const key = `${parsed.entity}.${factId}`;
          facts[key] = { ...factData, entity: parsed.entity, factId };
          totalFacts++;
        }
      }
    }

    // Auto-parse numeric values from value strings where not explicitly set
    for (const [key, fact] of Object.entries(facts)) {
      if (fact.numeric == null && fact.value && !fact.compute) {
        const parsed = parseNumericValue(fact.value);
        if (parsed !== null) {
          fact.numeric = parsed;
        }
      }
    }

    // Evaluate computed facts (topological order)
    const computedCount = resolveComputedFacts(facts);
    if (computedCount > 0) {
      console.log(`  facts: ${totalFacts} canonical facts (${computedCount} computed) from ${factFiles.length} files`);
    } else {
      console.log(`  facts: ${totalFacts} canonical facts from ${factFiles.length} files`);
    }
  }
  database.facts = facts;

  // Build URL → resource map for unconverted link detection
  const resources = database.resources || [];
  const urlToResource = buildUrlToResourceMap(resources);
  console.log(`  urlToResource: ${urlToResource.size} URL variations mapped`);

  // Build pages registry with frontmatter data (quality, etc.)
  const pages = buildPagesRegistry(urlToResource);

  // =========================================================================
  // CONTENT ENTITY LINKS — scan MDX for <EntityLink> references
  // Must happen before rawContent is stripped (below).
  // =========================================================================
  const entityMap = new Map(entities.map(e => [e.id, e]));
  const { inbound: contentInbound, totalLinks: contentLinkCount } = scanContentEntityLinks(pages, entityMap);

  // Merge content-derived inbound links into backlinks
  let contentBacklinksMerged = 0;
  for (const [targetId, sources] of Object.entries(contentInbound)) {
    if (!backlinks[targetId]) {
      backlinks[targetId] = [];
    }
    const existingIds = new Set(backlinks[targetId].map(b => b.id));
    for (const source of sources) {
      if (!existingIds.has(source.id)) {
        backlinks[targetId].push(source);
        contentBacklinksMerged++;
      }
    }
  }
  console.log(`  contentLinks: ${contentLinkCount} EntityLink references scanned, ${contentBacklinksMerged} new backlinks added`);

  // Re-count backlinks after merging content links
  // Enrich pages with backlink counts
  for (const page of pages) {
    const pageBacklinks = backlinks[page.id] || [];
    page.backlinkCount = pageBacklinks.length;
  }

  // Compute redundancy scores
  console.log('  Computing redundancy scores...');
  const { pageRedundancy, pairs: redundancyPairs } = computeRedundancy(pages);

  // Add redundancy data to pages and remove rawContent
  for (const page of pages) {
    const redundancy = pageRedundancy.get(page.id);
    page.redundancy = redundancy ? {
      maxSimilarity: redundancy.maxSimilarity,
      similarPages: redundancy.similarPages,
    } : {
      maxSimilarity: 0,
      similarPages: [],
    };
    // Remove internal fields to keep JSON size reasonable
    delete page.rawContent;
    delete page._fullPath;
  }

  // Store redundancy pairs for analysis
  database.redundancyPairs = redundancyPairs.slice(0, 100); // Top 100 pairs
  console.log(`  redundancy: ${redundancyPairs.length} similar pairs found`);

  // =========================================================================
  // RELATED GRAPH — unified bidirectional graph combining all signals:
  // explicit YAML, content EntityLinks, tags, similarity, name-prefix.
  // =========================================================================
  const relatedGraph = computeRelatedGraph(entities, pages, contentInbound, tagIndex);
  database.relatedGraph = relatedGraph;
  console.log(`  relatedGraph: ${Object.keys(relatedGraph).length} entities have connections`);

  // =========================================================================
  // SESSION LOG → PAGE CHANGE HISTORY
  // Parse .claude/session-log.md and .claude/sessions/*.md, then attach
  // changeHistory to each page.
  // =========================================================================
  const sessionLogPath = join(PROJECT_ROOT, '..', '.claude', 'session-log.md');
  const sessionsDir = join(PROJECT_ROOT, '..', '.claude', 'sessions');
  const pageChangeHistory = parseAllSessionLogs(sessionLogPath, sessionsDir);
  let pagesWithHistory = 0;
  for (const page of pages) {
    const history = pageChangeHistory[page.id];
    if (history && history.length > 0) {
      page.changeHistory = history;
      pagesWithHistory++;
    }
  }
  console.log(`  changeHistory: ${Object.keys(pageChangeHistory).length} pages have session history`);

  database.pages = pages;

  // =========================================================================
  // EXTEND ID REGISTRY — collect numericIds from page-only content (no entity)
  // Pages can declare numericId in MDX frontmatter. New pages get auto-assigned.
  // =========================================================================
  const entityIds = new Set(entities.map(e => e.id));
  // Skip infrastructure/internal categories — only assign IDs to real content pages
  const skipCategories = new Set([
    'internal', 'style-guides', 'schema', 'browse',
    'dashboard', 'project', 'reports', 'guides',
  ]);
  let pageIdAssignments = 0;
  for (const page of pages) {
    if (entityIds.has(page.id)) continue;        // Already has an entity (and thus an ID)
    if (slugToNumericId[page.id]) continue;       // Already in registry from entity
    if (skipCategories.has(page.category)) continue; // Infrastructure pages
    if (page.contentFormat === 'dashboard') continue; // Dashboard pages are infrastructure

    if (page.numericId) {
      // Page already has a numericId from frontmatter.
      // For generated stubs, the numericId may already be assigned to the parent
      // entity (e.g., page "epistemics" inherits E319 from entity "tmc-epistemics").
      // Just add the page slug as an alias — don't error on this.
      if (!numericIdToSlug[page.numericId]) {
        numericIdToSlug[page.numericId] = page.id;
      }
      slugToNumericId[page.id] = page.numericId;
    } else {
      // Assign a new numericId and write it back to the MDX frontmatter
      const numId = `E${nextId}`;
      numericIdToSlug[numId] = page.id;
      slugToNumericId[page.id] = numId;
      page.numericId = numId;
      nextId++;
      pageIdAssignments++;

      // Write back to MDX frontmatter
      if (page._fullPath) {
        const content = readFileSync(page._fullPath, 'utf-8');
        const updated = content.replace(/^---\n/, `---\nnumericId: ${numId}\n`);
        writeFileSync(page._fullPath, updated);
        console.log(`    Assigned ${numId} → ${page.id} (wrote to MDX frontmatter)`);
      }
    }
  }

  // Always update the registry output maps (page-only entries may have added slugs)
  const updatedRegistry = { _nextId: nextId, entities: numericIdToSlug };
  writeFileSync(ID_REGISTRY_FILE, JSON.stringify(updatedRegistry, null, 2));
  copyFileSync(ID_REGISTRY_FILE, join(OUTPUT_DIR, 'id-registry.json'));
  idRegistryOutput.byNumericId = { ...numericIdToSlug };
  idRegistryOutput.bySlug = { ...slugToNumericId };
  database.idRegistry = idRegistryOutput;
  if (pageIdAssignments > 0) {
    console.log(`  idRegistry: assigned ${pageIdAssignments} new page IDs (total: ${Object.keys(numericIdToSlug).length})`);
  }

  const pagesWithQuality = pages.filter(p => p.quality !== null).length;
  const pagesWithUnconvertedLinks = pages.filter(p => p.unconvertedLinkCount > 0).length;
  const totalUnconvertedLinks = pages.reduce((sum, p) => sum + p.unconvertedLinkCount, 0);
  console.log(`  pages: ${pages.length} pages (${pagesWithQuality} with quality ratings)`);
  console.log(`  unconvertedLinks: ${totalUnconvertedLinks} links across ${pagesWithUnconvertedLinks} pages`);

  // Load insights from src/data/insights/*.yaml
  const insightsDir = join(DATA_DIR, 'insights');
  const insightsList = [];
  if (existsSync(insightsDir)) {
    const insightFiles = readdirSync(insightsDir).filter(f => f.endsWith('.yaml'));
    for (const file of insightFiles) {
      const filepath = join(insightsDir, file);
      const content = readFileSync(filepath, 'utf-8');
      const parsed = parse(content);
      if (parsed?.insights) {
        for (const insight of parsed.insights) {
          // Compute composite score if not present
          if (insight.composite == null) {
            const scores = [insight.surprising, insight.important, insight.actionable, insight.neglected, insight.compact].filter(v => v != null);
            insight.composite = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
          }
          insightsList.push(insight);
        }
      }
    }
    console.log(`  insights: ${insightsList.length} insights from ${insightFiles.length} files`);
  }
  database.insights = insightsList;

  // Transform entities into typed entities (build-time transformation)
  console.log('\nTransforming entities...');
  const typedEntities = transformEntities(
    database.entities,
    pages,
    database.experts || [],
    database.organizations || []
  );
  database.typedEntities = typedEntities;
  console.log(`  typedEntities: ${typedEntities.length} transformed`);

  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // ==========================================================================
  // SEARCH INDEX — build MiniSearch index for client-side search
  // ==========================================================================
  console.log('\nBuilding search index...');
  const { index: searchIndex, docs: searchDocs } = buildSearchIndex(
    typedEntities,
    pages,
    idRegistryOutput
  );
  const searchIndexPath = join(OUTPUT_DIR, 'search-index.json');
  const searchDocsPath = join(OUTPUT_DIR, 'search-docs.json');
  writeFileSync(searchIndexPath, JSON.stringify(searchIndex));
  writeFileSync(searchDocsPath, JSON.stringify(searchDocs));

  // Copy search files to public/ so they're fetchable at runtime
  const publicDir = join(PROJECT_ROOT, 'public');
  if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true });
  copyFileSync(searchIndexPath, join(publicDir, 'search-index.json'));
  copyFileSync(searchDocsPath, join(publicDir, 'search-docs.json'));
  console.log(`  searchIndex: ${searchDocs.length} documents indexed`);

  // Write combined JSON (strip raw entities — only typedEntities needed at runtime)
  const { entities: _rawEntities, ...databaseForOutput } = database;
  writeFileSync(OUTPUT_FILE, JSON.stringify(databaseForOutput, null, 2));
  console.log(`\n✓ Written: ${OUTPUT_FILE} (raw entities stripped, typedEntities only)`);

  // Also write individual JSON files for selective imports
  for (const { key, file, dir } of DATA_FILES) {
    const jsonFile = dir ? `${key}.json` : file.replace('.yaml', '.json');
    writeFileSync(join(OUTPUT_DIR, jsonFile), JSON.stringify(database[key], null, 2));
  }

  // Write derived data as separate files too
  writeFileSync(join(OUTPUT_DIR, 'backlinks.json'), JSON.stringify(backlinks, null, 2));
  writeFileSync(join(OUTPUT_DIR, 'tagIndex.json'), JSON.stringify(tagIndex, null, 2));
  writeFileSync(join(OUTPUT_DIR, 'stats.json'), JSON.stringify(stats, null, 2));
  writeFileSync(join(OUTPUT_DIR, 'pathRegistry.json'), JSON.stringify(pathRegistry, null, 2));
  writeFileSync(join(OUTPUT_DIR, 'pages.json'), JSON.stringify(pages, null, 2));
  writeFileSync(join(OUTPUT_DIR, 'relatedGraph.json'), JSON.stringify(relatedGraph, null, 2));

  console.log('✓ Written individual JSON files');
  console.log('✓ Written derived data files (backlinks, tagIndex, stats, pathRegistry)');

  // Generate link health data
  console.log('\nGenerating link health data...');
  const linkHealthPath = join(OUTPUT_DIR, 'link-health.json');
  const linkValidation = spawnSync('node', [
    'scripts/validate/validate-internal-links.mjs',
    '--ci',
    `--output=${linkHealthPath}`
  ], { encoding: 'utf-8', cwd: process.cwd() });

  if (linkValidation.status === 0 || linkValidation.status === 1) {
    // Exit 0 = all valid, Exit 1 = broken links found
    // Both are acceptable for data generation
    console.log('✓ Link health data generated');
  } else {
    console.error('⚠️  Link health generation failed:', linkValidation.stderr);
  }

  // Print summary stats
  console.log('\n--- Summary ---');
  console.log(`Total entities: ${stats.totalEntities}`);
  console.log(`With descriptions: ${stats.withDescription}`);
  console.log(`Unique tags: ${stats.totalTags}`);
  console.log(`Top types: ${Object.entries(stats.byType).slice(0, 5).map(([t, c]) => `${t}(${c})`).join(', ')}`);

  // ==========================================================================
  // Copy canonical schema.ts to app output directory
  // ==========================================================================
  const SCHEMA_SRC = join(DATA_DIR, 'schema.ts');
  copyFileSync(SCHEMA_SRC, join(OUTPUT_DIR, 'schema.ts'));
  console.log('✓ Copied data/schema.ts → app/src/data/schema.ts');

  // ==========================================================================
  // LLM Accessibility Files
  // ==========================================================================
  generateLLMFiles();

  // ==========================================================================
  // Zod Schema Validation
  // ==========================================================================
  console.log('\n--- Zod Schema Validation ---');
  console.log('Run `npm run validate:schema` to validate data against Zod schemas');
  console.log('Or run `npm run validate` for all validators');
}

main();
