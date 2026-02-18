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
import { extractMetrics, suggestQuality, getQualityDiscrepancy } from '../../crux/lib/metrics-extractor.ts';
import { computeRedundancy } from './lib/redundancy.mjs';
import { CONTENT_DIR, DATA_DIR, OUTPUT_DIR, PROJECT_ROOT, TOP_LEVEL_CONTENT_DIRS } from './lib/content-types.mjs';
import { generateLLMFiles } from './generate-llm-files.mjs';
import { buildUrlToResourceMap, findUnconvertedLinks, countConvertedLinks } from './lib/unconverted-links.mjs';
import { generateMdxFromYaml } from './lib/mdx-generator.mjs';
import { computeStats } from './lib/statistics.mjs';
import { parseNumericValue, resolveComputedFacts } from './lib/computed-facts.mjs';
import { transformEntities } from './lib/entity-transform.mjs';
import { scanFrontmatterEntities } from './lib/frontmatter-scanner.mjs';
import { buildSearchIndex } from './lib/search.mjs';
import { parseAllSessionLogs } from './lib/session-log-parser.mjs';
import { fetchBranchToPrMap, enrichWithPrNumbers, fetchPrItems } from './lib/github-pr-lookup.mjs';
import { detectReassignments, scanEntityLinkRefs, formatReassignments } from './lib/id-stability.mjs';

// ---------------------------------------------------------------------------
// Structured value formatting — converts numeric fact values to display strings
// ---------------------------------------------------------------------------

/** Format a single number into a human-readable string using measure context */
function formatFactNumber(n, measure) {
  if (measure?.unit === 'USD') {
    if (Math.abs(n) >= 1e12) return `$${cleanDecimal(n / 1e12)} trillion`;
    if (Math.abs(n) >= 1e9) return `$${cleanDecimal(n / 1e9)} billion`;
    if (Math.abs(n) >= 1e6) return `$${cleanDecimal(n / 1e6)} million`;
    return `$${n.toLocaleString('en-US')}`;
  }
  if (measure?.unit === 'percent') return `${cleanDecimal(n)}%`;
  if (measure?.unit === 'count') {
    if (Math.abs(n) >= 1e9) return `${cleanDecimal(n / 1e9)} billion`;
    if (Math.abs(n) >= 1e6) return `${cleanDecimal(n / 1e6)} million`;
    return n.toLocaleString('en-US');
  }
  // Fallback for other units
  if (Math.abs(n) >= 1e9) return `${cleanDecimal(n / 1e9)} billion`;
  if (Math.abs(n) >= 1e6) return `${cleanDecimal(n / 1e6)} million`;
  return n.toLocaleString('en-US');
}

/** Format a [low, high] range into a human-readable string */
function formatFactRange(lo, hi, measure) {
  if (measure?.unit === 'percent') return `${cleanDecimal(lo)}-${cleanDecimal(hi)}%`;
  if (measure?.unit === 'USD') {
    // Same scale: "$20-26 billion"
    if (lo >= 1e9 && hi >= 1e9) return `$${cleanDecimal(lo / 1e9)}-${cleanDecimal(hi / 1e9)} billion`;
    if (lo >= 1e6 && hi >= 1e6) return `$${cleanDecimal(lo / 1e6)}-${cleanDecimal(hi / 1e6)} million`;
    return `$${lo.toLocaleString('en-US')}-$${hi.toLocaleString('en-US')}`;
  }
  if (measure?.unit === 'count') {
    if (lo >= 1e6 && hi >= 1e6) return `${cleanDecimal(lo / 1e6)}-${cleanDecimal(hi / 1e6)} million`;
    return `${lo.toLocaleString('en-US')}-${hi.toLocaleString('en-US')}`;
  }
  return `${lo.toLocaleString('en-US')}-${hi.toLocaleString('en-US')}`;
}

/** Remove trailing .0 from formatted numbers: 380.0 → "380", 2.5 → "2.5" */
function cleanDecimal(n) {
  return n % 1 === 0 ? String(n) : n.toFixed(1);
}

const OUTPUT_FILE = join(OUTPUT_DIR, 'database.json');

// Entity type alias map: legacy YAML type names → canonical types
// Keep in sync with app/src/data/entity-type-names.ts
const ENTITY_TYPE_ALIASES = {
  researcher: 'person', lab: 'organization',
  'lab-frontier': 'organization', 'lab-research': 'organization',
  'lab-academic': 'organization', 'lab-startup': 'organization',
  'safety-approaches': 'safety-agenda', policies: 'policy',
  concepts: 'concept', events: 'event', models: 'model',
};

// Files to combine
const DATA_FILES = [
  { key: 'experts', file: 'experts.yaml' },
  { key: 'organizations', file: 'organizations.yaml' },
  { key: 'estimates', file: 'estimates.yaml' },
  { key: 'cruxes', file: 'cruxes.yaml' },
  { key: 'interventions', file: 'interventions.yaml' },
  { key: 'proposals', file: 'proposals.yaml' },
  { key: 'glossary', file: 'glossary.yaml' },
  { key: 'entities', dir: 'entities' }, // Split by entity type
  { key: 'literature', file: 'literature.yaml' },
  { key: 'funders', file: 'funders.yaml' },
  { key: 'resources', dir: 'resources' }, // Split into multiple files
  { key: 'publications', file: 'publications.yaml' },
  { key: 'parameterGraph', file: 'parameter-graph.yaml', isObject: true }, // Graph structure (not array)
];

function loadYaml(filename) {
  const filepath = join(DATA_DIR, filename);
  if (!existsSync(filepath)) {
    console.warn(`File not found: ${filepath}`);
    return [];
  }
  try {
    const content = readFileSync(filepath, 'utf-8');
    return parse(content) || [];
  } catch (e) {
    console.error(`Failed to parse YAML ${filepath}: ${e.message}`);
    process.exitCode = 1;
    return [];
  }
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
    try {
      const content = readFileSync(filepath, 'utf-8');
      const data = parse(content) || [];
      merged.push(...data);
    } catch (e) {
      console.error(`Failed to parse YAML ${filepath}: ${e.message}`);
      process.exitCode = 1;
    }
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
 * Check ID stability — detect silent numeric ID reassignments (issue #148).
 * Compares current slug↔ID mappings against a previous registry snapshot.
 * If reassignments are found, reports them with affected EntityLink references
 * and exits with an error.
 *
 * @param {Object|null} prevRegistry  Previous id-registry.json content
 * @param {Object} numericIdToSlug  Current mapping: numericId → slug
 * @param {Object} slugToNumericId  Current mapping: slug → numericId
 * @param {boolean} allowReassignment  If true, skip the check
 * @param {string} phase  Label for error messages ('entity' or 'page')
 */
function checkIdStability(prevRegistry, numericIdToSlug, slugToNumericId, allowReassignment, phase) {
  if (!prevRegistry?.entities || allowReassignment) return;

  const reassignments = detectReassignments(prevRegistry, numericIdToSlug, slugToNumericId);
  if (reassignments.length === 0) return;

  console.error(`\n  ERROR: Numeric ID reassignment detected at ${phase} level! (issue #148)`);
  console.error('  The following IDs changed between builds:\n');

  const { lines, affectedIds } = formatReassignments(reassignments);
  for (const line of lines) {
    console.error(`  ${line}`);
  }

  const CONTENT_SCAN_DIR = join(PROJECT_ROOT, '..', 'content', 'docs');
  const brokenRefs = scanEntityLinkRefs(CONTENT_SCAN_DIR, affectedIds);

  if (brokenRefs.length > 0) {
    console.error(`\n  ${brokenRefs.length} EntityLink reference(s) would break:\n`);
    for (const ref of brokenRefs) {
      const relPath = relative(CONTENT_SCAN_DIR, ref.file);
      console.error(`    ${relPath}:${ref.line} — id="${ref.id}"`);
    }
  }

  console.error('\n  To fix: restore the original numericId values in source files.');
  console.error('  To override: re-run with --allow-id-reassignment\n');
  process.exit(1);
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
function scanContentEntityLinks(pages, entityMap, numericIdToSlug) {
  const inbound = {};
  let totalLinks = 0;

  for (const page of pages) {
    if (!page.rawContent) continue;

    const regex = /<EntityLink\s+[^>]*id="([^"]+)"/g;
    let match;
    const seen = new Set();

    while ((match = regex.exec(page.rawContent)) !== null) {
      let targetId = match[1];
      // Resolve numeric IDs (e.g. "E22") to slug IDs (e.g. "anthropic")
      if (numericIdToSlug && numericIdToSlug[targetId]) {
        targetId = numericIdToSlug[targetId];
      }
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
 * based on the target page's quality and readerImportance ratings:
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
        const imp = targetPage?.readerImportance ?? 50;
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

        // Index files use __index__ slug and are marked for ID registration only
        const isIndexFile = (id === 'index');
        const effectiveId = isIndexFile ? `__index__${urlPrefix}` : id;

        const urlPath = isIndexFile ? `${urlPrefix}/` : `${urlPrefix}/${id}/`;

        // Extract structural metrics (format-aware scoring)
        const contentFormat = fm.contentFormat || 'article';
        const metrics = extractMetrics(content, fullPath, contentFormat);
        const currentQuality = fm.quality != null ? Number(fm.quality) : null;

        // Find unconverted links (markdown links that have matching resources)
        const unconvertedLinks = urlToResource ? findUnconvertedLinks(content, urlToResource) : [];

        // Count already converted links (<R> components)
        const convertedLinkCount = countConvertedLinks(content);

        pages.push({
          id: effectiveId,
          numericId: fm.numericId || null,
          _fullPath: fullPath,
          path: urlPath,
          filePath: relative(CONTENT_DIR, fullPath),
          title: fm.title || id.replace(/-/g, ' '),
          quality: currentQuality,
          readerImportance: fm.readerImportance != null ? Number(fm.readerImportance) : null,
          researchImportance: fm.researchImportance != null ? Number(fm.researchImportance) : null,
          // Content format: article (default), table, diagram, index, dashboard
          contentFormat: fm.contentFormat || 'article',
          // ITN framework fields (0-100 scale)
          tractability: fm.tractability != null ? Number(fm.tractability) : null,
          neglectedness: fm.neglectedness != null ? Number(fm.neglectedness) : null,
          uncertainty: fm.uncertainty != null ? Number(fm.uncertainty) : null,
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

  for (const topDir of TOP_LEVEL_CONTENT_DIRS) {
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
  for (const topDir of TOP_LEVEL_CONTENT_DIRS) {
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


/**
 * Compute hallucination risk score for a page.
 *
 * Returns { level: 'low'|'medium'|'high', score: 0-100, factors: string[] }
 *
 * The factors array explains WHY the risk is at its level, making this useful
 * for both reader-facing warnings and AI agents that need to prioritize pages
 * for verification. Higher score = higher risk.
 *
 * @param {object} page  – page object from buildPagesRegistry (with metrics, ratings, etc.)
 * @param {Map}    entityMap – Map<entityId, entity> from YAML data
 */
function computeHallucinationRisk(page, entityMap) {
  let score = 40; // baseline: medium risk (all content is AI-generated)
  const factors = [];

  // Resolve entity type (YAML entity takes precedence, then page frontmatter)
  const entity = entityMap.get(page.id);
  const rawType = entity?.type || null;

  // Normalize legacy type aliases → canonical types
  const entityType = ENTITY_TYPE_ALIASES[rawType] || rawType;

  // Type categories for risk assessment
  const BIOGRAPHICAL_TYPES = new Set(['person', 'organization', 'funder']);
  const FACTUAL_TYPES = new Set(['event', 'historical', 'case-study']);
  const STRUCTURAL_TYPES = new Set([
    'concept', 'approach', 'safety-agenda', 'intelligence-paradigm',
    'crux', 'debate', 'argument',
  ]);
  const LOW_RISK_FORMATS = new Set(['table', 'diagram', 'index', 'dashboard']);

  // === RISK-INCREASING FACTORS ===

  // Biographical pages: specific claims about real people/orgs are highly hallucination-prone
  if (entityType && BIOGRAPHICAL_TYPES.has(entityType)) {
    score += 20;
    factors.push('biographical-claims');
  }

  // Factual/historical pages: specific dates, events, numbers
  if (entityType && FACTUAL_TYPES.has(entityType)) {
    score += 15;
    factors.push('specific-factual-claims');
  }

  // Citation density analysis
  const wordCount = page.metrics?.wordCount || 0;
  const footnoteCount = page.metrics?.footnoteCount || 0;
  const citationDensity = wordCount > 0 ? (footnoteCount / wordCount) * 1000 : 0;

  if (footnoteCount === 0 && wordCount > 300) {
    score += 15;
    factors.push('no-citations');
  } else if (citationDensity < 2 && wordCount > 500) {
    score += 10;
    factors.push('low-citation-density');
  }

  // Low rigor score
  const rigor = page.ratings?.rigor;
  if (rigor != null && rigor < 4) {
    score += 10;
    factors.push('low-rigor-score');
  }

  // Low quality score
  if (page.quality != null && page.quality < 40) {
    score += 5;
    factors.push('low-quality-score');
  }

  // Few external sources
  const externalLinks = page.metrics?.externalLinks || 0;
  if (externalLinks < 2 && wordCount > 500) {
    score += 5;
    factors.push('few-external-sources');
  }

  // === RISK-DECREASING FACTORS ===

  // High citation density
  if (citationDensity > 8) {
    score -= 15;
    factors.push('well-cited');
  } else if (citationDensity > 4) {
    score -= 10;
    factors.push('moderately-cited');
  }

  // High rigor
  if (rigor != null && rigor >= 7) {
    score -= 15;
    factors.push('high-rigor');
  }

  // Structural/conceptual content: less prone to specific factual errors
  if (entityType && STRUCTURAL_TYPES.has(entityType)) {
    score -= 10;
    factors.push('conceptual-content');
  }

  // Low-risk content formats (tables, diagrams, indices)
  if (LOW_RISK_FORMATS.has(page.contentFormat)) {
    score -= 15;
    factors.push('structured-format');
  }

  // Minimal content (stubs have less room for errors)
  if (wordCount < 300) {
    score -= 10;
    factors.push('minimal-content');
  }

  // High quality suggests more care during generation
  if (page.quality != null && page.quality >= 80) {
    score -= 5;
    factors.push('high-quality');
  }

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  // Bucket into levels
  let level;
  if (score <= 30) level = 'low';
  else if (score <= 60) level = 'medium';
  else level = 'high';

  return { level, score, factors };
}

async function main() {
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
  const ALLOW_ID_REASSIGNMENT = process.argv.includes('--allow-id-reassignment');

  // Load previous registry for stability check (before overwriting)
  let prevRegistry = null;
  if (existsSync(ID_REGISTRY_FILE)) {
    try {
      prevRegistry = JSON.parse(readFileSync(ID_REGISTRY_FILE, 'utf-8'));
    } catch {
      // Corrupted registry — will be regenerated
    }
  }

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

  // -------------------------------------------------------------------------
  // ID Stability Check (entity-level) — detect silent reassignments (#148)
  // -------------------------------------------------------------------------
  checkIdStability(prevRegistry, numericIdToSlug, slugToNumericId, ALLOW_ID_REASSIGNMENT, 'entity');

  // Compute next available ID from existing assignments.
  // Also scan page-level numericIds (from MDX frontmatter) so auto-assigned
  // entity IDs don't collide with IDs that pages already claim.
  let nextId = 1;
  for (const numId of Object.keys(numericIdToSlug)) {
    const n = parseInt(numId.slice(1));
    if (n >= nextId) nextId = n + 1;
  }
  // Quick scan: collect numericIds already declared in MDX frontmatter across
  // all content directories. This prevents auto-assigned entity IDs from
  // colliding with page-level IDs that haven't been registered as entities yet.
  const CONTENT_DIR_ROOT = join(PROJECT_ROOT, '..', 'content', 'docs');
  function scanFrontmatterNumericIds(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scanFrontmatterNumericIds(join(dir, entry.name));
      } else if (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')) {
        const content = readFileSync(join(dir, entry.name), 'utf-8');
        const match = content.match(/^numericId:\s*(E\d+)/m);
        if (match) {
          const n = parseInt(match[1].slice(1));
          if (n >= nextId) nextId = n + 1;
        }
      }
    }
  }
  scanFrontmatterNumericIds(CONTENT_DIR_ROOT);

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

    console.log(`  facts: ${totalFacts} canonical facts from ${factFiles.length} files`);
  }

  // Load fact measure definitions from data/fact-measures.yaml (needed for value normalization)
  const factMeasuresPath = join(DATA_DIR, 'fact-measures.yaml');
  const factMeasures = {};
  if (existsSync(factMeasuresPath)) {
    const measuresContent = readFileSync(factMeasuresPath, 'utf-8');
    const measuresParsed = parse(measuresContent);
    if (measuresParsed && measuresParsed.measures) {
      for (const [measureId, measureDef] of Object.entries(measuresParsed.measures)) {
        factMeasures[measureId] = { id: measureId, ...measureDef };
      }
    }
    console.log(`  factMeasures: ${Object.keys(factMeasures).length} measure definitions`);
  }
  database.factMeasures = factMeasures;

  // Auto-infer measure from fact ID where not explicitly set
  // Algorithm: 1) exact match against known measure IDs, 2) longest prefix match (factId starts with "<measure>-")
  const knownMeasureIds = Object.keys(factMeasures);
  let autoInferredCount = 0;
  for (const [key, fact] of Object.entries(facts)) {
    // Skip if measure is already set (truthy) or explicitly null (opt-out via `measure: ~`)
    if (fact.measure || fact.noCompute || ('measure' in fact && fact.measure === null)) continue;
    // 1. Exact match: fact ID is a known measure name
    if (knownMeasureIds.includes(fact.factId)) {
      fact.measure = fact.factId;
      autoInferredCount++;
      continue;
    }
    // 2. Longest prefix match: fact ID starts with "<measure>-"
    let bestMatch = null;
    let bestLen = 0;
    for (const measureId of knownMeasureIds) {
      if (fact.factId.startsWith(measureId + '-') && measureId.length > bestLen) {
        bestMatch = measureId;
        bestLen = measureId.length;
      }
    }
    if (bestMatch) {
      fact.measure = bestMatch;
      autoInferredCount++;
    }
  }
  if (autoInferredCount > 0) {
    console.log(`  measures: auto-inferred ${autoInferredCount} measures from fact IDs`);
  }

  // Normalize structured values → flat format (value string, numeric, low, high)
  // Structured values: number, [low, high], { min: N }
  // After normalization, fact.value is always a display string and numeric/low/high are numbers.
  let structuredCount = 0;
  for (const [key, fact] of Object.entries(facts)) {
    const val = fact.value;
    const measure = fact.measure ? factMeasures[fact.measure] : null;

    if (typeof val === 'number') {
      // Precise numeric value — derive display string from measure
      if (measure?.unit === 'percent') {
        fact.numeric = val / 100;  // 40 → 0.4 for computation
      } else {
        fact.numeric = val;
      }
      fact.value = formatFactNumber(val, measure);
      structuredCount++;

    } else if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'number') {
      // Range [low, high]
      const [lo, hi] = val;
      if (measure?.unit === 'percent') {
        fact.low = lo / 100;
        fact.high = hi / 100;
        fact.numeric = (lo + hi) / 200;
      } else {
        fact.low = lo;
        fact.high = hi;
        fact.numeric = (lo + hi) / 2;
      }
      fact.value = formatFactRange(lo, hi, measure);
      structuredCount++;

    } else if (val && typeof val === 'object' && !Array.isArray(val) && 'min' in val) {
      // Lower bound { min: N }
      const n = val.min;
      if (measure?.unit === 'percent') {
        fact.numeric = n / 100;
      } else {
        fact.numeric = n;
      }
      fact.value = formatFactNumber(n, measure) + '+';
      structuredCount++;

    } else if (typeof val === 'string') {
      // Legacy string value — auto-parse numeric where possible
      if (fact.numeric == null && !fact.compute) {
        const parsed = parseNumericValue(val);
        if (parsed !== null) {
          fact.numeric = parsed;
        }
      }
    }
  }
  if (structuredCount > 0) {
    console.log(`  values: normalized ${structuredCount} structured values`);
  }

  // Evaluate computed facts (topological order) — must happen after value normalization
  {
    const computedCount = resolveComputedFacts(facts);
    if (computedCount > 0) {
      console.log(`  computed: ${computedCount} facts resolved`);
    }
  }
  database.facts = facts;

  // Build timeseries index: group facts by measure, sorted chronologically
  // Facts with a `subject` override are excluded from the parent entity's timeseries
  // (they represent benchmarks/comparisons, not entity-owned data)
  const factTimeseries = {};
  for (const [key, fact] of Object.entries(facts)) {
    if (!fact.measure || !fact.asOf) continue;
    if (fact.subject) continue; // Skip benchmark/comparison facts
    if (!factTimeseries[fact.measure]) {
      factTimeseries[fact.measure] = [];
    }
    factTimeseries[fact.measure].push({
      entity: fact.entity,
      factId: fact.factId,
      measure: fact.measure,
      asOf: fact.asOf,
      value: fact.value,
      numeric: fact.numeric,
      low: fact.low,
      high: fact.high,
      note: fact.note,
      source: fact.source,
    });
  }
  // Sort each timeseries chronologically (oldest first)
  for (const series of Object.values(factTimeseries)) {
    series.sort((a, b) => a.asOf.localeCompare(b.asOf));
  }
  const timeseriesCount = Object.values(factTimeseries).reduce((sum, s) => sum + s.length, 0);
  console.log(`  factTimeseries: ${timeseriesCount} observations across ${Object.keys(factTimeseries).length} measures`);
  database.factTimeseries = factTimeseries;

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
  // Pre-populate numericIdToSlug with page-level numericIds (pages that aren't
  // YAML entities but have numericId in frontmatter). This ensures numeric IDs
  // like "E660" resolve to slugs like "factors-ai-capabilities-overview" when
  // scanning EntityLink references below.
  // Also detect conflicts where a page claims a numericId already owned by an entity.
  const pageIdConflicts = [];
  for (const page of pages) {
    if (page.numericId) {
      const existing = numericIdToSlug[page.numericId];
      if (existing && existing !== page.id) {
        // Check if this is a legitimate alias: the entity's path maps to this page
        // (e.g. entity "tmc-epistemics" renders at page "epistemics")
        const entityPath = pathRegistry[existing];
        if (entityPath && entityPath.endsWith(`/${page.id}/`)) {
          // Entity maps to this page — they're the same content, just add alias
          slugToNumericId[page.id] = page.numericId;
        } else {
          pageIdConflicts.push(`${page.numericId} claimed by entity "${existing}" and page "${page.id}"`);
        }
      } else {
        numericIdToSlug[page.numericId] = page.id;
      }
    }
  }
  if (pageIdConflicts.length > 0) {
    console.error('\n  ERROR: numericId conflicts between entities and pages:');
    for (const c of pageIdConflicts) console.error(`    ${c}`);
    process.exit(1);
  }

  const entityMap = new Map(entities.map(e => [e.id, e]));
  const { inbound: contentInbound, totalLinks: contentLinkCount } = scanContentEntityLinks(pages, entityMap, numericIdToSlug);

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
  // HALLUCINATION RISK — compute per-page risk score from structural signals.
  // Used by both reader-facing banners and AI agents for verification triage.
  // =========================================================================
  console.log('  Computing hallucination risk scores...');
  let riskHigh = 0, riskMedium = 0, riskLow = 0;
  for (const page of pages) {
    const risk = computeHallucinationRisk(page, entityMap);
    page.hallucinationRisk = risk;

    // Also attach resolved entityType for frontend use
    const entity = entityMap.get(page.id);
    if (entity?.type) {
      page.entityType = ENTITY_TYPE_ALIASES[entity.type] || entity.type;
    }

    if (risk.level === 'high') riskHigh++;
    else if (risk.level === 'medium') riskMedium++;
    else riskLow++;
  }
  console.log(`  hallucinationRisk: ${riskHigh} high, ${riskMedium} medium, ${riskLow} low`);

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

  // Auto-populate PR numbers from GitHub API for entries that don't have them
  const branchToPr = await fetchBranchToPrMap();
  const prEnriched = enrichWithPrNumbers(pageChangeHistory, branchToPr);
  if (branchToPr.size > 0) {
    console.log(`  changeHistory: enriched ${prEnriched} entries with PR numbers (${branchToPr.size} PRs fetched)`);
  }

  let pagesWithHistory = 0;
  for (const page of pages) {
    const history = pageChangeHistory[page.id];
    if (history && history.length > 0) {
      page.changeHistory = history;
      pagesWithHistory++;
    }
  }
  console.log(`  changeHistory: ${Object.keys(pageChangeHistory).length} pages have session history`);

  // =========================================================================
  // PR DESCRIPTIONS — full PR metadata for the dashboard
  // =========================================================================
  const prItems = await fetchPrItems();
  database.prItems = prItems;
  console.log(`  prItems: ${prItems.length} PRs fetched for dashboard`);

  database.pages = pages;

  // =========================================================================
  // EXTEND ID REGISTRY — collect numericIds from page-only content (no entity)
  // Pages can declare numericId in MDX frontmatter. New pages get auto-assigned.
  // =========================================================================
  const entityIds = new Set(entities.map(e => e.id));
  // Skip infrastructure categories — only assign IDs to non-content pages
  // Note: 'internal', 'reports', 'schema' removed — internal pages now get entity IDs
  const skipCategories = new Set([
    'style-guides', 'browse',
    'dashboard', 'project', 'guides',
  ]);
  let pageIdAssignments = 0;
  // Pass 1: Collect existing page-level numericIds from frontmatter
  for (const page of pages) {
    if (entityIds.has(page.id)) continue;
    if (slugToNumericId[page.id]) continue;
    if (skipCategories.has(page.category)) continue;
    if (page.contentFormat === 'dashboard') continue;

    if (page.numericId) {
      // Page already has a numericId from frontmatter.
      // Check for conflicts: another entity/page may already own this numericId.
      const existingOwner = numericIdToSlug[page.numericId];
      if (existingOwner && existingOwner !== page.id) {
        // For generated stubs, the numericId may already be assigned to the parent
        // entity (e.g., page "epistemics" inherits E319 from entity "tmc-epistemics").
        // That's fine — just log a warning. But if they're unrelated, it's a real conflict.
        console.warn(`    WARNING: ${page.numericId} claimed by "${existingOwner}" and page "${page.id}" — keeping "${existingOwner}"`);
      }
      if (!numericIdToSlug[page.numericId]) {
        numericIdToSlug[page.numericId] = page.id;
      }
      slugToNumericId[page.id] = page.numericId;
    }
  }

  // ID Stability Check (page-level) — now both entity and page IDs are
  // collected, compare the full set against the previous registry (#148)
  checkIdStability(prevRegistry, numericIdToSlug, slugToNumericId, ALLOW_ID_REASSIGNMENT, 'page');

  // Pass 2: Assign new numericIds to pages that don't have one yet
  for (const page of pages) {
    if (entityIds.has(page.id)) continue;
    if (slugToNumericId[page.id]) continue;
    if (skipCategories.has(page.category)) continue;
    if (page.contentFormat === 'dashboard') continue;

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

main().catch(err => {
  console.error(err);
  process.exit(1);
});
