/**
 * Build Data Script
 *
 * Converts YAML files to JSON for browser import.
 * Also computes backlinks, tag index, and statistics.
 * Run this before building the site.
 *
 * Usage: node scripts/build-data.mjs [options]
 *
 * Flags:
 *   --scope=content  Skip expensive non-content steps (git dates, block IR,
 *                    redundancy, server sync, LLM files). Produces a valid
 *                    database.json for local dev but omits dashboard data.
 *   --quick          Alias for --scope=content
 *   --phase=<name>   Run only a specific phase (for debugging). Valid names:
 *                    yaml, ids, mdx, derived, facts, kb, pages, links, blocks,
 *                    risk, resources, footnotes, refs, redundancy, graph,
 *                    history, coverage, rankings, schedule, transform, write
*/

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, basename, relative } from 'path';
import { parse } from 'yaml';
import { extractMetrics, suggestQuality, getQualityDiscrepancy } from '../../../crux/lib/metrics-extractor.ts';
import { computeHallucinationRisk as computeCanonicalRisk, resolveEntityType } from '../../../crux/lib/hallucination-risk.ts';
import { syncPageLinks } from './lib/links-client.mjs';
import { filterBulkImportDates } from './lib/git-date-utils.mjs';
import { computeRedundancy } from './lib/redundancy.mjs';
import { CONTENT_DIR, DATA_DIR, OUTPUT_DIR, PROJECT_ROOT, REPO_ROOT, TOP_LEVEL_CONTENT_DIRS } from './lib/content-types.mjs';
import { generateLLMFiles } from './generate-llm-files.mjs';
import { buildUrlToResourceMap, findUnconvertedLinks, countConvertedLinks } from './lib/unconverted-links.mjs';
import { generateMdxFromYaml } from './lib/mdx-generator.mjs';
import { computeStats } from './lib/statistics.mjs';
import { transformEntities } from './lib/entity-transform.mjs';
import { scanFrontmatterEntities } from './lib/frontmatter-scanner.mjs';
import { parseAllSessionLogs } from './lib/session-log-parser.mjs';
import { fetchBranchToPrMap, enrichWithPrNumbers, fetchPrItems } from './lib/github-pr-lookup.mjs';
import { computePageCoverage } from '../../../crux/lib/page-coverage.ts';
import { parseFootnoteSources } from '../../../crux/lib/footnote-parser.ts';
import { buildIdRegistry, extendIdRegistryWithPages } from './lib/id-registry.mjs';
import { computePageRankings, computeRecommendedScores, buildUpdateSchedule } from './lib/page-rankings.mjs';
import { loadFacts, loadFactMeasures, normalizeFactValues, enrichFactSources, buildFactTimeseries } from './lib/facts-loader.mjs';
import { computeAllHallucinationRisks, syncRiskSnapshots } from './lib/hallucination-risk-build.mjs';

// ---------------------------------------------------------------------------
// Scope flag — `--scope=content` or `--quick` skips expensive non-content steps
// ---------------------------------------------------------------------------
const hasQuickFlag = process.argv.includes('--quick');
const SCOPE = hasQuickFlag ? 'content' : (process.argv.find(a => a.startsWith('--scope='))?.split('=')[1] || 'full');
const CONTENT_ONLY = SCOPE === 'content';

if (CONTENT_ONLY) {
  console.log('⚡ Running in content-only scope (skipping git dates, block IR, redundancy, server sync, LLM files)\n');
}

const OUTPUT_FILE = join(OUTPUT_DIR, 'database.json');

// Entity type alias map: legacy YAML type names → canonical types
// Keep in sync with apps/web/src/data/entity-type-names.ts
// Entity type alias resolution now handled by resolveEntityType from hallucination-risk.ts

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
 * Scan MDX content for <F e="..." f="..."> references.
 * Returns a reverse index: factKey ("entity.factId") -> array of pages using it.
 * Must be called before rawContent is stripped from pages.
 */
function scanFactUsage(pages) {
  /** @type {Record<string, {id: string, title: string, path: string}[]>} */
  const usage = {};
  let totalRefs = 0;

  for (const page of pages) {
    if (!page.rawContent) continue;

    // Match both attribute orderings: <F e="x" f="y"> and <F f="y" e="x">
    const regexEF = /<F\s[^>]*e="([^"]+)"[^>]*f="([^"]+)"/g;
    const regexFE = /<F\s[^>]*f="([^"]+)"[^>]*e="([^"]+)"/g;

    const seen = new Set();

    let match;
    while ((match = regexEF.exec(page.rawContent)) !== null) {
      const key = `${match[1]}.${match[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        if (!usage[key]) usage[key] = [];
        usage[key].push({ id: page.id, title: page.title, path: page.path || `/${page.id}/` });
        totalRefs++;
      }
    }
    while ((match = regexFE.exec(page.rawContent)) !== null) {
      const key = `${match[2]}.${match[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        if (!usage[key]) usage[key] = [];
        usage[key].push({ id: page.id, title: page.title, path: page.path || `/${page.id}/` });
        totalRefs++;
      }
    }
  }

  return { usage, totalRefs };
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
  // Sort IDs alphabetically so prefix matches are adjacent, then scan forward
  // while the prefix relationship holds. This is O(n log n) instead of O(n²).
  // Correctness: `-` (ASCII 45) is the lowest character in entity-ID slugs
  // (lower than digits 48-57 and letters 97-122), so all `a-*` entries are
  // contiguous immediately after `a` in sorted order.
  const sortedIds = entities.map(e => e.id).sort();
  for (let i = 0; i < sortedIds.length; i++) {
    const a = sortedIds[i];
    const prefix = a + '-';
    for (let j = i + 1; j < sortedIds.length; j++) {
      const b = sortedIds[j];
      if (b.startsWith(prefix)) {
        addEdge(a, b, 6);
      } else {
        break;
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
 * Collect all link signals into a flat array for syncing to the wiki-server.
 * Mirrors the 5 signals used by computeRelatedGraph:
 *   1. YAML relatedEntries (weight 10)
 *   2. Name/prefix matching (weight 6)
 *   3. Content EntityLinks (weight 5)
 *   4. Content similarity (weight 0-3, scaled)
 *   5. Shared tags (weight varies by specificity)
 */
function collectLinkSignals(entities, pages, contentInbound, tagIndex) {
  const links = [];
  const seen = new Set(); // Deduplicate (source, target, type)

  function addLink(sourceId, targetId, linkType, weight, relationship) {
    if (sourceId === targetId) return;
    const key = `${sourceId}|${targetId}|${linkType}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ sourceId, targetId, linkType, weight, relationship: relationship || null });
  }

  // 1. Explicit YAML relatedEntries
  for (const entity of entities) {
    if (entity.relatedEntries) {
      for (const ref of entity.relatedEntries) {
        addLink(entity.id, ref.id, 'yaml_related', 10, ref.relationship);
      }
    }
  }

  // 2. Name/prefix matching
  const sortedIds = entities.map(e => e.id).sort();
  for (let i = 0; i < sortedIds.length; i++) {
    const a = sortedIds[i];
    const prefix = a + '-';
    for (let j = i + 1; j < sortedIds.length; j++) {
      const b = sortedIds[j];
      if (b.startsWith(prefix)) {
        addLink(a, b, 'name_prefix', 6, null);
      } else {
        break;
      }
    }
  }

  // 3. Content EntityLinks
  for (const [targetId, sources] of Object.entries(contentInbound)) {
    for (const source of sources) {
      addLink(source.id, targetId, 'entity_link', 5, null);
    }
  }

  // 4. Content similarity from redundancy scores
  for (const page of pages) {
    if (!page.redundancy?.similarPages) continue;
    for (const sp of page.redundancy.similarPages) {
      const weight = (sp.similarity / 100) * 3;
      if (weight > 0) {
        addLink(page.id, sp.id, 'similarity', Math.round(weight * 100) / 100, null);
      }
    }
  }

  // 5. Shared tags
  for (const entity of entities) {
    if (!entity.tags?.length) continue;
    for (const tag of entity.tags) {
      const tagEntities = tagIndex[tag] || [];
      const specificity = 1 / Math.log2(tagEntities.length + 2);
      const weight = Math.round(specificity * 2 * 100) / 100;
      if (weight > 0) {
        for (const te of tagEntities) {
          if (te.id !== entity.id) {
            addLink(entity.id, te.id, 'shared_tag', weight, null);
          }
        }
      }
    }
  }

  return links;
}

/**
 * Normalize a YAML date value (string or Date object) to a YYYY-MM-DD string.
 * Returns null if the value is falsy.
 */
function toDateString(val) {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val);
}

/**
 * Extract PR number from a URL like "https://github.com/.../pull/123".
 */
function extractPrNumber(prUrl) {
  if (!prUrl) return undefined;
  if (typeof prUrl === 'number') return prUrl;
  const m = String(prUrl).match(/\/pull\/(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Return the later of two YYYY-MM-DD date strings (null-safe).
 */
function maxDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Build git-based date maps for all content files.
 * Returns two Maps keyed by repo-relative file path:
 *   - gitCreatedMap: path → YYYY-MM-DD of first commit (approximate, when file was added)
 *   - gitModifiedMap: path → YYYY-MM-DD of last commit
 * Falls back to empty maps if git is unavailable (e.g. shallow clones, no git installed).
 *
 * Bulk-import detection: uses filterBulkImportDates() to remove entries where
 * more than 50 files share the same git-created date. This prevents mass
 * restructures (e.g. an import that touched 650 files) from giving every page
 * an identical, meaningless creation date.
 */
function buildGitDateMaps() {
  let gitCreatedMap = new Map();
  const gitModifiedMap = new Map();

  try {
    // Single git log pass: newest-first, all content file changes.
    // "COMMIT <date>" marker lines separate commits; filenames follow.
    const result = spawnSync('git', [
      'log',
      '--format=COMMIT %ad',
      '--date=short',
      '--name-only',
      '--',
      'content/docs/',
    ], {
      cwd: REPO_ROOT,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
    });

    if (result.status !== 0 || result.error) {
      const reason = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
      console.log(`  gitDateMaps: skipped (${reason})`);
      return { gitCreatedMap, gitModifiedMap };
    }

    let currentDate = null;
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('COMMIT ')) {
        currentDate = line.slice(7).trim();
      } else if (currentDate && line.trim()) {
        const filePath = line.trim();
        // git log is newest-first: first occurrence = most recent modification
        if (!gitModifiedMap.has(filePath)) {
          gitModifiedMap.set(filePath, currentDate);
        }
        // Keep overwriting: last occurrence = oldest = approximate creation date
        gitCreatedMap.set(filePath, currentDate);
      }
    }

    // Filter out bulk-import dates using the extracted utility
    const { filtered, discardedDates } = filterBulkImportDates(gitCreatedMap);
    const removed = gitCreatedMap.size - filtered.size;
    gitCreatedMap = filtered;

    if (discardedDates.length > 0) {
      for (const { date, fileCount } of discardedDates) {
        console.log(`  gitDateMaps: discarded bulk-import date ${date} (${fileCount} files)`);
      }
      console.log(`  gitDateMaps: ${gitModifiedMap.size} files tracked, ${removed} bulk-import created dates discarded`);
    } else {
      console.log(`  gitDateMaps: ${gitModifiedMap.size} files tracked`);
    }
  } catch (err) {
    console.log(`  gitDateMaps: skipped (${err.message || 'unknown error'})`);
  }

  return { gitCreatedMap, gitModifiedMap };
}

/**
 * Fetch latest edit dates per page from the wiki-server API.
 * Falls back to an empty map if the server is unavailable.
 */
async function buildEditLogDateMap() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  editLogDates: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return new Map();
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`${serverUrl}/api/edit-logs/latest-dates`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.log(`  editLogDates: skipped (server returned ${res.status})`);
      return new Map();
    }

    const data = await res.json();
    const dateMap = new Map();
    for (const [pageId, dateStr] of Object.entries(data.dates)) {
      dateMap.set(pageId, dateStr);
    }
    console.log(`  editLogDates: ${dateMap.size} pages fetched from API`);
    return dateMap;
  } catch (err) {
    console.log(`  editLogDates: skipped (${err.message || 'server unavailable'})`);
    return new Map();
  }
}

/**
 * Fetch earliest edit dates per page from the wiki-server API.
 * Used as a fallback for dateCreated when git dates were discarded (bulk import)
 * and no frontmatter createdAt exists.
 * Falls back to an empty map if the server is unavailable.
 */
async function buildEarliestEditLogDateMap() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  earliestEditLogDates: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return new Map();
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`${serverUrl}/api/edit-logs/earliest-dates`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.log(`  earliestEditLogDates: skipped (server returned ${res.status})`);
      return new Map();
    }

    const data = await res.json();
    const dateMap = new Map();
    for (const [pageId, dateStr] of Object.entries(data.dates)) {
      dateMap.set(pageId, dateStr);
    }
    console.log(`  earliestEditLogDates: ${dateMap.size} pages fetched from API`);
    return dateMap;
  } catch (err) {
    console.log(`  earliestEditLogDates: skipped (${err.message || 'server unavailable'})`);
    return new Map();
  }
}

/**
 * Fetch per-page citation stats from the wiki-server API.
 * Returns a Map of pageId → { total, verified, accurate, inaccurate, avgScore }.
 * Falls back to an empty map if the server is unavailable.
 */
async function buildCitationStatsMap() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  citationStats: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return new Map();
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`${serverUrl}/api/citations/page-stats`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.log(`  citationStats: skipped (server returned ${res.status})`);
      return new Map();
    }

    const data = await res.json();
    const statsMap = new Map();
    for (const page of data.pages || []) {
      statsMap.set(page.pageId, {
        total: page.total,
        withQuotes: page.withQuotes,
        verified: page.verified,
        accuracyChecked: page.accuracyChecked,
        accurate: page.accurate,
        inaccurate: page.inaccurate,
        avgScore: page.avgScore,
      });
    }
    console.log(`  citationStats: ${statsMap.size} pages fetched from API`);
    return statsMap;
  } catch (err) {
    console.log(`  citationStats: skipped (${err.message || 'server unavailable'})`);
    return new Map();
  }
}

/**
 * Fetch all citation quotes from wiki-server, grouped by pageId.
 * Used by the frontend to render citation health banners and footnote tooltips
 * without making per-page API calls at runtime.
 * Returns { [pageId]: CitationQuote[] } or empty object if unavailable.
 */
async function buildCitationQuotesBundle() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  citationQuotes: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return {};
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    // Paginate through all quotes (max 5000 per page)
    const allQuotes = [];
    let offset = 0;
    const limit = 5000;

    while (true) {
      const res = await fetch(
        `${serverUrl}/api/citations/quotes/all?limit=${limit}&offset=${offset}`,
        { headers, signal: AbortSignal.timeout(30_000) }
      );
      if (!res.ok) {
        console.log(`  citationQuotes: skipped (server returned ${res.status})`);
        return {};
      }
      const data = await res.json();
      allQuotes.push(...(data.quotes || []));
      if (data.quotes.length < limit) break;
      offset += limit;
    }

    // Group by pageId
    const byPage = {};
    for (const q of allQuotes) {
      if (!byPage[q.pageId]) byPage[q.pageId] = [];
      byPage[q.pageId].push({
        footnote: q.footnote,
        url: q.url,
        resourceId: q.resourceId,
        claimText: q.claimText,
        sourceQuote: q.sourceQuote,
        sourceTitle: q.sourceTitle,
        sourceType: q.sourceType,
        quoteVerified: q.quoteVerified,
        verificationScore: q.verificationScore,
        verifiedAt: q.verifiedAt,
        accuracyVerdict: q.accuracyVerdict,
        accuracyScore: q.accuracyScore,
        accuracyIssues: q.accuracyIssues,
        accuracySupportingQuotes: q.accuracySupportingQuotes,
        verificationDifficulty: q.verificationDifficulty,
        accuracyCheckedAt: q.accuracyCheckedAt,
      });
    }

    console.log(`  citationQuotes: ${allQuotes.length} quotes across ${Object.keys(byPage).length} pages`);
    return byPage;
  } catch (err) {
    console.log(`  citationQuotes: skipped (${err.message || 'server unavailable'})`);
    return {};
  }
}

/**
 * Fetch all statement-backed citation dot data from the new statements pipeline.
 * Returns { [pageSlug]: DotEntry[] } keyed by page slug (not numeric ID).
 * This replaces the legacy citationQuotes bundle for pages that have Statements V2 data.
 * Returns an empty object if the server is unavailable.
 */
async function buildStatementCitationDots() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  statementCitationDots: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return {};
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(
      `${serverUrl}/api/statements/citation-dots/all`,
      { headers, signal: AbortSignal.timeout(30_000) }
    );
    if (!res.ok) {
      console.log(`  statementCitationDots: skipped (server returned ${res.status})`);
      return {};
    }
    const data = await res.json();
    console.log(`  statementCitationDots: ${data.totalEntries ?? 0} entries across ${data.totalPages ?? 0} pages`);
    return data.pages || {};
  } catch (err) {
    console.log(`  statementCitationDots: skipped (${err.message || 'server unavailable'})`);
    return {};
  }
}

/**
 * Fetch all page references (claim refs + citations) from the wiki-server.
 * Returns a map of pageId → { claimReferences, citations } for the reference preprocessor.
 * Falls back to an empty object if the server is unavailable.
 */
async function buildPageReferenceIndex() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  pageReferenceIndex: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return {};
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`${serverUrl}/api/references/all`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.log(`  pageReferenceIndex: skipped (server returned ${res.status})`);
      return {};
    }

    const data = await res.json();
    console.log(`  pageReferenceIndex: ${data.totalPages} pages, ${data.totalClaimRefs} claim refs, ${data.totalCitations} citations`);
    return data.pages || {};
  } catch (err) {
    console.log(`  pageReferenceIndex: skipped (${err.message || 'server unavailable'})`);
    return {};
  }
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
function buildPagesRegistry(urlToResource, editLogDates, gitDateMaps, earliestEditLogDates) {
  const { gitCreatedMap = new Map(), gitModifiedMap = new Map() } = gitDateMaps || {};
  const earliestDates = earliestEditLogDates || new Map();
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
          tacticalValue: fm.tacticalValue != null ? Number(fm.tacticalValue) : null,
          // Content format: article (default), table, diagram, index, dashboard
          contentFormat: fm.contentFormat || 'article',
          // ITN framework fields (0-100 scale)
          tractability: fm.tractability != null ? Number(fm.tractability) : null,
          neglectedness: fm.neglectedness != null ? Number(fm.neglectedness) : null,
          uncertainty: fm.uncertainty != null ? Number(fm.uncertainty) : null,
          causalLevel: fm.causalLevel || null,
          lastUpdated: maxDate(
            editLogDates.get(isIndexFile ? null : id) || null,
            maxDate(
              gitModifiedMap.get(relative(REPO_ROOT, fullPath)) || null,
              maxDate(toDateString(fm.lastUpdated), toDateString(fm.lastEdited))
            )
          ),
          // Derive creation date: prefer explicit frontmatter, then non-bulk git
          // first-commit, then earliest edit log from wiki-server, then legacy
          // frontmatter. Bulk-import git dates are already filtered out of
          // gitCreatedMap by buildGitDateMaps().
          dateCreated: toDateString(fm.createdAt) || gitCreatedMap.get(relative(REPO_ROOT, fullPath)) || earliestDates.get(isIndexFile ? null : id) || toDateString(fm.dateCreated) || null,
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
 * whose IDs differ from their page filenames.
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
  // (e.g. entities whose IDs don't match their page filenames).
  // Also handle factor entities that follow "factors-{id}-overview" naming.
  const entityDir = join(DATA_DIR, 'entities');
  if (existsSync(entityDir)) {
    for (const file of readdirSync(entityDir)) {
      if (!file.endsWith('.yaml')) continue;
      const content = readFileSync(join(entityDir, file), 'utf-8');
      let entities;
      try {
        entities = parse(content);
      } catch (e) {
        console.error(`Failed to parse YAML ${join(entityDir, file)}: ${e.message}`);
        process.exitCode = 1;
        continue;
      }
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
 * Compute hallucination risk score for a page (build-time wrapper).
 *
 * Delegates to the canonical scorer in crux/lib/hallucination-risk.ts.
 * See that module for scoring details and factor weights.
 *
 * @param {object} page  – page object from buildPagesRegistry (with metrics, ratings, etc.)
 * @param {Map}    entityMap – Map<entityId, entity> from YAML data
 */
function computeHallucinationRisk(page, entityMap) {
  const entity = entityMap.get(page.id);
  const rawType = entity?.type || null;

  // Strip frontmatter from raw content for integrity checks
  const contentBody = page.rawContent
    ? page.rawContent.replace(/^---\n[\s\S]*?\n---\n?/, '')
    : null;

  return computeCanonicalRisk({
    entityType: resolveEntityType(rawType),
    wordCount: page.metrics?.wordCount || 0,
    footnoteCount: page.metrics?.footnoteCount || 0,
    externalLinks: page.metrics?.externalLinks || 0,
    rigor: page.ratings?.rigor ?? null,
    quality: page.quality ?? null,
    contentBody,
    contentFormat: page.contentFormat || null,
  });
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
  // =========================================================================
  const { slugToNumericId, numericIdToSlug, nextId: nextIdInit } = buildIdRegistry(entities);
  let nextId = nextIdInit;
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

  // Load and process canonical facts (extracted to facts-loader.mjs)
  const facts = loadFacts(DATA_DIR);
  const factMeasures = loadFactMeasures(DATA_DIR);
  database.factMeasures = factMeasures;
  normalizeFactValues(facts, factMeasures);
  enrichFactSources(facts, database.resources || [], database.publications || []);
  database.facts = facts;

  // Build timeseries index
  const factTimeseries = buildFactTimeseries(facts);
  database.factTimeseries = factTimeseries;

  // Load KB (knowledge base graph) from packages/kb
  const kbDataDir = join(REPO_ROOT, 'packages', 'kb', 'data');
  if (existsSync(kbDataDir)) {
    const { loadKB, serialize } = await import('../../../packages/kb/src/index.ts');
    const graph = await loadKB(kbDataDir);
    const serializedKB = serialize(graph);
    database.kb = serializedKB;
    const entityCount = serializedKB.entities?.length ?? 0;
    const factCount = Object.keys(serializedKB.facts ?? {}).length;
    console.log(`  kb: ${entityCount} entities, ${factCount} fact groups`);
  } else {
    console.warn('  kb: skipped (data directory not found at packages/kb/data)');
  }

  // Build URL → resource map for unconverted link detection
  const resources = database.resources || [];
  const urlToResource = buildUrlToResourceMap(resources);
  console.log(`  urlToResource: ${urlToResource.size} URL variations mapped`);

  // Fetch edit log dates, earliest edit log dates, and citation stats from
  // wiki-server (parallel). Also build git-based date maps (synchronous, fast).
  const gitDateMaps = CONTENT_ONLY ? { gitCreatedMap: new Map(), gitModifiedMap: new Map() } : buildGitDateMaps();
  const [editLogDates, earliestEditLogDates, citationStats, citationQuotesBundle, statementCitationDots] = CONTENT_ONLY
    ? [new Map(), new Map(), new Map(), {}, {}]
    : await Promise.all([
        buildEditLogDateMap(),
        buildEarliestEditLogDateMap(),
        buildCitationStatsMap(),
        buildCitationQuotesBundle(),
        buildStatementCitationDots(),
      ]);
  database.citationQuotes = citationQuotesBundle;
  database.statementCitationDots = statementCitationDots;

  // Build pages registry with frontmatter data (quality, etc.)
  const pages = buildPagesRegistry(urlToResource, editLogDates, gitDateMaps, earliestEditLogDates);

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
        // (e.g. an entity renders at a page with a different slug)
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

  // Scan MDX for <F> component usage — build reverse index for the fact dashboard
  const { usage: factUsage, totalRefs: factRefCount } = scanFactUsage(pages);
  database.factUsage = factUsage;
  console.log(`  factUsage: ${factRefCount} <F> references across ${Object.keys(factUsage).length} unique facts`);

  // =========================================================================
  // BLOCK-LEVEL IR — extract per-section metadata (entity links, facts,
  // citations, components, word counts) via remark AST parsing.
  // IMPORTANT: Must run BEFORE rawContent is deleted (below).
  // =========================================================================
  const blockIndex = {};
  if (CONTENT_ONLY) {
    console.log('  blockIR: skipped (content-only scope)');
  } else {
    console.log('  Extracting block-level IR...');
    let blockIRExtracted = 0;
    let blockIRSections = 0;
    const blockIRErrorPages = [];
    try {
      const { extractBlockIR } = await import('../../../crux/lib/content/block-ir.ts');
      for (const page of pages) {
        if (!page.rawContent) continue;
        try {
          const ir = extractBlockIR(page.id, page.rawContent);
          blockIndex[page.id] = ir;
          blockIRExtracted++;
          blockIRSections += ir.sections.length;
        } catch (err) {
          blockIRErrorPages.push(page.id);
          if (blockIRErrorPages.length <= 5) {
            console.warn(`    ⚠ block-ir parse error on ${page.id}: ${err.message}`);
          }
        }
      }
      if (blockIRErrorPages.length > 5) {
        console.warn(`    ⚠ ...and ${blockIRErrorPages.length - 5} more parse errors`);
      }
      console.log(`  blockIR: ${blockIRSections} sections across ${blockIRExtracted} pages${blockIRErrorPages.length > 0 ? ` (${blockIRErrorPages.length} parse errors — typically complex JSX expressions)` : ''}`);
    } catch (err) {
      console.warn(`  ⚠ block-ir extraction skipped: ${err.message}`);
    }
  }

  // Re-count backlinks after merging content links
  // Enrich pages with backlink counts + citation stats
  let pagesWithCitationStats = 0;
  for (const page of pages) {
    const pageBacklinks = backlinks[page.id] || [];
    page.backlinkCount = pageBacklinks.length;

    const cStats = citationStats.get(page.id);
    if (cStats) {
      page.citationHealth = cStats;
      pagesWithCitationStats++;
    }
  }
  if (pagesWithCitationStats > 0) {
    console.log(`  citationHealth: attached to ${pagesWithCitationStats} pages`);
  }

  // =========================================================================
  // HALLUCINATION RISK — compute per-page risk score from structural signals.
  // =========================================================================
  const { riskStats } = computeAllHallucinationRisks({
    pages,
    entityMap,
    computeRisk: computeHallucinationRisk,
    resolveEntityType,
  });
  database.riskStats = riskStats;

  // Record risk snapshots to wiki server (optional)
  await syncRiskSnapshots(pages, CONTENT_ONLY);

  // =========================================================================
  // PAGE RESOURCES — compute page → resourceId mappings at build time.
  // Uses 3 sources: inline <R id="...">, cited_by reverse index, URL matching.
  // Must run BEFORE rawContent is deleted (needs page body for URL extraction).
  // =========================================================================
  // Build URL → resource ID map (used by pageResources)
  const urlToId = new Map();
  for (const [url, resource] of urlToResource.entries()) {
    urlToId.set(url, resource.id);
  }

  {
    console.log('  Computing pageResources...');
    // Build cited_by reverse index: pageSlug → Set<resourceId>
    const citedByIndex = new Map();
    for (const r of resources) {
      if (!r.cited_by || !Array.isArray(r.cited_by)) continue;
      for (const pageId of r.cited_by) {
        if (!citedByIndex.has(pageId)) citedByIndex.set(pageId, new Set());
        citedByIndex.get(pageId).add(r.id);
      }
    }
    // urlToId already built in outer scope
    const validIds = new Set(resources.map(r => r.id));
    const pageResources = {};
    let pagesWithRefs = 0;
    let totalRefs = 0;

    for (const page of pages) {
      if (!page.rawContent) continue;
      const mergedIds = [];
      const seen = new Set();

      // Source 1: Inline <R id="..."> citations
      const inlineRe = /<R\s+[^>]*id="([a-f0-9]+)"[^>]*>/g;
      let m;
      while ((m = inlineRe.exec(page.rawContent)) !== null) {
        const id = m[1];
        if (!seen.has(id) && validIds.has(id)) { seen.add(id); mergedIds.push(id); }
      }

      // Source 2: cited_by reverse index
      const citedBy = citedByIndex.get(page.id);
      if (citedBy) {
        for (const id of citedBy) {
          if (!seen.has(id) && validIds.has(id)) { seen.add(id); mergedIds.push(id); }
        }
      }

      // Source 3: URL matching from markdown links
      const linkRe = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
      while ((m = linkRe.exec(page.rawContent)) !== null) {
        const url = m[2];
        const id = urlToId.get(url) ?? urlToId.get(url.replace(/\/$/, '')) ?? urlToId.get(url.replace(/\/$/, '') + '/');
        if (id && !seen.has(id) && validIds.has(id)) { seen.add(id); mergedIds.push(id); }
      }

      if (mergedIds.length > 0) {
        pageResources[page.id] = mergedIds;
        pagesWithRefs++;
        totalRefs += mergedIds.length;
      }
    }
    database.pageResources = pageResources;
    console.log(`  pageResources: ${totalRefs} resource refs across ${pagesWithRefs} pages`);
  }

  // =========================================================================
  // PAGE REFERENCE INDEX — DB-driven footnote references (claim refs + citations)
  // Fetched from wiki-server for the reference preprocessor at render time.
  // =========================================================================
  if (CONTENT_ONLY) {
    console.log('  pageReferenceIndex: skipped (content-only scope)');
    database.pageReferenceIndex = {};
  } else {
    console.log('  Fetching page reference index from wiki-server...');
    database.pageReferenceIndex = await buildPageReferenceIndex();
  }

  // Compute redundancy scores (needs rawContent)
  if (CONTENT_ONLY) {
    console.log('  redundancy: skipped (content-only scope)');
    // Still need to clean rawContent from pages
    for (const page of pages) {
      page.redundancy = { maxSimilarity: 0, similarPages: [] };
      delete page.rawContent;
      delete page._fullPath;
    }
    database.redundancyPairs = [];
  } else {
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
  }

  // =========================================================================
  // RELATED GRAPH — unified bidirectional graph combining all signals:
  // explicit YAML, content EntityLinks, tags, similarity, name-prefix.
  // =========================================================================
  const relatedGraph = computeRelatedGraph(entities, pages, contentInbound, tagIndex);
  database.relatedGraph = relatedGraph;
  console.log(`  relatedGraph: ${Object.keys(relatedGraph).length} entities have connections`);

  // Sync page links to wiki-server (optional — skips if server unavailable)
  if (CONTENT_ONLY) {
    console.log('  linkSync: skipped (content-only scope)');
  } else if (process.env.LONGTERMWIKI_SERVER_URL) {
    const linkSignals = collectLinkSignals(entities, pages, contentInbound, tagIndex);
    console.log(`  linkSignals: ${linkSignals.length} link signals collected for server sync`);
    const linkResult = await syncPageLinks(linkSignals);
    if (linkResult.ok) {
      console.log(`  linkSync: synced ${linkResult.data.upserted} links to wiki server`);
    } else {
      console.log(`  linkSync: skipped (${linkResult.message || 'server unavailable or error'})`);
    }
  }

  // =========================================================================
  // SESSION LOG → PAGE CHANGE HISTORY
  // Try fetching from wiki-server API first, fall back to parsing YAML files.
  // =========================================================================
  let prItems = [];
  if (CONTENT_ONLY) {
    console.log('  changeHistory: skipped (content-only scope)');
    console.log('  prItems: skipped (content-only scope)');
    database.prItems = prItems;
  } else {
    let pageChangeHistory = null;
    let changeHistorySource = 'yaml';

    const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
    if (serverUrl) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const res = await fetch(`${serverUrl}/api/sessions/page-changes`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });

        if (res.ok) {
          const data = await res.json();
          // Transform API response into pageId → ChangeEntry[] map
          pageChangeHistory = {};
          for (const session of data.sessions) {
            const entry = {
              date: session.date,
              branch: session.branch || '',
              title: session.title,
              summary: session.summary || '',
              ...(session.prUrl && { pr: extractPrNumber(session.prUrl) }),
              ...(session.model && { model: session.model }),
              ...(session.duration && { duration: session.duration }),
              ...(session.cost && { cost: session.cost }),
            };
            for (const pageId of session.pages) {
              if (!pageChangeHistory[pageId]) pageChangeHistory[pageId] = [];
              pageChangeHistory[pageId].push(entry);
            }
          }
          changeHistorySource = 'api';
          console.log(`  changeHistory: fetched ${data.sessions.length} sessions from API`);
        }
      } catch {
        // Fall through to YAML
      }
    }

    if (!pageChangeHistory) {
      // Fallback: parse YAML/Markdown session files
      const sessionLogPath = join(REPO_ROOT, '.claude', 'session-log.md');
      const sessionsDir = join(REPO_ROOT, '.claude', 'sessions');
      pageChangeHistory = parseAllSessionLogs(sessionLogPath, sessionsDir);

      // Auto-populate PR numbers from GitHub API for entries that don't have them
      const branchToPr = await fetchBranchToPrMap();
      const prEnriched = enrichWithPrNumbers(pageChangeHistory, branchToPr);
      if (branchToPr.size > 0) {
        console.log(`  changeHistory: enriched ${prEnriched} entries with PR numbers (${branchToPr.size} PRs fetched)`);
      }
    }

    let pagesWithHistory = 0;
    for (const page of pages) {
      const history = pageChangeHistory[page.id];
      if (history && history.length > 0) {
        page.changeHistory = history;
        pagesWithHistory++;
      }
    }
    console.log(`  changeHistory: ${Object.keys(pageChangeHistory).length} pages have session history (source: ${changeHistorySource})`);

    // =========================================================================
    // PR DESCRIPTIONS — full PR metadata for the dashboard
    // =========================================================================
    prItems = await fetchPrItems();
    database.prItems = prItems;
    console.log(`  prItems: ${prItems.length} PRs fetched for dashboard`);
  }

  // =========================================================================
  // PAGE COVERAGE — compute per-page coverage scores from structural signals.
  // Used by PageStatus component and the /internal/page-coverage dashboard.
  // =========================================================================
  console.log('  Computing page coverage scores...');
  // Pre-compute entity fact counts
  const entityFactCounts = {};
  for (const [_key, fact] of Object.entries(database.facts || {})) {
    entityFactCounts[fact.entity] = (entityFactCounts[fact.entity] || 0) + 1;
  }
  let coverageGreen = 0, coverageAmber = 0, coverageRed = 0;
  for (const page of pages) {
    const coverage = computePageCoverage({
      wordCount: page.metrics?.wordCount ?? page.wordCount ?? 0,
      contentFormat: page.contentFormat || 'article',
      llmSummary: page.llmSummary,
      updateFrequency: page.updateFrequency,
      hasEntity: entityMap.has(page.id),
      changeHistoryCount: page.changeHistory?.length ?? 0,
      tableCount: page.metrics?.tableCount ?? 0,
      diagramCount: page.metrics?.diagramCount ?? 0,
      internalLinks: page.metrics?.internalLinks ?? 0,
      externalLinks: page.metrics?.externalLinks ?? 0,
      footnoteCount: page.metrics?.footnoteCount ?? 0,
      resourceCount: (database.pageResources[page.id] || []).length,
      quotesWithQuotes: page.citationHealth?.withQuotes ?? 0,
      quotesTotal: page.citationHealth?.total ?? 0,
      accuracyChecked: page.citationHealth?.accuracyChecked ?? 0,
      accuracyTotal: page.citationHealth?.total ?? 0,
      ratings: page.ratings,
      factCount: entityFactCounts[page.id] || 0,
      hasOverview: page.metrics?.hasOverview,
      entityType: page.entityType ?? null,
    });
    page.coverage = coverage;
    const pct = coverage.passing / coverage.total;
    if (pct >= 0.75) coverageGreen++;
    else if (pct >= 0.5) coverageAmber++;
    else coverageRed++;
  }
  console.log(`  pageCoverage: ${coverageGreen} green, ${coverageAmber} amber, ${coverageRed} red`);

  // =========================================================================
  // PAGE RANKINGS, RECOMMENDED SCORES, UPDATE SCHEDULE
  // =========================================================================
  console.log('  Computing page rankings...');
  const { readerRanked, researchRanked } = computePageRankings(pages);
  console.log(`  pageRankings: ${readerRanked} reader-ranked, ${researchRanked} research-ranked`);

  console.log('  Computing recommended scores...');
  const buildNow = Date.now();
  computeRecommendedScores(pages, buildNow);
  console.log(`  recommendedScores: computed for ${pages.length} pages`);

  console.log('  Computing update schedule...');
  const updateScheduleItems = buildUpdateSchedule(pages, slugToNumericId, buildNow);
  database.updateSchedule = updateScheduleItems;
  const overdue = updateScheduleItems.filter(i => i.daysUntilDue < 0).length;
  console.log(`  updateSchedule: ${updateScheduleItems.length} pages tracked, ${overdue} overdue`);

  database.pages = pages;

  // =========================================================================
  // EXTEND ID REGISTRY — page-only numericIds
  // =========================================================================
  const entityIds = new Set(entities.map(e => e.id));
  const { nextId: _finalNextId } = extendIdRegistryWithPages({
    pages, entityIds, slugToNumericId, numericIdToSlug, pathRegistry, nextId,
  });
  // Update registry output maps
  idRegistryOutput.byNumericId = { ...numericIdToSlug };
  idRegistryOutput.bySlug = { ...slugToNumericId };
  database.idRegistry = idRegistryOutput;

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
  // Update description count to reflect post-enrichment state
  stats.withDescription = typedEntities.filter(e => e.description).length;
  console.log(`  typedEntities: ${typedEntities.length} transformed`);

  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

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
  if (Object.keys(blockIndex).length > 0) {
    writeFileSync(join(OUTPUT_DIR, 'block-index.json'), JSON.stringify(blockIndex));
    console.log(`✓ Written block-index.json (${Object.keys(blockIndex).length} pages)`);
  }

  console.log('✓ Written individual JSON files');
  console.log('✓ Written derived data files (backlinks, tagIndex, stats, pathRegistry)');

  // Generate link health data
  if (CONTENT_ONLY) {
    console.log('\nLink health: skipped (content-only scope)');
  } else {
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
  }

  // Print summary stats
  console.log('\n--- Summary ---');
  console.log(`Total entities: ${stats.totalEntities}`);
  console.log(`With descriptions: ${stats.withDescription}`);
  console.log(`Unique tags: ${stats.totalTags}`);
  console.log(`Top types: ${Object.entries(stats.byType).slice(0, 5).map(([t, c]) => `${t}(${c})`).join(', ')}`);

  // ==========================================================================
  // Copy canonical schema.ts to apps/web output directory
  // ==========================================================================
  const SCHEMA_SRC = join(DATA_DIR, 'schema.ts');
  copyFileSync(SCHEMA_SRC, join(OUTPUT_DIR, 'schema.ts'));
  console.log('✓ Copied data/schema.ts → apps/web/src/data/schema.ts');

  // ==========================================================================
  // LLM Accessibility Files
  // ==========================================================================
  if (CONTENT_ONLY) {
    console.log('LLM files: skipped (content-only scope)');
  } else {
    generateLLMFiles();
  }

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
