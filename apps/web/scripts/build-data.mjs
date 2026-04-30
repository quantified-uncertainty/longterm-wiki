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

// Load .env from repo root so wiki-server env vars are available without
// pre-setting them in the shell. Mirrors the pattern in assign-ids.mjs.
// dotenv.config() is a no-op when the file is absent or vars are already set.
try {
  const { config } = await import('dotenv');
  config({ path: join(REPO_ROOT, '.env') });
} catch {
  // dotenv not available or .env missing — rely on shell environment
}

import { generateLLMFiles } from './generate-llm-files.mjs';
import { buildUrlToResourceMap, urlKey as resourceUrlKey } from './lib/unconverted-links.mjs';
import { normalizeUrlForDedup } from '@longterm-wiki/url-utils';
import { generateMdxFromYaml } from './lib/mdx-generator.mjs';
import { computeStats } from './lib/statistics.mjs';
import { transformEntities } from './lib/entity-transform.mjs';
import { scanFrontmatterEntities, collectPageWikiIds } from './lib/frontmatter-scanner.mjs';
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
  fetchFactsFromPG,
  fetchAssessments,
  fetchBenchmarkResults,
  fetchResearchAreas,
  fetchResearchAreaDetails,
  fetchRecordVerdicts,
  // fetchFactBaseFromServer — available but not yet wired as default (PG-primary prep)
  fetchPolicyStakeholderIds,
  syncPolicyStakeholders,
  fetchResourcesFromPG,
  fetchEntityResourceLinks,
  fetchAllEntityStableIds,
  buildPageReferenceIndex,
  getWikiServerWarningCount,
  getSkippedDataSources,
  setFullBuildMode,
  isStrictWikiServerMode,
} from './lib/wiki-server-data.mjs';
import {
  buildPagesRegistry,
  buildPathRegistry,
  computeHallucinationRisk,
  extractPrNumber,
  getYamlParseErrorCount as getPagesBuilderYamlErrors,
} from './lib/pages-builder.mjs';
import { syncBuildMetrics, syncLinksAndRefreshGraph } from './lib/metrics-sync.mjs';
import {
  computeBacklinks,
  scanContentEntityLinks,
  buildTagIndex,
  computeRelatedGraph,
  collectLinkSignals,
} from './lib/link-graph.mjs';
import {
  writeMainOutputFiles,
  writeIndividualFiles,
  writePerEntityBundles,
  generateLinkHealth,
  generateEntityMatrix,
} from './lib/output-writer.mjs';
import { getServerUrl } from './lib/wiki-server-env.mjs';

// ---------------------------------------------------------------------------
// Scope flag — `--scope=content` or `--quick` skips expensive non-content steps
// ---------------------------------------------------------------------------
const hasQuickFlag = process.argv.includes('--quick');
const SCOPE = hasQuickFlag ? 'content' : (process.argv.find(a => a.startsWith('--scope='))?.split('=')[1] || 'full');
const CONTENT_ONLY = SCOPE === 'content';

if (CONTENT_ONLY) {
  console.log('⚡ Running in content-only scope (skipping git dates, block IR, redundancy, server sync, LLM files)\n');
} else {
  // In full build mode, wiki-server failures produce louder warnings
  setFullBuildMode(true);
}

const OUTPUT_FILE = join(OUTPUT_DIR, 'database.json');

// ---------------------------------------------------------------------------
// Build error/warning counters
// YAML parse errors are fatal — the build exits non-zero if any occur.
// Wiki-server API failures are non-fatal (fail-open for local dev).
// ---------------------------------------------------------------------------
let yamlParseErrorCount = 0;

// Entity type alias map: legacy YAML type names → canonical types
// Keep in sync with apps/web/src/data/entity-type-names.ts
// Entity type alias resolution now handled by resolveEntityType from hallucination-risk.ts

// Files to combine
const DATA_FILES = [
  { key: 'experts', file: 'experts.yaml' },
  { key: 'estimates', file: 'estimates.yaml' },
  { key: 'glossary', file: 'glossary.yaml' },
  { key: 'entities', dir: 'entities' }, // Split by entity type
  { key: 'funders', file: 'funders.yaml' },
  { key: 'resources', dir: 'resources' }, // Split into multiple files
  { key: 'publications', file: 'publications.yaml' },
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
    console.error(`YAML PARSE ERROR: ${filepath}: ${e.message}`);
    yamlParseErrorCount++;
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
      console.error(`YAML PARSE ERROR: ${filepath}: ${e.message}`);
      yamlParseErrorCount++;
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

// Link graph functions (computeBacklinks, scanContentEntityLinks, buildTagIndex,
// computeRelatedGraph, collectLinkSignals) extracted to ./lib/link-graph.mjs


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

  // Build a URL → verdict map from all citation quotes across all pages.
  // When a URL has multiple verdicts, prefer the MOST RECENT one so that
  // re-checks actually update the displayed verdict (fixes stale contradictions).
  const urlToVerdict = new Map();

  for (const quotes of Object.values(citationQuotesBundle)) {
    for (const q of quotes) {
      if (!q.url) continue;
      const verdict = q.accuracyVerdict || (q.quoteVerified ? 'verified' : null);
      if (!verdict) continue;

      const normalizedUrl = normalizeUrlForDedup(q.url);
      const existing = urlToVerdict.get(normalizedUrl);
      // Use most recent verdict (by checkedAt/updatedAt) or just overwrite
      // since citation quotes are ordered by recency in the bundle.
      // If no timestamp info, last-write-wins gives the most recent check.
      if (!existing || (q.checkedAt && existing.checkedAt && q.checkedAt > existing.checkedAt) || !existing.checkedAt) {
        urlToVerdict.set(normalizedUrl, { verdict, checkedAt: q.checkedAt ?? null });
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

      const normalizedSource = normalizeUrlForDedup(url);
      const entry = urlToVerdict.get(normalizedSource);
      if (entry) {
        verification[fact.id] = entry.verdict;
        matchCount++;
      }
    }
  }

  console.log(`  kbFactVerification: ${matchCount} facts matched from ${urlToVerdict.size} citation URLs`);
  return verification;
}

/**
 * Build cross-links between FactBase fact source URLs and tracked Resources.
 * Produces two maps:
 *   - resourceUrlToFactIds: normalizedUrl → factId[] (for resource detail pages)
 *   - factIdToResourceId: factId → resourceId (for fact detail pages)
 *
 * Uses normalizeUrlForDedup() for consistent URL normalization.
 *
 * @param {object} kb - Serialized KB data (from build-data)
 * @param {Array<{id: string, url?: string, stable_id?: string}>} resources
 * @returns {{ resourceUrlToFactIds: Record<string, string[]>, factIdToResourceId: Record<string, string> }}
 */
function buildResourceFactLinks(kb, resources) {
  if (!kb || !kb.facts || !resources || resources.length === 0) {
    console.log('  resourceFactLinks: skipped (no KB or resource data)');
    return { resourceUrlToFactIds: {}, factIdToResourceId: {} };
  }

  // Build normalizedUrl → resourceId map from all resources with URLs
  const urlToResourceId = new Map();
  let resourceUrlCount = 0;
  for (const r of resources) {
    if (!r.url) continue;
    const normalized = normalizeUrlForDedup(r.url);
    urlToResourceId.set(normalized, r.id);
    resourceUrlCount++;
  }

  if (urlToResourceId.size === 0) {
    console.log('  resourceFactLinks: 0 matches (no resources with URLs)');
    return { resourceUrlToFactIds: {}, factIdToResourceId: {} };
  }

  // Iterate all facts, match source URLs against resources
  const resourceUrlToFactIds = {};
  const factIdToResourceId = {};
  let matchCount = 0;
  let totalFactsWithUrls = 0;

  for (const facts of Object.values(kb.facts)) {
    for (const fact of facts) {
      const url = (fact.source && typeof fact.source === 'string') ? fact.source : null;
      if (!url) continue;
      if (!url.startsWith('http://') && !url.startsWith('https://')) continue;
      totalFactsWithUrls++;

      const normalizedSource = normalizeUrlForDedup(url);
      const resourceId = urlToResourceId.get(normalizedSource);
      if (resourceId) {
        // Add to resourceUrl → factIds map (keyed by resource ID for lookup)
        if (!resourceUrlToFactIds[resourceId]) {
          resourceUrlToFactIds[resourceId] = [];
        }
        resourceUrlToFactIds[resourceId].push(fact.id);

        // Add to factId → resourceId map
        factIdToResourceId[fact.id] = resourceId;
        matchCount++;
      }
    }
  }

  const resourcesWithFacts = Object.keys(resourceUrlToFactIds).length;
  console.log(`  resourceFactLinks: ${matchCount} facts matched across ${resourcesWithFacts} resources (from ${totalFactsWithUrls} facts with URLs, ${resourceUrlCount} resources with URLs)`);
  return { resourceUrlToFactIds, factIdToResourceId };
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

  // ── Fail-fast: reject duplicate entity IDs ──
  // YAML lists allow duplicate `id` fields without parse errors, but they cause
  // silent data corruption. This was the root cause of a cascading CI failure
  // when merge conflict resolutions duplicated entries in people.yaml.
  {
    const idCounts = new Map();
    for (const e of entities) {
      idCounts.set(e.id, (idCounts.get(e.id) || 0) + 1);
    }
    const dupes = [...idCounts.entries()].filter(([, count]) => count > 1);
    if (dupes.length > 0) {
      console.error('\n  ERROR: Duplicate entity IDs detected:');
      for (const [id, count] of dupes.slice(0, 20)) {
        console.error(`    ${id}: ${count} occurrences`);
      }
      if (dupes.length > 20) console.error(`    ... and ${dupes.length - 20} more`);
      console.error('\n  Fix: run `python3 -c "..."` dedup or check merge conflict resolutions.\n');
      process.exit(1);
    }
  }

  database.entities = entities;

  // =========================================================================
  // ID REGISTRY — derive from wikiId fields in source files (YAML + MDX)
  // =========================================================================
  // Collect page wikiIds so fallback assignment skips IDs already claimed by pages
  const reservedPageWikiIds = collectPageWikiIds(CONTENT_DIR);
  const { slugToWikiId, wikiIdToSlug, byStableId, stableIdBySlug, nextId: nextIdInit } = buildIdRegistry(entities, reservedPageWikiIds);
  let nextId = nextIdInit;
  // Build stableId → slug mapping from YAML entities (for entity resolution
  // in directory pages where ownerEntityId is a stableId rather than a slug)
  const stableIdToSlug = {};
  for (const e of entities) {
    if (e.stableId) {
      stableIdToSlug[e.stableId] = e.id;
    }
  }
  // pgEntityStableIds: union of YAML stableIds + Tier 2 PG-only entities.
  // Tier 2 entities (lightweight personnel, paper authors, minor people) are
  // stored in the PG entities table but have no YAML/MDX representation.
  // Validators (e.g. validate-factbase-record-refs) treat refs to them as
  // resolvable via this list, even though they aren't routable wiki pages.
  // Sorted for deterministic output across runs.
  // Falls back to YAML-only set on wiki-server failure or content-only mode.
  const pgStableIdSet = new Set(Object.keys(byStableId));
  const yamlCount = pgStableIdSet.size;
  if (!CONTENT_ONLY) {
    const pgFetched = await fetchAllEntityStableIds();
    if (pgFetched && pgFetched.length > 0) {
      for (const sid of pgFetched) pgStableIdSet.add(sid);
      const tier2Count = pgStableIdSet.size - yamlCount;
      console.log(
        `  pgEntityStableIds: ${pgStableIdSet.size} total (${yamlCount} YAML + ${tier2Count} Tier 2 PG-only)`,
      );
    } else {
      console.log(
        `  pgEntityStableIds: ${pgStableIdSet.size} (YAML only — wiki-server unavailable for Tier 2)`,
      );
    }
  }
  const idRegistryOutput = {
    byWikiId: { ...wikiIdToSlug },
    bySlug: { ...slugToWikiId },
    stableIdToSlug,
    byStableId: { ...byStableId },
    stableIdBySlug: { ...stableIdBySlug },
    pgEntityStableIds: [...pgStableIdSet].sort(),
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

  // Compute backlinks (pass byStableId so relatedEntries refs using stableIds
  // are resolved to canonical slug keys — see GitHub #2679)
  const backlinks = computeBacklinks(entities, byStableId);
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

  // Load FactBase (structured facts) from YAML.
  // YAML remains the primary source for now — the PG facts table mirrors it
  // via `crux wiki-server sync-facts`. Once PG schema has all Fact fields
  // (validEnd, currency, etc.), PG can become the primary source.
  // The /api/facts/export endpoint is available for PG-based consumers.
  const factbaseDataDir = join(REPO_ROOT, 'packages', 'factbase', 'data');
  if (existsSync(factbaseDataDir)) {
    const { loadKB, serialize } = await import('../../../packages/factbase/src/index.ts');

    // Build TableBase entity map keyed by stableId for FactBase entity injection
    const tableBaseEntityMap = new Map();
    for (const entity of entities) {
      if (entity.stableId) {
        tableBaseEntityMap.set(entity.stableId, {
          id: entity.stableId,
          stableId: entity.stableId,
          type: resolveEntityType(entity.type) || entity.type,
          name: entity.title || entity.id,
          ...(entity.wikiId && { wikiPageId: entity.wikiId, wikiId: entity.wikiId }),
          ...(Array.isArray(entity.aliases) && entity.aliases.length > 0 && { aliases: entity.aliases }),
        });
      }
    }

    const { graph, filenameMap } = await loadKB(factbaseDataDir, {
      entities: tableBaseEntityMap,
    });
    const serializedKB = serialize(graph, filenameMap);

    // Try to load facts from PG (authoritative source) instead of YAML
    if (!CONTENT_ONLY) {
      const pgFacts = await fetchFactsFromPG();
      if (pgFacts) {
        const pgEntityCount = Object.keys(pgFacts).length;
        const pgFactCount = Object.values(pgFacts).reduce((sum, arr) => sum + arr.length, 0);
        serializedKB.facts = pgFacts;
        console.log(`  kb: ${pgEntityCount} entities, ${pgFactCount} facts from PG (properties/schemas from YAML)`);
      } else {
        const factCount = Object.keys(serializedKB.facts ?? {}).length;
        console.log(`  kb: ${factCount} fact groups from YAML fallback (${tableBaseEntityMap.size} TableBase entities injected)`);
      }
    } else {
      const factCount = Object.keys(serializedKB.facts ?? {}).length;
      console.log(`  kb: ${factCount} fact groups (${tableBaseEntityMap.size} TableBase entities injected, entities owned by TableBase)`);
    }

    database.kb = serializedKB;
  } else {
    console.warn('  kb: skipped (data directory not found at packages/factbase/data)');
  }

  // Merge PG-backed personnel and grants into KB records (overrides YAML for these collections)
  if (database.kb && !CONTENT_ONLY) {
    const pgRecordCounts = await mergePGRecordsIntoKB(database.kb);
    const pgTotal = pgRecordCounts.personnel + pgRecordCounts.grants + pgRecordCounts.fundingRounds + pgRecordCounts.investments + pgRecordCounts.equityPositions + pgRecordCounts.divisions + pgRecordCounts.fundingPrograms + pgRecordCounts.divisionPersonnel + pgRecordCounts.entityEvents + pgRecordCounts.entityAssessments + pgRecordCounts.publications;
    if (pgTotal > 0) {
      const parts = [
        `${pgRecordCounts.personnel} personnel`, `${pgRecordCounts.grants} grants`,
        `${pgRecordCounts.fundingRounds} funding rounds`, `${pgRecordCounts.investments} investments`,
        `${pgRecordCounts.equityPositions} equity positions`, `${pgRecordCounts.divisions} divisions`,
        `${pgRecordCounts.fundingPrograms} funding programs`, `${pgRecordCounts.divisionPersonnel} div-personnel`,
        `${pgRecordCounts.entityEvents} events`, `${pgRecordCounts.entityAssessments} assessments`,
        `${pgRecordCounts.publications} publications`,
      ].filter(p => !p.startsWith('0 '));
      console.log(`  kb-pg: ${parts.join(', ')} merged from PG`);
    }
  }

  // Fetch PG-sourced data in parallel (benchmark results, research areas, record verdicts, assessments)
  let assessmentMap = new Map();
  if (!CONTENT_ONLY) {
    const [benchmarkResults, researchAreasData, recordVerdicts, assessments, entityResourceLinks] = await Promise.all([
      fetchBenchmarkResults(),
      fetchResearchAreas(),
      fetchRecordVerdicts(),
      fetchAssessments(),
      fetchEntityResourceLinks(),
    ]);
    database.benchmarkResults = benchmarkResults;
    database.researchAreas = researchAreasData;
    database.recordVerdicts = recordVerdicts;
    assessmentMap = assessments;
    if (entityResourceLinks) {
      database.entityResourceLinks = entityResourceLinks;
    }

    // Fetch detail data (orgs, papers, grants) for each research area
    const areaIds = researchAreasData.map(a => a.id);
    database.researchAreaDetails = await fetchResearchAreaDetails(areaIds);
  }

  // Build URL → resource map for unconverted link detection
  const resources = database.resources || [];
  const urlToResource = buildUrlToResourceMap(resources);
  console.log(`  urlToResource: ${urlToResource.size} canonical URL keys mapped`);

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

  // =========================================================================
  // RESOURCE ↔ FACT CROSS-LINKS — connect FactBase source URLs with Resources
  // =========================================================================
  database.resourceFactLinks = buildResourceFactLinks(database.kb, resources);

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
        slugToWikiId[page.id] = page.wikiId;
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
  // Build URL → resource ID map (used by pageResources URL matching).
  // Exclude forum posts (lesswrong, ea-forum, alignment-forum) from URL matching
  // to prevent casual links to forum posts from appearing as formal page citations.
  // Forum posts should only be associated via explicit <R> citations or cited_by.
  const FORUM_PUBLICATION_IDS = new Set(['lesswrong', 'ea-forum', 'alignment-forum']);
  const urlToId = new Map();
  for (const [url, resource] of urlToResource.entries()) {
    if (resource.publication_id && FORUM_PUBLICATION_IDS.has(resource.publication_id)) continue;
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
        const id = urlToId.get(resourceUrlKey(url));
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
  const relatedGraph = computeRelatedGraph(entities, pages, contentInbound, tagIndex, byStableId);
  database.relatedGraph = relatedGraph;
  console.log(`  relatedGraph: ${Object.keys(relatedGraph).length} entities have connections`);

  // Sync page links to wiki-server (optional — skips if server unavailable)
  if (CONTENT_ONLY) {
    console.log('  linkSync: skipped (content-only scope)');
  } else if (getServerUrl()) {
    const linkSignals = collectLinkSignals(entities, pages, contentInbound, tagIndex, byStableId);
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

    const serverUrl = getServerUrl();
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
  } else if (getServerUrl()) {
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
    database.experts || []
  );
  database.typedEntities = typedEntities;
  // Update description count to reflect post-enrichment state
  stats.withDescription = typedEntities.filter(e => e.description).length;
  console.log(`  typedEntities: ${typedEntities.length} transformed`);

  // Sync policy stakeholders to wiki-server PG table (populates things table too)
  if (!CONTENT_ONLY) {
    await syncPolicyStakeholders(typedEntities);
    // Now fetch the stakeholder IDs (which were 0 if this is the first sync)
    database.policyStakeholderIds = await fetchPolicyStakeholderIds();
  }

  // =========================================================================
  // PRE-WRITE SAFETY CHECK — abort before writing if data is corrupt
  // =========================================================================
  // Two classes of fail-closed errors block the build before output is written:
  //   1. YAML parse errors (always fatal — the YAML files are authoritative,
  //      and a parse error means we'd silently drop data the wiki depends on).
  //   2. Wiki-server unreachable IN CI (full build only). CI runs against
  //      authenticated prod, so a missed fetch indicates a real regression —
  //      shipping a partial database.json would surface as broken UI in prod.
  //      Local dev / agent slots fall through to a warning so offline iteration
  //      keeps working. See `isStrictWikiServerMode()` for the policy.
  const totalYamlErrors = yamlParseErrorCount + getPagesBuilderYamlErrors();
  if (totalYamlErrors > 0) {
    console.error(`\n❌ Build aborted: ${totalYamlErrors} YAML parse error(s) found. Fix them before building.`);
    console.error('database.json was NOT written — the previous version is preserved.');
    process.exit(1);
  }
  const totalWikiServerWarningsPreWrite = getWikiServerWarningCount();
  if (
    totalWikiServerWarningsPreWrite > 0 &&
    isStrictWikiServerMode({ contentOnly: CONTENT_ONLY })
  ) {
    const skipped = getSkippedDataSources();
    console.error(
      `\n❌ Build aborted: ${totalWikiServerWarningsPreWrite} wiki-server API call(s) failed in CI.`,
    );
    console.error('   CI builds require complete wiki-server data; the missing sources were:');
    for (const source of skipped) {
      console.error(`     - ${source}`);
    }
    console.error(
      '   Investigate wiki-server availability and retry. To bypass for an emergency build,',
    );
    console.error(
      '   re-run with `CI=` (unset). database.json was NOT written — the previous version is preserved.',
    );
    process.exit(1);
  }

  // =========================================================================
  // WRITE OUTPUT FILES
  // =========================================================================
  const { databaseForOutput, strippedFields } = writeMainOutputFiles({ database, outputFile: OUTPUT_FILE });

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
    strippedFields,
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

  // ==========================================================================
  // BUILD HEALTH REPORT
  // ==========================================================================
  // Note: YAML errors AND (in CI) wiki-server warnings were already checked
  // pre-write above. If we reach this point, the build either had no failures,
  // or wiki-server warnings were encountered outside CI (degraded but not
  // fatal). The summary below is informational.
  const totalWikiServerWarnings = getWikiServerWarningCount();

  console.log('\n--- Build Health ---');
  console.log(`  Entities loaded:  ${stats.totalEntities}`);
  console.log(`  Pages processed:  ${pages.length}`);
  console.log(`  YAML parse errors:        ${totalYamlErrors}`);
  console.log(`  Wiki-server warnings:     ${totalWikiServerWarnings}`);

  if (totalWikiServerWarnings > 0 && !CONTENT_ONLY) {
    const skipped = getSkippedDataSources();
    console.warn(`\n⚠️  ${totalWikiServerWarnings} wiki-server API call(s) failed during FULL build.`);
    console.warn('   database.json was written but is missing data from:');
    for (const source of skipped) {
      console.warn(`     - ${source}`);
    }
    console.warn('   This is non-fatal outside CI; in CI the pre-write check would have aborted the build.');
  } else if (totalWikiServerWarnings > 0) {
    console.warn(`\nNote: ${totalWikiServerWarnings} wiki-server API call(s) failed (expected in content-only mode).`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
