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
 *                    yaml, ids, mdx, derived, kb, pages, links, blocks,
 *                    risk, resources, footnotes, refs, redundancy, graph,
 *                    history, coverage, rankings, schedule, transform, write
*/

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, relative } from 'path';
import { parse } from 'yaml';
import { resolveEntityType } from '../../../crux/lib/hallucination-risk.ts';
import { filterBulkImportDates } from './lib/git-date-utils.mjs';
import { computeRedundancy } from './lib/redundancy.mjs';
import { CONTENT_DIR, DATA_DIR, OUTPUT_DIR, REPO_ROOT, TOP_LEVEL_CONTENT_DIRS } from './lib/content-types.mjs';
import { generateLLMFiles } from './generate-llm-files.mjs';
import { buildUrlToResourceMap } from './lib/unconverted-links.mjs';
import { generateMdxFromYaml } from './lib/mdx-generator.mjs';
import { computeStats } from './lib/statistics.mjs';
import { transformEntities } from './lib/entity-transform.mjs';
import { scanFrontmatterEntities } from './lib/frontmatter-scanner.mjs';
import { parseAllSessionLogs } from './lib/session-log-parser.mjs';
import { fetchBranchToPrMap, enrichWithPrNumbers, fetchPrItems } from './lib/github-pr-lookup.mjs';
import { computePageCoverage } from '../../../crux/lib/page-coverage.ts';
import { buildIdRegistry, extendIdRegistryWithPages } from './lib/id-registry.mjs';
import { computePageRankings, computeRecommendedScores, buildUpdateSchedule } from './lib/page-rankings.mjs';
import { computeAllHallucinationRisks, syncRiskSnapshots } from './lib/hallucination-risk-build.mjs';

// Extracted modules
import {
  buildHeaders,
  buildEditLogDateMap,
  buildEarliestEditLogDateMap,
  buildCitationStatsMap,
  buildCitationQuotesBundle,
  mergePGRecordsIntoKB,
  fetchAssessments,
  fetchBenchmarkResults,
  fetchResearchAreas,
  fetchRecordVerdicts,
  fetchResourcesFromPG,
  buildPageReferenceIndex,
} from './lib/wiki-server-data.mjs';
import {
  buildPagesRegistry,
  buildPathRegistry,
  computeHallucinationRisk,
  extractPrNumber,
} from './lib/pages-builder.mjs';
import { syncBuildMetrics, syncLinksAndRefreshGraph } from './lib/metrics-sync.mjs';
import {
  writeMainOutputFiles,
  writeIndividualFiles,
  writePerEntityBundles,
  generateLinkHealth,
  generateEntityMatrix,
} from './lib/output-writer.mjs';

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
  { key: 'glossary', file: 'glossary.yaml' },
  { key: 'entities', dir: 'entities' }, // Split by entity type
  { key: 'literature', file: 'literature.yaml' },
  { key: 'funders', file: 'funders.yaml' },
  { key: 'resources', dir: 'resources' }, // Split into multiple files
  { key: 'publications', file: 'publications.yaml' },
  { key: 'peopleResources', file: 'people-resources.yaml' },
];

/**
 * Scan MDX files for <EntityLink id="..."> references and check each against
 * the entity registry. EntityLink ids can be numeric (E42) or slug-based.
 */
function scanBrokenEntityLinks(wikiIdToSlug, slugToWikiId, pathRegistry, byStableId) {
  const entityLinkRegex = /<EntityLink\s+id="([^"]+)"/g;
  const knownWikiIds = new Set(Object.keys(wikiIdToSlug));
  const knownSlugs = new Set(Object.keys(slugToWikiId));
  const knownStableIds = byStableId ? new Set(Object.keys(byStableId)) : new Set();
  const reachableSlugs = new Set(Object.keys(pathRegistry));
  const broken = [];
  const unreachable = [];

  const mdxFiles = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mdx')) mdxFiles.push(full);
    }
  }
  walk(CONTENT_DIR);

  for (const filePath of mdxFiles) {
    const content = readFileSync(filePath, 'utf-8');
    entityLinkRegex.lastIndex = 0;
    let match;
    while ((match = entityLinkRegex.exec(content)) !== null) {
      const id = match[1];
      const pageId = relative(CONTENT_DIR, filePath).replace(/\.mdx$/, '');

      // Resolve to slug: id can be numeric (E42), slug-based, or stableId (10-char alphanum)
      let slug;
      if (knownWikiIds.has(id)) {
        slug = wikiIdToSlug[id];
      } else if (knownSlugs.has(id)) {
        slug = id;
      } else if (knownStableIds.has(id)) {
        slug = byStableId[id];
      } else {
        broken.push({ pageId, entityId: id, reason: 'not_found' });
        continue;
      }

      if (slug && !reachableSlugs.has(slug)) {
        unreachable.push({ pageId, entityId: id, reason: 'no_page' });
      }
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    totalBroken: broken.length,
    totalUnreachable: unreachable.length,
    sample: [...broken, ...unreachable].slice(0, 20),
  };
}

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

const SNAPSHOT_STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Check if the snapshot file is stale (mtime > 24h old) and log a warning.
 * Called when falling back to the snapshot for resource loading.
 */
function warnIfSnapshotStale(snapshotPath) {
  try {
    const stats = statSync(snapshotPath);
    const ageMs = Date.now() - stats.mtimeMs;
    if (ageMs > SNAPSHOT_STALENESS_THRESHOLD_MS) {
      const ageHours = Math.round(ageMs / (60 * 60 * 1000));
      console.warn(
        `  WARNING: resources snapshot is ${ageHours}h old (last modified: ${stats.mtime.toISOString()}). ` +
        `Run 'pnpm crux wiki-server snapshot-resources' to refresh.`
      );
    }
  } catch {
    // statSync failed — file may have just been read; don't block on this
  }
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
function scanContentEntityLinks(pages, entityMap, wikiIdToSlug, byStableId) {
  const inbound = {};
  let totalLinks = 0;

  for (const page of pages) {
    if (!page.rawContent) continue;

    const regex = /<EntityLink\s+[^>]*id="([^"]+)"/g;
    let match;
    const seen = new Set();

    while ((match = regex.exec(page.rawContent)) !== null) {
      let targetId = match[1];
      // Resolve wiki IDs (e.g. "E22") to slug IDs (e.g. "anthropic")
      if (wikiIdToSlug && wikiIdToSlug[targetId]) {
        targetId = wikiIdToSlug[targetId];
      }
      // Resolve stableIds (e.g. "mK9pX3rQ7n") to slug IDs
      else if (byStableId && byStableId[targetId]) {
        targetId = byStableId[targetId];
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
 * Normalize a URL for fuzzy matching between resource URLs and citation URLs.
 * Strips protocol, www. prefix, trailing slashes, and hash fragments. Preserves
 * query string. Mirrors the logic in resource-utils.ts (cannot import .ts in .mjs).
 */
function normalizeUrlForMatch(str) {
  try {
    const url = new URL(str);
    url.hostname = url.hostname.replace(/^www\./, '');
    url.hash = '';
    return (
      url.host + url.pathname.replace(/\/+$/, '') + url.search
    ).toLowerCase();
  } catch {
    return str.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * Cross-reference KB fact source URLs with citation quotes to produce
 * a verification status map: factId → best accuracy verdict.
 *
 * This runs at build time with data already in memory — no API calls.
 * Returns { [factId]: verdictString } for facts whose source URL matches
 * a verified citation quote.
 *
 * @param {object} kb - Serialized KB data
 * @param {object} citationQuotesBundle - Citation quotes keyed by page ID
 */
function buildKBFactVerification(kb, citationQuotesBundle) {
  if (!kb || !kb.facts || !citationQuotesBundle) {
    console.log('  kbFactVerification: skipped (no KB or citation data)');
    return {};
  }

  // Build a URL → best verdict map from all citation quotes across all pages.
  // A URL may appear in multiple pages with different verdicts; prefer the
  // MOST CAUTIOUS verdict (worst case wins) so flagged issues are never hidden.
  const VERDICT_PRIORITY = {
    inaccurate: 6,    // Most concerning → highest priority
    unsupported: 5,
    minor_issues: 4,
    not_verifiable: 3,
    accurate: 2,
    verified: 1,
  };

  const urlToVerdict = new Map();

  for (const quotes of Object.values(citationQuotesBundle)) {
    for (const q of quotes) {
      if (!q.url) continue;
      const verdict = q.accuracyVerdict || (q.quoteVerified ? 'verified' : null);
      if (!verdict) continue;

      const normalizedUrl = normalizeUrlForMatch(q.url);
      const existing = urlToVerdict.get(normalizedUrl);
      const existingPriority = existing ? (VERDICT_PRIORITY[existing] ?? 0) : 0;
      const newPriority = VERDICT_PRIORITY[verdict] ?? 0;
      if (newPriority > existingPriority) {
        urlToVerdict.set(normalizedUrl, verdict);
      }
    }
  }

  if (urlToVerdict.size === 0) {
    console.log('  kbFactVerification: 0 matches (no citation URLs with verdicts)');
    return {};
  }

  // Match KB fact source URLs against the citation URL map
  const verification = {};
  let matchCount = 0;

  for (const [entityId, facts] of Object.entries(kb.facts)) {
    for (const fact of facts) {
      const url = (fact.source && typeof fact.source === 'string') ? fact.source : null;
      if (!url) continue;

      // Only match URL sources
      if (!url.startsWith('http://') && !url.startsWith('https://')) continue;

      const normalizedSource = normalizeUrlForMatch(url);
      const verdict = urlToVerdict.get(normalizedSource);
      if (verdict) {
        verification[fact.id] = verdict;
        matchCount++;
      }
    }
  }

  console.log(`  kbFactVerification: ${matchCount} facts matched from ${urlToVerdict.size} citation URLs`);
  return verification;
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

async function main() {
  console.log('Building data bundle...\n');

  const database = {};

  for (const { key, file, dir } of DATA_FILES) {
    // Resources are loaded separately via PG → snapshot → YAML fallback chain
    if (key === 'resources') continue;
    const data = dir ? loadYamlDir(dir) : loadYaml(file);
    database[key] = data;
    console.log(`  ${key}: ${countEntries(data)} entries`);
  }

  // Load resources: PG → snapshot (fallback chain, PG-native since R6)
  if (!CONTENT_ONLY) {
    const pgResources = await fetchResourcesFromPG();
    if (pgResources !== null) {
      database.resources = pgResources;
      console.log(`  resources: ${pgResources.length} loaded from PG`);
    } else {
      // Try snapshot fallback (PG unavailable)
      const snapshotPath = join(DATA_DIR, 'resources-snapshot.json');
      let snapshotLoaded = false;
      if (existsSync(snapshotPath)) {
        try {
          const snapshotData = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
          if (Array.isArray(snapshotData)) {
            database.resources = snapshotData;
            console.log(`  resources: ${snapshotData.length} loaded from snapshot (PG unavailable)`);
            warnIfSnapshotStale(snapshotPath);
            snapshotLoaded = true;
          }
        } catch (err) {
          console.warn(`  resources: snapshot parse failed (${err.message})`);
        }
      }
      if (!snapshotLoaded) {
        database.resources = [];
        console.warn(`  resources: 0 loaded (PG + snapshot unavailable)`);
      }
    }
  } else {
    // Content-only mode: load from snapshot
    const snapshotPath = join(DATA_DIR, 'resources-snapshot.json');
    if (existsSync(snapshotPath)) {
      try {
        const snapshotData = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
        if (Array.isArray(snapshotData)) {
          database.resources = snapshotData;
          console.log(`  resources: ${snapshotData.length} entries (snapshot, content-only mode)`);
          warnIfSnapshotStale(snapshotPath);
        } else {
          database.resources = [];
          console.warn(`  resources: 0 (snapshot not an array, content-only mode)`);
        }
      } catch (_err) {
        database.resources = [];
        console.warn(`  resources: 0 (snapshot parse failed, content-only mode)`);
      }
    } else {
      database.resources = [];
      console.log(`  resources: 0 entries (no snapshot, content-only mode)`);
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
  // ID REGISTRY — derive from wikiId fields in source files (YAML + MDX)
  // =========================================================================
  const { slugToWikiId, wikiIdToSlug, byStableId, stableIdBySlug, nextId: nextIdInit } = buildIdRegistry(entities);
  let nextId = nextIdInit;
  // Build stableId → slug mapping from YAML entities (for entity resolution
  // in directory pages where ownerEntityId is a stableId rather than a slug)
  const stableIdToSlug = {};
  for (const e of entities) {
    if (e.stableId) {
      stableIdToSlug[e.stableId] = e.id;
    }
  }
  const idRegistryOutput = {
    byWikiId: { ...wikiIdToSlug },
    bySlug: { ...slugToWikiId },
    stableIdToSlug,
    byStableId: { ...byStableId },
    stableIdBySlug: { ...stableIdBySlug },
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

  // Load FactBase (structured facts graph) from packages/factbase
  // Build entity map from TableBase entities for injection into FactBase loader
  const factbaseDataDir = join(REPO_ROOT, 'packages', 'factbase', 'data');
  if (existsSync(factbaseDataDir)) {
    const { loadKB, serialize } = await import('../../../packages/factbase/src/index.ts');

    // Build TableBase entity map keyed by stableId for FactBase entity injection
    // Canonicalize entity types (e.g. "lab" -> "organization", "researcher" -> "person")
    // since transformEntities() runs later and raw YAML types may still be present here.
    const tableBaseEntityMap = new Map();
    for (const entity of entities) {
      if (entity.stableId) {
        tableBaseEntityMap.set(entity.stableId, {
          id: entity.stableId,
          stableId: entity.stableId,
          type: resolveEntityType(entity.type) || entity.type,
          name: entity.title || entity.id,
          ...(entity.wikiId && { wikiPageId: entity.wikiId, wikiId: entity.wikiId }),
        });
      }
    }

    const { graph, filenameMap } = await loadKB(factbaseDataDir, {
      entities: tableBaseEntityMap,
    });
    const serializedKB = serialize(graph, filenameMap);
    database.kb = serializedKB;
    const factCount = Object.keys(serializedKB.facts ?? {}).length;
    console.log(`  kb: ${factCount} fact groups (${tableBaseEntityMap.size} TableBase entities injected, entities owned by TableBase)`);
  } else {
    console.warn('  kb: skipped (data directory not found at packages/factbase/data)');
  }

  // Merge PG-backed personnel and grants into KB records (overrides YAML for these collections)
  if (database.kb && !CONTENT_ONLY) {
    const pgRecordCounts = await mergePGRecordsIntoKB(database.kb);
    const pgTotal = pgRecordCounts.personnel + pgRecordCounts.grants + pgRecordCounts.fundingRounds + pgRecordCounts.investments + pgRecordCounts.equityPositions + pgRecordCounts.divisions + pgRecordCounts.fundingPrograms + pgRecordCounts.divisionPersonnel;
    if (pgTotal > 0) {
      console.log(`  kb-pg: ${pgRecordCounts.personnel} personnel, ${pgRecordCounts.grants} grants, ${pgRecordCounts.fundingRounds} funding rounds, ${pgRecordCounts.investments} investments, ${pgRecordCounts.equityPositions} equity positions, ${pgRecordCounts.divisions} divisions, ${pgRecordCounts.fundingPrograms} funding programs, ${pgRecordCounts.divisionPersonnel} division personnel merged from PG`);
    }
  }

  // Fetch PG-sourced data in parallel (benchmark results, research areas, record verdicts, assessments)
  let assessmentMap = new Map();
  if (!CONTENT_ONLY) {
    const [benchmarkResults, researchAreasData, recordVerdicts, assessments] = await Promise.all([
      fetchBenchmarkResults(),
      fetchResearchAreas(),
      fetchRecordVerdicts(),
      fetchAssessments(),
    ]);
    database.benchmarkResults = benchmarkResults;
    database.researchAreas = researchAreasData;
    database.recordVerdicts = recordVerdicts;
    assessmentMap = assessments;
  }

  // Build URL → resource map for unconverted link detection
  const resources = database.resources || [];
  const urlToResource = buildUrlToResourceMap(resources);
  console.log(`  urlToResource: ${urlToResource.size} URL variations mapped`);

  // Fetch edit log dates, earliest edit log dates, and citation stats from
  // wiki-server (parallel). Also build git-based date maps (synchronous, fast).
  const gitDateMaps = CONTENT_ONLY ? { gitCreatedMap: new Map(), gitModifiedMap: new Map() } : buildGitDateMaps();
  const [editLogDates, earliestEditLogDates, citationStats, citationQuotesBundle] = CONTENT_ONLY
    ? [new Map(), new Map(), new Map(), {}]
    : await Promise.all([
        buildEditLogDateMap(),
        buildEarliestEditLogDateMap(),
        buildCitationStatsMap(),
        buildCitationQuotesBundle(),
      ]);
  database.citationQuotes = citationQuotesBundle;

  // =========================================================================
  // KB FACT VERIFICATION — cross-reference KB source URLs with citation quotes
  // =========================================================================
  database.kbFactVerification = buildKBFactVerification(database.kb, citationQuotesBundle);

  // Build pages registry with frontmatter data (quality, etc.)
  const pages = buildPagesRegistry(urlToResource, editLogDates, gitDateMaps, earliestEditLogDates, assessmentMap);

  // =========================================================================
  // CONTENT ENTITY LINKS — scan MDX for <EntityLink> references
  // Must happen before rawContent is stripped (below).
  // =========================================================================
  // Pre-populate wikiIdToSlug with page-level wikiIds (pages that aren't
  // YAML entities but have wikiId in frontmatter). This ensures wiki IDs
  // like "E660" resolve to slugs like "factors-ai-capabilities-overview" when
  // scanning EntityLink references below.
  // Also detect conflicts where a page claims a wikiId already owned by an entity.
  const pageIdConflicts = [];
  for (const page of pages) {
    if (page.wikiId) {
      const existing = wikiIdToSlug[page.wikiId];
      if (existing && existing !== page.id) {
        // Check if this is a legitimate alias: the entity's path maps to this page
        // (e.g. an entity renders at a page with a different slug)
        const entityPath = pathRegistry[existing];
        if (entityPath && entityPath.endsWith(`/${page.id}/`)) {
          // Entity maps to this page — they're the same content, just add alias
          slugToWikiId[page.id] = page.wikiId;
        } else {
          pageIdConflicts.push(`${page.wikiId} claimed by entity "${existing}" and page "${page.id}"`);
        }
      } else {
        wikiIdToSlug[page.wikiId] = page.id;
      }
    }
  }
  if (pageIdConflicts.length > 0) {
    console.error('\n  ERROR: wikiId conflicts between entities and pages:');
    for (const c of pageIdConflicts) console.error(`    ${c}`);
    process.exit(1);
  }

  const entityMap = new Map(entities.map(e => [e.id, e]));
  const { inbound: contentInbound, totalLinks: contentLinkCount } = scanContentEntityLinks(pages, entityMap, wikiIdToSlug, byStableId);

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
    await syncLinksAndRefreshGraph(linkSignals);
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
        const headers = buildHeaders();

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
  let coverageGreen = 0, coverageAmber = 0, coverageRed = 0;
  for (const page of pages) {
    const coverage = computePageCoverage({
      wordCount: page.metrics?.wordCount ?? page.wordCount ?? 0,
      contentFormat: page.contentFormat || 'article',
      summary: page.summary,
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
      hasOverview: page.metrics?.hasOverview,
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
  const updateScheduleItems = buildUpdateSchedule(pages, slugToWikiId, buildNow);
  database.updateSchedule = updateScheduleItems;
  const overdue = updateScheduleItems.filter(i => i.daysUntilDue < 0).length;
  console.log(`  updateSchedule: ${updateScheduleItems.length} pages tracked, ${overdue} overdue`);

  // =========================================================================
  // SYNC BUILD METRICS TO PG — coverage, rankings, schedule, similarity
  // Fire-and-forget: build continues even if wiki-server is unreachable.
  // =========================================================================
  if (CONTENT_ONLY) {
    console.log('  buildMetricsSync: skipped (content-only scope)');
  } else if (process.env.LONGTERMWIKI_SERVER_URL) {
    await syncBuildMetrics({ pages, updateScheduleItems });
  }

  database.pages = pages;

  // =========================================================================
  // EXTEND ID REGISTRY — page-only wikiIds
  // =========================================================================
  const entityIds = new Set(entities.map(e => e.id));
  const { nextId: _finalNextId } = extendIdRegistryWithPages({
    pages, entityIds, slugToWikiId, wikiIdToSlug, pathRegistry, nextId,
  });
  // Update registry output maps (byStableId/stableIdBySlug don't change from page extensions)
  idRegistryOutput.byWikiId = { ...wikiIdToSlug };
  idRegistryOutput.bySlug = { ...slugToWikiId };
  database.idRegistry = idRegistryOutput;
  console.log(`  idRegistry: ${Object.keys(byStableId).length} stableId mappings`);

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

  // =========================================================================
  // WRITE OUTPUT FILES
  // =========================================================================
  const { databaseForOutput } = writeMainOutputFiles({ database, outputFile: OUTPUT_FILE });

  writeIndividualFiles({
    database,
    dataFiles: DATA_FILES,
    backlinks,
    tagIndex,
    stats,
    pathRegistry,
    pages,
    relatedGraph,
    blockIndex,
  });

  writePerEntityBundles({
    typedEntities,
    pages,
    backlinks,
    relatedGraph,
    databaseForOutput,
  });

  // Generate link health data
  if (CONTENT_ONLY) {
    console.log('\nLink health: skipped (content-only scope)');
  } else {
    generateLinkHealth();
  }

  // ==========================================================================
  // Broken EntityLink scan
  // ==========================================================================
  console.log('\nScanning for broken EntityLink references...');
  const brokenLinksResult = scanBrokenEntityLinks(wikiIdToSlug, slugToWikiId, pathRegistry, byStableId);
  writeFileSync(join(OUTPUT_DIR, 'broken-entity-links.json'), JSON.stringify(brokenLinksResult, null, 2));
  console.log(`✓ EntityLink scan: ${brokenLinksResult.totalBroken} broken, ${brokenLinksResult.totalUnreachable} unreachable`);

  // Print summary stats
  console.log('\n--- Summary ---');
  console.log(`Total entities: ${stats.totalEntities}`);
  console.log(`With descriptions: ${stats.withDescription}`);
  console.log(`Unique tags: ${stats.totalTags}`);
  console.log(`Top types: ${Object.entries(stats.byType).slice(0, 5).map(([t, c]) => `${t}(${c})`).join(', ')}`);

  // schema.ts: apps/web/src/data/schema.ts re-exports from data/schema.ts
  // (no build-time copy needed — see #1526)

  // ==========================================================================
  // LLM Accessibility Files
  // ==========================================================================
  if (CONTENT_ONLY) {
    console.log('LLM files: skipped (content-only scope)');
  } else {
    generateLLMFiles();
  }

  // ==========================================================================
  // Entity Completeness Matrix
  // ==========================================================================
  if (CONTENT_ONLY) {
    console.log('Entity matrix: skipped (content-only scope)');
  } else {
    generateEntityMatrix();
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
