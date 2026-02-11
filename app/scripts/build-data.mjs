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
            bulletRatio: Math.round(metrics.bulletRatio * 100) / 100,
            sectionCount: metrics.sectionCount.total,
            hasOverview: metrics.hasOverview,
            structuralScore: metrics.structuralScore,
          },
          // Suggested quality based on structure
          suggestedQuality: suggestQuality(metrics.structuralScore, fm),
          // Update frequency (days between updates)
          updateFrequency: fm.update_frequency ? parseInt(fm.update_frequency) : null,
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
  // ID REGISTRY — assign stable numeric IDs (E1, E2, ...) to every entity
  // =========================================================================
  const ID_REGISTRY_FILE = join(DATA_DIR, 'id-registry.json');
  let idRegistry = { _nextId: 1, entities: {} };
  if (existsSync(ID_REGISTRY_FILE)) {
    idRegistry = JSON.parse(readFileSync(ID_REGISTRY_FILE, 'utf-8'));
  }

  // Build reverse map: slug → numericId
  const slugToNumericId = {};
  for (const [numId, slug] of Object.entries(idRegistry.entities)) {
    slugToNumericId[slug] = numId;
  }

  // Assign IDs to any new entities not yet in the registry
  let newAssignments = 0;
  for (const entity of entities) {
    if (!slugToNumericId[entity.id]) {
      const numId = `E${idRegistry._nextId}`;
      idRegistry.entities[numId] = entity.id;
      slugToNumericId[entity.id] = numId;
      idRegistry._nextId++;
      newAssignments++;
    }
    // Attach numericId to entity object
    entity.numericId = slugToNumericId[entity.id];
  }

  // Save updated registry
  if (newAssignments > 0) {
    writeFileSync(ID_REGISTRY_FILE, JSON.stringify(idRegistry, null, 2));
    console.log(`  idRegistry: assigned ${newAssignments} new IDs (total: ${Object.keys(idRegistry.entities).length})`);
  } else {
    console.log(`  idRegistry: all ${Object.keys(idRegistry.entities).length} entities have IDs`);
  }

  // Copy id-registry.json to app output directory for consistency
  copyFileSync(ID_REGISTRY_FILE, join(OUTPUT_DIR, 'id-registry.json'));
  console.log(`  idRegistry: copied to ${join(OUTPUT_DIR, 'id-registry.json')}`);

  // Build lookup maps for database output
  const idRegistryOutput = {
    byNumericId: { ...idRegistry.entities },
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
    // Remove rawContent to keep JSON size reasonable
    delete page.rawContent;
  }

  // Store redundancy pairs for analysis
  database.redundancyPairs = redundancyPairs.slice(0, 100); // Top 100 pairs
  console.log(`  redundancy: ${redundancyPairs.length} similar pairs found`);

  database.pages = pages;

  // =========================================================================
  // EXTEND ID REGISTRY — assign numeric IDs to page-only content (no entity)
  // This ensures table/diagram/index pages get E-prefixed IDs like all entities.
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
    if (slugToNumericId[page.id]) continue;       // Already in registry
    if (skipCategories.has(page.category)) continue; // Infrastructure pages
    if (page.contentFormat === 'dashboard') continue; // Dashboard pages are infrastructure
    const numId = `E${idRegistry._nextId}`;
    idRegistry.entities[numId] = page.id;
    slugToNumericId[page.id] = numId;
    idRegistry._nextId++;
    pageIdAssignments++;
  }
  if (pageIdAssignments > 0) {
    writeFileSync(ID_REGISTRY_FILE, JSON.stringify(idRegistry, null, 2));
    copyFileSync(ID_REGISTRY_FILE, join(OUTPUT_DIR, 'id-registry.json'));
    // Update the registry output maps
    idRegistryOutput.byNumericId = { ...idRegistry.entities };
    idRegistryOutput.bySlug = { ...slugToNumericId };
    database.idRegistry = idRegistryOutput;
    console.log(`  idRegistry: assigned ${pageIdAssignments} new page IDs (total: ${Object.keys(idRegistry.entities).length})`);
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
