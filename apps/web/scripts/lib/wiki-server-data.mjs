/**
 * Wiki-Server Data Fetchers
 *
 * All functions that fetch data from the wiki-server API at build time.
 * Includes: edit log dates, citation stats, citation quotes, PG record merging,
 * assessments, benchmark results, research areas, record verdicts, resources,
 * and page reference index.
 *
 * Extracted from build-data.mjs for modularity.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Shared ID detection helpers
// ---------------------------------------------------------------------------

/** The prefix for all entity stableIds. */
const SID_PREFIX = 'sid_';

/**
 * Check if a string is a sid_-prefixed stableId that should never be
 * displayed as a human-readable name.
 */
function isBareMachineId(s) {
  return typeof s === 'string' && s.startsWith(SID_PREFIX);
}

// ---------------------------------------------------------------------------
// Wiki-server warning tracking — exposed via getWikiServerWarningCount()
// Counts actual API failures (not "URL not set" which is expected for local dev).
// ---------------------------------------------------------------------------
let wikiServerWarningCount = 0;

/** Return the number of wiki-server API warnings encountered by this module. */
export function getWikiServerWarningCount() {
  return wikiServerWarningCount;
}

/**
 * Log a wiki-server API failure and increment the warning counter.
 * These are non-fatal: the build continues with fallback data.
 */
function logWikiServerWarning(context, reason) {
  console.log(`  ${context}: skipped (${reason})`);
  wikiServerWarningCount++;
}

/** Build headers for wiki-server API requests, including auth if configured. */
export function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

/**
 * Fetch latest edit dates per page from the wiki-server API.
 * Falls back to an empty map if the server is unavailable.
 */
export async function buildEditLogDateMap() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  editLogDates: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return new Map();
  }

  try {
    const headers = buildHeaders();

    const res = await fetch(`${serverUrl}/api/edit-logs/latest-dates`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logWikiServerWarning('editLogDates', `server returned ${res.status}`);
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
    logWikiServerWarning('editLogDates', err.message || 'server unavailable');
    return new Map();
  }
}

/**
 * Fetch earliest edit dates per page from the wiki-server API.
 * Used as a fallback for dateCreated when git dates were discarded (bulk import)
 * and no frontmatter createdAt exists.
 * Falls back to an empty map if the server is unavailable.
 */
export async function buildEarliestEditLogDateMap() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  earliestEditLogDates: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return new Map();
  }

  try {
    const headers = buildHeaders();

    const res = await fetch(`${serverUrl}/api/edit-logs/earliest-dates`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logWikiServerWarning('earliestEditLogDates', `server returned ${res.status}`);
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
    logWikiServerWarning('earliestEditLogDates', err.message || 'server unavailable');
    return new Map();
  }
}

/**
 * Fetch per-page citation stats from the wiki-server API.
 * Returns a Map of pageId -> { total, verified, accurate, inaccurate, avgScore }.
 * Falls back to an empty map if the server is unavailable.
 */
export async function buildCitationStatsMap() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  citationStats: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return new Map();
  }

  try {
    const headers = buildHeaders();

    const res = await fetch(`${serverUrl}/api/citations/page-stats`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logWikiServerWarning('citationStats', `server returned ${res.status}`);
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
    logWikiServerWarning('citationStats', err.message || 'server unavailable');
    return new Map();
  }
}

/**
 * Fetch all citation quotes from wiki-server, grouped by pageId.
 * Used by the frontend to render citation health banners and footnote tooltips
 * without making per-page API calls at runtime.
 * Returns { [pageId]: CitationQuote[] } or empty object if unavailable.
 */
export async function buildCitationQuotesBundle() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  citationQuotes: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return {};
  }

  try {
    const headers = buildHeaders();

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
        logWikiServerWarning('citationQuotes', `server returned ${res.status}`);
        return {};
      }
      const data = await res.json();
      allQuotes.push(...(data.quotes || []));
      if (data.quotes.length < limit) break;
      offset += limit;
    }

    // Group by page slug (the /quotes/all endpoint now includes pageSlug
    // via a join with wiki_pages). Fall back to pageId for backward compat
    // with older wiki-server versions that don't include pageSlug.
    const byPage = {};
    for (const q of allQuotes) {
      const key = q.pageSlug || q.pageId;
      if (!key) continue;
      if (!byPage[key]) byPage[key] = [];
      byPage[key].push({
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
    logWikiServerWarning('citationQuotes', err.message || 'server unavailable');
    return {};
  }
}

/** Map from frontmatter rating name -> PG assessment column name. */
const RATING_FIELD_MAP = {
  focus: 'ratingFocus',
  novelty: 'ratingNovelty',
  rigor: 'ratingRigor',
  completeness: 'ratingCompleteness',
  concreteness: 'ratingConcreteness',
  actionability: 'ratingActionability',
  objectivity: 'ratingObjectivity',
};

/**
 * Build a ratings object from a PG assessment, falling back to frontmatter ratings
 * for any missing dimensions.
 */
export function buildRatingsFromAssessment(assessment, fmRatings) {
  const ratings = {};
  let hasAny = false;

  for (const [shortName, pgName] of Object.entries(RATING_FIELD_MAP)) {
    const val = assessment[pgName] ?? (fmRatings ? fmRatings[shortName] : null) ?? null;
    if (val != null) {
      ratings[shortName] = val;
      hasAny = true;
    }
  }

  return hasAny ? ratings : (fmRatings || null);
}

/**
 * Fetch latest page assessments from wiki-server PG tables.
 * Returns a Map<pageSlug, coalesced assessment> where scores are merged
 * across assessors (llm-grading > frontmatter-sync > structural for quality).
 * Falls back to empty map if wiki-server is unavailable.
 */
export async function fetchAssessments() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  assessments: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return new Map();
  }

  const headers = buildHeaders();

  try {
    // Paginate through all latest assessments (one per page per assessor)
    const allRows = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const url = `${serverUrl}/api/assessments/latest?limit=${pageSize}&offset=${offset}`;
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) {
        logWikiServerWarning('assessments', `HTTP ${resp.status}`);
        return new Map();
      }
      const data = await resp.json();
      const items = data.assessments || [];
      allRows.push(...items);
      if (items.length < pageSize) break;
      offset += pageSize;
    }

    // Coalesce: for each page, pick the best value per dimension across assessors.
    // Priority: llm-grading > editorial > frontmatter-sync > structural
    const ASSESSOR_PRIORITY = { 'llm-grading': 3, 'editorial': 2, 'frontmatter-sync': 1, 'structural': 0 };
    const COALESCE_FIELDS = [
      'quality', 'readerImportance', 'researchImportance', 'tacticalValue',
      'ratingFocus', 'ratingNovelty', 'ratingRigor', 'ratingCompleteness',
      'ratingConcreteness', 'ratingActionability', 'ratingObjectivity',
      'structuralScore', 'wordCount',
    ];

    const byPage = new Map();       // pageId -> coalesced assessment values
    const priorities = new Map();    // pageId -> { [field]: priority }

    for (const row of allRows) {
      const pageId = row.pageId;
      if (!pageId) continue;

      if (!byPage.has(pageId)) {
        byPage.set(pageId, {});
        priorities.set(pageId, {});
      }
      const entry = byPage.get(pageId);
      const fieldPriorities = priorities.get(pageId);
      const priority = ASSESSOR_PRIORITY[row.assessor] ?? -1;

      for (const field of COALESCE_FIELDS) {
        if (row[field] != null && priority >= (fieldPriorities[field] ?? -1)) {
          entry[field] = row[field];
          fieldPriorities[field] = priority;
        }
      }
    }

    if (byPage.size > 0) {
      console.log(`  assessments: ${allRows.length} rows coalesced into ${byPage.size} pages from PG`);
    }
    return byPage;
  } catch (err) {
    logWikiServerWarning('assessments', err instanceof Error ? err.message : String(err));
    return new Map();
  }
}

/**
 * Fetch benchmark results from wiki-server PG tables.
 * Returns a map of modelId -> array of { benchmarkId, score, unit }.
 * Falls back to empty object if wiki-server is unavailable.
 */
export async function fetchBenchmarkResults() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  benchmark-results: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return {};
  }

  const headers = buildHeaders();

  try {
    // Fetch the benchmarks table to build a PG id -> entity slug mapping.
    // PG benchmark_results.benchmark_id references benchmarks.id (a random string),
    // but the frontend expects entity slugs (e.g., "mmlu", "swe-bench-verified").
    const benchmarkIdToSlug = new Map();
    try {
      const bmFetchOpts = { headers, signal: AbortSignal.timeout(15_000) };
      let bmOffset = 0;
      while (true) {
        const bmUrl = `${serverUrl}/api/benchmarks/all?limit=200&offset=${bmOffset}`;
        const bmResp = await fetch(bmUrl, bmFetchOpts);
        if (!bmResp.ok) break;
        const bmData = await bmResp.json();
        const bmItems = bmData.benchmarks || [];
        for (const bm of bmItems) {
          benchmarkIdToSlug.set(bm.id, bm.slug);
        }
        if (bmItems.length < 200) break;
        bmOffset += 200;
      }
    } catch (err) {
      console.log(`  benchmark-results: slug lookup failed (${err instanceof Error ? err.message : err})`);
    }

    const resultsFetchOpts = { headers, signal: AbortSignal.timeout(30_000) };
    const pageSize = 200;
    let allItems = [];
    let offset = 0;
    while (true) {
      const url = `${serverUrl}/api/benchmark-results/all?limit=${pageSize}&offset=${offset}`;
      const resp = await fetch(url, resultsFetchOpts);
      if (!resp.ok) {
        logWikiServerWarning('benchmark-results', `HTTP ${resp.status}`);
        return {};
      }
      const data = await resp.json();
      const items = data.benchmarkResults || [];
      allItems = allItems.concat(items);
      if (items.length < pageSize) break;
      offset += pageSize;
    }

    // Group by modelId, resolving PG benchmarkId to entity slug
    const byModel = {};
    let unresolvedCount = 0;
    for (const row of allItems) {
      const slug = benchmarkIdToSlug.get(row.benchmarkId) || row.benchmarkId;
      if (!benchmarkIdToSlug.has(row.benchmarkId)) unresolvedCount++;
      if (!byModel[row.modelId]) byModel[row.modelId] = [];
      byModel[row.modelId].push({
        benchmarkId: slug,
        score: row.score,
        unit: row.unit,
        date: row.date,
        sourceUrl: row.sourceUrl,
      });
    }

    const modelCount = Object.keys(byModel).length;
    if (allItems.length > 0) {
      console.log(`  benchmark-results: ${allItems.length} results for ${modelCount} models fetched from PG (${benchmarkIdToSlug.size} benchmark slugs resolved${unresolvedCount > 0 ? `, ${unresolvedCount} unresolved` : ''})`);
    }
    return byModel;
  } catch (err) {
    logWikiServerWarning('benchmark-results', err instanceof Error ? err.message : String(err));
    return {};
  }
}

/**
 * Fetch enriched research areas from wiki-server PG tables.
 * Returns an array of enriched research area objects.
 * Falls back to empty array if wiki-server is unavailable.
 */
export async function fetchResearchAreas() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  research-areas: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return [];
  }

  const headers = buildHeaders();
  const fetchOpts = { headers, signal: AbortSignal.timeout(30_000) };

  try {
    const pageSize = 200;
    let allItems = [];
    let offset = 0;
    while (true) {
      const url = `${serverUrl}/api/research-areas/enriched?limit=${pageSize}&offset=${offset}`;
      const resp = await fetch(url, fetchOpts);
      if (!resp.ok) {
        logWikiServerWarning('research-areas', `HTTP ${resp.status}`);
        return [];
      }
      const data = await resp.json();
      const items = data.researchAreas || [];
      allItems = allItems.concat(items);
      if (items.length < pageSize) break;
      offset += pageSize;
    }

    if (allItems.length > 0) {
      console.log(`  research-areas: ${allItems.length} enriched areas fetched from PG`);
    }
    return allItems;
  } catch (err) {
    logWikiServerWarning('research-areas', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Fetch detail data (organizations, papers, grants, fundingByOrg) for each
 * research area. Returns a map keyed by area ID.
 *
 * This replaces the ISR-based per-page fetch that was unreliable during builds.
 */
export async function fetchResearchAreaDetails(areaIds) {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl || areaIds.length === 0) {
    console.log('  research-area-details: skipped (no server or no areas)');
    return {};
  }

  const headers = buildHeaders();
  const details = {};
  let fetched = 0;
  let failed = 0;

  // Fetch in parallel with a concurrency limit of 10
  const CONCURRENCY = 10;
  for (let i = 0; i < areaIds.length; i += CONCURRENCY) {
    const batch = areaIds.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (id) => {
        const resp = await fetch(`${serverUrl}/api/research-areas/${id}`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return { id, data: await resp.json() };
      })
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { id, data } = result.value;
        details[id] = {
          organizations: data.organizations ?? [],
          papers: data.papers ?? [],
          grants: data.grants ?? [],
          fundingByOrg: data.fundingByOrg ?? [],
        };
        fetched++;
      } else {
        failed++;
      }
    }
  }

  console.log(`  research-area-details: ${fetched} fetched, ${failed} failed`);
  return details;
}

/**
 * Fetch verification verdicts from wiki-server (unified verification system).
 * Returns a map keyed by "recordType:recordId" -> verdict info.
 */
export async function fetchRecordVerdicts() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  record-verdicts: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return {};
  }

  const headers = buildHeaders();

  try {
    const pageSize = 200;
    const verdicts = {};
    let offset = 0;
    while (true) {
      const url = `${serverUrl}/api/verifications/verdicts?limit=${pageSize}&offset=${offset}`;
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) {
        logWikiServerWarning('record-verdicts', `HTTP ${resp.status}`);
        return {};
      }
      const data = await resp.json();
      const items = data.verdicts || [];
      for (const v of items) {
        verdicts[`${v.recordType}:${v.recordId}`] = {
          verdict: v.verdict,
          confidence: v.confidence,
          sourcesChecked: v.sourcesChecked,
          needsRecheck: v.needsRecheck,
          lastComputedAt: v.lastComputedAt,
        };
      }
      if (items.length < pageSize) break;
      offset += pageSize;
    }

    const count = Object.keys(verdicts).length;
    if (count > 0) {
      console.log(`  record-verdicts: ${count} verdicts fetched from PG`);
    } else {
      console.log('  record-verdicts: 0 verdicts (none computed yet)');
    }
    return verdicts;
  } catch (err) {
    logWikiServerWarning('record-verdicts', err instanceof Error ? err.message : String(err));
    return {};
  }
}

/**
 * Fetch all FactBase facts from the wiki-server PG database.
 * Returns facts grouped by entity ID in the SerializedKB.facts format,
 * or null if the server is unavailable.
 *
 * When available, this replaces the YAML-based loading in build-data.mjs,
 * making PG the source of truth for facts.
 */
export async function fetchFactBaseFromServer() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  factbase-export: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return null;
  }

  const headers = buildHeaders();

  try {
    const url = `${serverUrl}/api/facts/export`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) {
      logWikiServerWarning('factbase-export', `HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const entityCount = data.entities ?? Object.keys(data.facts ?? {}).length;
    const factCount = data.total ?? 0;
    console.log(`  factbase-export: ${factCount} facts across ${entityCount} entities (from PG)`);
    return data.facts ?? {};
  } catch (err) {
    logWikiServerWarning('factbase-export', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Fetch policy stakeholder IDs from wiki-server.
 * Returns a map keyed by "policyEntityId:stakeholderDisplayName" -> stakeholder PG ID.
 * Used by the legislation page to look up verification verdicts for each stakeholder row.
 *
 * The policyEntityId key is the entity stableId (the FK in PG), so callers must use
 * the entity stableId when looking up — not the slug.
 */
export async function fetchPolicyStakeholderIds() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  policy-stakeholder-ids: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return {};
  }

  const headers = buildHeaders();

  try {
    // Fetch all policy stakeholders from PG via the things table.
    // Each thing row has sourceId = PG stakeholder ID, parentThingId = policy entity stableId.
    const pageSize = 200;
    const idMap = {};
    let offset = 0;
    while (true) {
      const url = `${serverUrl}/api/things?thing_type=policy-stakeholder&limit=${pageSize}&offset=${offset}`;
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) {
        logWikiServerWarning('policy-stakeholder-ids', `HTTP ${resp.status}`);
        return {};
      }
      const data = await resp.json();
      const items = data.things || [];
      for (const t of items) {
        // title format: "Stakeholder Name on Policy Title"
        // parentThingId is the policy entity's stableId
        // sourceId is the PG stakeholder ID (same as the things row's sourceId)
        if (t.sourceId && t.parentThingId) {
          const onIdx = t.title?.indexOf(' on ');
          if (onIdx > 0) {
            const stakeholderName = t.title.substring(0, onIdx);
            idMap[`${t.parentThingId}:${stakeholderName}`] = t.sourceId;
          }
        }
      }
      if (items.length < pageSize) break;
      offset += pageSize;
    }

    const count = Object.keys(idMap).length;
    if (count > 0) {
      console.log(`  policy-stakeholder-ids: ${count} stakeholder ID mappings fetched`);
    }
    return idMap;
  } catch (err) {
    logWikiServerWarning('policy-stakeholder-ids', err instanceof Error ? err.message : String(err));
    return {};
  }
}

/**
 * Sync policy stakeholders from YAML entities to the wiki-server PG table.
 * This populates `policy_stakeholders` and dual-writes to the `things` table.
 * Must be called after typedEntities are built so we have access to policy data.
 *
 * @param {Array} typedEntities — the full typedEntities array from database
 */
export async function syncPolicyStakeholders(typedEntities) {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  policy-stakeholder-sync: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return;
  }

  const headers = buildHeaders();
  const policies = typedEntities.filter(e => e.entityType === 'policy' && e.stakeholders?.length > 0);
  if (policies.length === 0) {
    console.log('  policy-stakeholder-sync: 0 policies with stakeholders');
    return;
  }

  // Build sync items — generate deterministic 10-char IDs from policy+stakeholder
  const items = [];
  for (const policy of policies) {
    if (!policy.stableId) {
      console.warn(`  policy-stakeholder-sync: policy "${policy.id}" has no stableId — skipping`);
      continue;
    }
    const policyEntityId = policy.stableId;
    for (const s of policy.stakeholders) {
      // Deterministic ID: hash of policyId + stakeholder name
      const raw = `${policyEntityId}:${s.name}`;
      const id = generateShortId(raw);
      const item = {
        id,
        policyEntityId,
        stakeholderEntityId: s.entityId || null,
        stakeholderDisplayName: s.name,
        position: s.position,
        reason: s.reason || null,
        source: s.source || null,
        context: s.context || null,
      };
      // Only include importance if set (avoids schema errors if column doesn't exist yet)
      if (s.importance) item.importance = s.importance;
      items.push(item);
    }
  }

  // Sync individually to handle FK errors gracefully (some entityIds may not exist in PG)
  let synced = 0;
  let skipped = 0;
  try {
    // Batch in groups of 50 for efficiency, fall back to individual on error
    const batchSize = 50;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const resp = await fetch(`${serverUrl}/api/policy-stakeholders/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ items: batch }),
        signal: AbortSignal.timeout(30_000),
      });
      if (resp.ok) {
        const data = await resp.json();
        synced += data.upserted || 0;
      } else {
        // Batch failed — try items individually to skip bad FK references
        for (const item of batch) {
          try {
            const r = await fetch(`${serverUrl}/api/policy-stakeholders/sync`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ items: [item] }),
              signal: AbortSignal.timeout(10_000),
            });
            if (r.ok) {
              synced++;
            } else {
              skipped++;
            }
          } catch {
            skipped++;
          }
        }
      }
    }
    const msg = `${synced} stakeholders synced to PG (${policies.length} policies)`;
    console.log(`  policy-stakeholder-sync: ${msg}${skipped ? `, ${skipped} skipped (FK errors)` : ''}`);
  } catch (err) {
    logWikiServerWarning('policy-stakeholder-sync', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Generate a deterministic 10-char ID from a string using SHA-256.
 * Matches the pattern used by crux/lib/grant-import/id.ts:generateId().
 */
function generateShortId(input) {
  return createHash('sha256').update(input).digest('base64url').substring(0, 10);
}

/**
 * Convert a PG personnel row to the RecordEntry format used by frontend components.
 * PG stores canonical entity IDs in personId/organizationId.
 */
function personnelRowToRecordEntry(row) {
  const fields = {};
  const schemaMap = {
    'key-person': 'key-person',
    'board': 'board-seat',
    'career': 'career-history',
  };
  const schema = schemaMap[row.roleType] || row.roleType;

  // Prefer resolved FK columns (sid_-prefixed) over raw columns (may be bare IDs)
  const resolvedPersonId = row.personEntityId || row.personId;
  const resolvedOrgId = row.orgEntityId || row.organizationId;

  if (row.roleType === 'key-person') {
    fields.person = resolvedPersonId;
    fields.title = row.role;
    if (row.startDate) fields.start = row.startDate;
    if (row.endDate) fields.end = row.endDate;
    if (row.isFounder) fields.is_founder = true;
  } else if (row.roleType === 'board') {
    fields.member = resolvedPersonId;
    fields.role = row.role;
    if (row.startDate) fields.appointed = row.startDate;
    if (row.endDate) fields.departed = row.endDate;
    if (row.appointedBy) fields.appointed_by = row.appointedBy;
    if (row.background) fields.background = row.background;
  } else if (row.roleType === 'career') {
    fields.organization = resolvedOrgId;
    fields.title = row.role;
    if (row.startDate) fields.start = row.startDate;
    if (row.endDate) fields.end = row.endDate;
  }

  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;

  const entry = {
    key: row.id,
    schema,
    ownerEntityId: row.roleType === 'career' ? resolvedPersonId : resolvedOrgId,
    fields,
  };
  // Embed resolved display name from API JOIN (personnel API returns personResolvedName).
  // Filter out bare stableIds and numeric PKs that aren't human-readable.
  if (row.personResolvedName && !isBareMachineId(row.personResolvedName)) entry.displayName = row.personResolvedName;
  return entry;
}

/**
 * Convert a PG grant row to the RecordEntry format used by frontend components.
 */
function grantRowToRecordEntry(row) {
  const fields = {
    name: row.name,
  };
  if (row.amount != null) fields.amount = row.amount;
  // Skip purely numeric granteeIds — these are unresolved internal IDs from
  // external systems (e.g., Open Philanthropy) that aren't meaningful as
  // entity references or display names.
  if (row.granteeId && !/^\d+$/.test(row.granteeId)) fields.recipient = row.granteeId;
  if (row.period) fields.period = row.period;
  if (row.date) fields.date = row.date;
  if (row.status) fields.status = row.status;
  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;
  if (row.programId) fields.programId = row.programId;

  const entry = {
    key: row.id,
    schema: 'grant',
    ownerEntityId: row.orgEntityId || row.organizationId,
    fields,
  };
  // Embed resolved grantee display name from entity ref.
  // Filter out bare machine IDs that aren't human-readable.
  if (row.grantee?.name && !isBareMachineId(row.grantee.name)) entry.displayName = row.grantee.name;
  return entry;
}

/**
 * Convert a PG funding round row to the RecordEntry format used by frontend components.
 */
function fundingRoundRowToRecordEntry(row) {
  const fields = {
    name: row.name,
  };
  if (row.date) fields.date = row.date;
  if (typeof row.raised === "number") fields.raised = row.raised;
  if (typeof row.valuation === "number") fields.valuation = row.valuation;
  if (row.instrument) fields.instrument = row.instrument;
  if (row.leadInvestorRaw) fields.lead_investor = row.leadInvestorRaw;
  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;
  // Embed the server-side-resolved company name so the frontend can display it
  // even when companyRef.entityId is null (legacy numeric companyId rows).
  // Filter out bare stableIds (10 alphanumeric chars with uppercase) and numeric PKs
  // that leak through as company names — these aren't human-readable.
  if (row.companyRef?.name && !isBareMachineId(row.companyRef.name)) fields.company_name = row.companyRef.name;
  else if (row.companyResolvedName && !isBareMachineId(row.companyResolvedName)) fields.company_name = row.companyResolvedName;

  const entry = {
    key: row.id,
    schema: 'funding-round',
    // Prefer companyRef.entityId (proper stableId FK) over legacy companyId for entity resolution.
    // Falls back to companyId only if it looks like a slug (not a numeric DB PK).
    ownerEntityId: row.companyRef?.entityId ?? (/^\d+$/.test(row.companyId) ? null : row.companyId),
    fields,
  };
  // Embed resolved lead investor display name from entity ref.
  // Filter out bare machine IDs that aren't human-readable.
  if (row.leadInvestorRef?.name && !isBareMachineId(row.leadInvestorRef.name)) entry.displayName = row.leadInvestorRef.name;
  return entry;
}

/**
 * Convert a PG investment row to the RecordEntry format used by frontend components.
 */
function investmentRowToRecordEntry(row) {
  const fields = {};
  fields.investor = row.investorEntityId || row.investorId;
  if (row.roundName) fields.round_name = row.roundName;
  if (row.date) fields.date = row.date;
  if (row.amount != null) fields.amount = row.amount;
  if (row.stakeAcquired != null) {
    // Parse JSON array back to array if applicable, otherwise use as number
    try {
      const parsed = JSON.parse(row.stakeAcquired);
      if (Array.isArray(parsed)) {
        fields.stake_acquired = parsed;
      } else {
        fields.stake_acquired = typeof parsed === 'number' ? parsed : row.stakeAcquired;
      }
    } catch {
      const n = Number(row.stakeAcquired);
      fields.stake_acquired = isNaN(n) ? row.stakeAcquired : n;
    }
  }
  if (row.instrument) fields.instrument = row.instrument;
  if (row.role) fields.role = row.role;
  if (row.conditions) fields.conditions = row.conditions;
  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;

  const entry = {
    key: row.id,
    schema: 'investment',
    ownerEntityId: row.companyEntityId || row.companyId,
    fields,
  };
  // Embed resolved investor display name from entity ref.
  // Filter out bare machine IDs that aren't human-readable.
  if (row.investor?.name && !isBareMachineId(row.investor.name)) entry.displayName = row.investor.name;
  return entry;
}

/**
 * Convert a PG equity position row to the RecordEntry format used by frontend components.
 */
function equityPositionRowToRecordEntry(row) {
  const fields = {};
  fields.holder = row.holderEntityId || row.holderId;
  if (row.stake) {
    // Parse JSON array back to array if applicable, otherwise use as number
    try {
      const parsed = JSON.parse(row.stake);
      if (Array.isArray(parsed)) {
        fields.stake = parsed;
      } else {
        fields.stake = typeof parsed === 'number' ? parsed : row.stake;
      }
    } catch {
      const n = Number(row.stake);
      fields.stake = isNaN(n) ? row.stake : n;
    }
  }
  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;

  const entry = {
    key: row.id,
    schema: 'equity-position',
    ownerEntityId: row.companyEntityId || row.companyId,
    fields,
  };
  if (row.asOf) entry.asOf = row.asOf;
  if (row.validEnd) entry.validEnd = row.validEnd;
  // Embed resolved holder display name from entity ref.
  // Filter out bare machine IDs that aren't human-readable.
  if (row.holder?.name && !isBareMachineId(row.holder.name)) entry.displayName = row.holder.name;
  return entry;
}

/**
 * Convert a PG division row to the RecordEntry format used by frontend components.
 */
function divisionRowToRecordEntry(row) {
  const fields = {
    name: row.name,
    divisionType: row.divisionType,
  };
  if (row.slug) fields.slug = row.slug;
  if (row.lead) fields.lead = row.lead;
  if (row.status) fields.status = row.status;
  if (row.startDate) fields.startDate = row.startDate;
  if (row.endDate) fields.endDate = row.endDate;
  if (row.website) fields.website = row.website;
  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;

  return {
    key: row.id,
    schema: 'division',
    ownerEntityId: row.parentOrgId,
    fields,
  };
}

/**
 * Convert a PG funding program row to the RecordEntry format used by frontend components.
 */
function fundingProgramRowToRecordEntry(row) {
  const fields = {
    name: row.name,
    programType: row.programType,
  };
  if (row.description) fields.description = row.description;
  if (row.divisionId) fields.divisionId = row.divisionId;
  if (row.totalBudget != null) fields.totalBudget = row.totalBudget;
  if (row.currency) fields.currency = row.currency;
  if (row.applicationUrl) fields.applicationUrl = row.applicationUrl;
  if (row.openDate) fields.openDate = row.openDate;
  if (row.deadline) fields.deadline = row.deadline;
  if (row.status) fields.status = row.status;
  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;

  return {
    key: row.id,
    schema: 'funding-program',
    ownerEntityId: row.orgId,
    fields,
  };
}

/**
 * Convert a PG division personnel row to the RecordEntry format used by frontend components.
 */
function divisionPersonnelRowToRecordEntry(row) {
  const fields = {
    personId: row.personId,
    role: row.role,
  };
  if (row.startDate) fields.startDate = row.startDate;
  if (row.endDate) fields.endDate = row.endDate;
  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;

  return {
    key: row.id,
    schema: 'division-personnel',
    ownerEntityId: `__division__${row.divisionId}`,
    fields,
  };
}

/**
 * Convert a PG entity event row to the RecordEntry format.
 */
function entityEventRowToRecordEntry(row) {
  const fields = {
    title: row.title,
    date: row.date,
    eventType: row.eventType,
  };
  if (row.description) fields.description = row.description;
  if (row.significance) fields.significance = row.significance;
  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;

  return {
    key: row.id,
    schema: 'entity-event',
    ownerEntityId: row.entityId,
    fields,
  };
}

/**
 * Convert a PG entity assessment row to the RecordEntry format.
 */
function entityAssessmentRowToRecordEntry(row) {
  const fields = {
    dimension: row.dimension,
    rating: row.rating,
  };
  if (row.evidence) fields.evidence = row.evidence;
  if (row.assessor) fields.assessor = row.assessor;
  if (row.assessedAt) fields.assessedAt = row.assessedAt;
  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;

  return {
    key: row.id,
    schema: 'entity-assessment',
    ownerEntityId: row.entityId,
    fields,
  };
}

/**
 * Convert a PG publication row to the RecordEntry format.
 */
function publicationRowToRecordEntry(row) {
  const fields = {
    title: row.title,
    publicationType: row.publicationType,
  };
  if (row.authors) fields.authors = row.authors;
  if (row.url) fields.url = row.url;
  if (row.venue) fields.venue = row.venue;
  if (row.publishedDate) fields.publishedDate = row.publishedDate;
  if (row.citationCount != null) fields.citationCount = row.citationCount;
  if (row.isFlagship) fields.isFlagship = row.isFlagship;
  if (row.abstract) fields.abstract = row.abstract;
  if (row.resourceId) fields.resourceId = row.resourceId;
  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;

  return {
    key: row.id,
    schema: 'publication',
    ownerEntityId: row.entityId,
    fields,
  };
}

/**
 * Fetch personnel, grants, funding rounds, investments, equity positions,
 * entity events, entity assessments, and publications from the wiki-server
 * PG tables and merge them into the serialized KB records structure
 * (same format as YAML-sourced records).
 *
 * PG stores canonical entity IDs (10-char) in personId/organizationId fields,
 * which match the keys used in kb.records. No slug->entityId remapping needed.
 *
 * For collections that exist in both YAML and PG, PG records replace YAML.
 * Falls back gracefully if the wiki-server is unavailable (YAML records remain).
 */

/**
 * Mapping from stale FactBase entity IDs to their canonical TableBase stableIds.
 *
 * These IDs exist in the PG database because records were imported before the
 * entity was unified into the TableBase. The frontend resolves names via
 * getTypedEntityById(stableId), which only knows the canonical ID.
 *
 * Add entries here whenever a FactBase ID is retired and superseded by a
 * TableBase stableId (i.e. after running `pnpm crux ids allocate`).
 *
 * Entries are applied by normalizePGEntityId() during the PG→KB merge.
 */
const STALE_ENTITY_ID_MAP = {
  // SFF: old FactBase ID → TableBase stableId (pvJ50HupEQ = "sff" entity).
  // Grants/funding-programs in PG were imported with organizationId = "sIFjGbxVct"
  // before Entity Unification. See crux/lib/grant-import/constants.ts.
  // Fix tracked in: https://github.com/quantified-uncertainty/longterm-wiki/issues/2681
  sIFjGbxVct: 'pvJ50HupEQ',
};

/**
 * Normalize a PG entity ID by mapping any stale FactBase IDs to their
 * canonical TableBase stableIds. Returns the input unchanged if not stale.
 *
 * @param {string | null | undefined} id - raw entity ID from PG
 * @returns {string | null | undefined}
 */
function normalizePGEntityId(id) {
  if (!id) return id;
  return STALE_ENTITY_ID_MAP[id] ?? id;
}

/**
 * Fetch all facts from PG via the wiki-server /api/facts/export endpoint.
 * Returns facts grouped by entityId in the KB Fact shape, or null if unavailable.
 */
export async function fetchFactsFromPG() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  kb-facts-pg: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return null;
  }

  const headers = buildHeaders();

  try {
    const resp = await fetch(`${serverUrl}/api/facts/export`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      console.warn(`  kb-facts-pg: failed (HTTP ${resp.status})`);
      return null;
    }
    const data = await resp.json();
    return data.facts ?? null;
  } catch (err) {
    console.warn(`  kb-facts-pg: failed (${err.message})`);
    return null;
  }
}

export async function mergePGRecordsIntoKB(kb) {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  kb-pg: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return { personnel: 0, grants: 0, fundingRounds: 0, investments: 0, equityPositions: 0, divisions: 0, fundingPrograms: 0, divisionPersonnel: 0, entityEvents: 0, entityAssessments: 0, publications: 0 };
  }

  const headers = buildHeaders();

  let personnelCount = 0;
  let grantsCount = 0;
  let fundingRoundsCount = 0;
  let investmentsCount = 0;
  let equityPositionsCount = 0;
  let divisionsCount = 0;
  let fundingProgramsCount = 0;
  let divisionPersonnelCount = 0;
  let entityEventsCount = 0;
  let entityAssessmentsCount = 0;
  let publicationsCount = 0;

  if (!kb.records) kb.records = {};

  // Fetch all pages (paginate to avoid truncation at MAX_PAGE_SIZE)
  const fetchOpts = { headers, signal: AbortSignal.timeout(30_000) };

  /**
   * Generic paginated fetcher. `itemsKey` is the response field containing the array.
   */
  async function fetchAllPages(endpoint, itemsKey) {
    const pageSize = 200;
    let allItems = [];
    let offset = 0;
    while (true) {
      const url = `${serverUrl}${endpoint}?limit=${pageSize}&offset=${offset}`;
      const resp = await fetch(url, fetchOpts);
      if (!resp.ok) return null;
      const data = await resp.json();
      const items = data[itemsKey] || [];
      allItems = allItems.concat(items);
      if (items.length < pageSize) break; // last page
      offset += pageSize;
    }
    return allItems;
  }

  const [
    personnelResult,
    grantsResult,
    fundingRoundsResult,
    investmentsResult,
    equityPositionsResult,
    divisionsResult,
    fundingProgramsResult,
    divisionPersonnelResult,
    entityEventsResult,
    entityAssessmentsResult,
    publicationsResult,
  ] = await Promise.allSettled([
    fetchAllPages('/api/personnel/all', 'personnel'),
    fetchAllPages('/api/grants/all', 'grants'),
    fetchAllPages('/api/funding-rounds/all', 'fundingRounds'),
    fetchAllPages('/api/investments/all', 'investments'),
    fetchAllPages('/api/equity-positions/all', 'equityPositions'),
    fetchAllPages('/api/divisions/all', 'divisions'),
    fetchAllPages('/api/funding-programs/all', 'fundingPrograms'),
    fetchAllPages('/api/division-personnel/all', 'divisionPersonnel'),
    fetchAllPages('/api/entity-events/all', 'events'),
    fetchAllPages('/api/entity-assessments/all', 'assessments'),
    fetchAllPages('/api/publications/all', 'publications'),
  ]);

  /**
   * Helper: clear YAML collections, replace with PG rows.
   * @param {string} label - for logging
   * @param {object} result - Promise.allSettled result
   * @param {string[]} yamlCollections - collections to clear from kb.records
   * @param {function} getEntityKey - (row) => entity key
   * @param {function} getCollectionName - (row) => collection name
   * @param {function} rowToEntry - (row) => RecordEntry
   * @returns {number} count of records merged
   */
  function mergeCollection(label, result, yamlCollections, getEntityKey, getCollectionName, rowToEntry) {
    const rows = result.status === 'fulfilled' ? result.value : null;
    if (!rows) {
      const reason = result.status === 'rejected' ? result.reason?.message : 'no data';
      logWikiServerWarning(`kb-pg ${label}`, reason || 'server unavailable');
      return 0;
    }
    if (rows.length === 0) return 0;

    // Clear YAML-sourced collections — PG is the authority when available
    for (const entityKey of Object.keys(kb.records)) {
      for (const collection of yamlCollections) {
        if (kb.records[entityKey]?.[collection]) {
          delete kb.records[entityKey][collection];
          if (Object.keys(kb.records[entityKey]).length === 0) {
            delete kb.records[entityKey];
          }
        }
      }
    }

    let count = 0;
    for (const row of rows) {
      const entityKey = normalizePGEntityId(getEntityKey(row));
      const collectionName = getCollectionName(row);
      if (!entityKey || !collectionName) continue;

      if (!kb.records[entityKey]) kb.records[entityKey] = {};
      if (!kb.records[entityKey][collectionName]) kb.records[entityKey][collectionName] = [];

      kb.records[entityKey][collectionName].push(rowToEntry(row));
      count++;
    }
    return count;
  }

  // --- Process personnel ---
  personnelCount = mergeCollection(
    'personnel',
    personnelResult,
    ['key-persons', 'board-seats', 'career-history'],
    (row) => {
      if (row.roleType === 'career') return row.personEntityId || row.personId;
      return row.orgEntityId || row.organizationId;
    },
    (row) => {
      if (row.roleType === 'key-person') return 'key-persons';
      if (row.roleType === 'board') return 'board-seats';
      if (row.roleType === 'career') return 'career-history';
      return null;
    },
    personnelRowToRecordEntry,
  );

  // --- Process grants ---
  grantsCount = mergeCollection(
    'grants',
    grantsResult,
    ['grants'],
    (row) => row.orgEntityId || row.organizationId,
    () => 'grants',
    grantRowToRecordEntry,
  );

  // --- Process funding rounds ---
  // Deduplicate funding rounds where a legacy row (numeric companyId like "378")
  // coexists with a corrected row (stableId like "sid_mK9pX3rQ7n") for the same
  // entity+name.  Both map to the same companyRef.entityId after FK resolution,
  // but the legacy row typically has wrong amounts/dates.  Drop the legacy row
  // when a stableId-keyed row exists for the same (entityKey, name) pair.
  //
  // Rows where BOTH have stableId companyIds (e.g. two "Seed" rounds for the
  // same company at different dates) are NOT duplicates — they are distinct
  // funding events that happen to share a name.
  let dedupedFundingRoundsResult = fundingRoundsResult;
  if (fundingRoundsResult.status === 'fulfilled' && fundingRoundsResult.value) {
    const rows = fundingRoundsResult.value;
    // Index: "entityKey|name" → { stableIdRows, legacyRows[] }
    const groups = new Map();
    for (const row of rows) {
      const entityKey = normalizePGEntityId(row.companyRef?.entityId ?? row.companyId);
      const name = (row.name || '').toLowerCase().trim();
      const dedupKey = `${entityKey}|${name}`;
      const isLegacyNumericId = /^\d+$/.test(row.companyId);
      if (!groups.has(dedupKey)) {
        groups.set(dedupKey, { stableIdRows: [], legacyRows: [] });
      }
      const group = groups.get(dedupKey);
      if (isLegacyNumericId) {
        group.legacyRows.push(row);
      } else {
        group.stableIdRows.push(row);
      }
    }
    // Collect rows to drop: legacy rows that have a stableId counterpart
    const dropIds = new Set();
    for (const group of groups.values()) {
      if (group.stableIdRows.length > 0 && group.legacyRows.length > 0) {
        for (const legacyRow of group.legacyRows) {
          dropIds.add(legacyRow.id);
        }
      }
    }
    if (dropIds.size > 0) {
      const deduped = rows.filter(row => !dropIds.has(row.id));
      console.log(`  kb-pg funding-rounds: deduplicated ${dropIds.size} legacy duplicate(s)`);
      dedupedFundingRoundsResult = { status: 'fulfilled', value: deduped };
    }
  }
  fundingRoundsCount = mergeCollection(
    'funding-rounds',
    dedupedFundingRoundsResult,
    ['funding-rounds'],
    (row) => row.companyRef?.entityId ?? row.companyId,
    () => 'funding-rounds',
    fundingRoundRowToRecordEntry,
  );

  // --- Process investments ---
  investmentsCount = mergeCollection(
    'investments',
    investmentsResult,
    ['investments'],
    (row) => row.companyEntityId || row.companyId,
    () => 'investments',
    investmentRowToRecordEntry,
  );

  // --- Process equity positions ---
  equityPositionsCount = mergeCollection(
    'equity-positions',
    equityPositionsResult,
    ['equity-positions'],
    (row) => row.companyEntityId || row.companyId,
    () => 'equity-positions',
    equityPositionRowToRecordEntry,
  );

  // --- Process divisions ---
  divisionsCount = mergeCollection(
    'divisions',
    divisionsResult,
    ['divisions'],
    (row) => row.parentOrgId,
    () => 'divisions',
    divisionRowToRecordEntry,
  );

  // --- Process funding programs ---
  fundingProgramsCount = mergeCollection(
    'funding-programs',
    fundingProgramsResult,
    ['funding-programs'],
    (row) => row.orgId,
    () => 'funding-programs',
    fundingProgramRowToRecordEntry,
  );

  // --- Process division personnel ---
  // Division personnel are keyed by divisionId (stored in a synthetic entity key)
  divisionPersonnelCount = mergeCollection(
    'division-personnel',
    divisionPersonnelResult,
    ['division-personnel'],
    (row) => `__division__${row.divisionId}`,
    () => 'division-personnel',
    divisionPersonnelRowToRecordEntry,
  );

  // --- Process entity events ---
  entityEventsCount = mergeCollection(
    'entity-events',
    entityEventsResult,
    ['entity-events'],
    (row) => row.entityId,
    () => 'entity-events',
    entityEventRowToRecordEntry,
  );

  // --- Process entity assessments ---
  entityAssessmentsCount = mergeCollection(
    'entity-assessments',
    entityAssessmentsResult,
    ['entity-assessments'],
    (row) => row.entityId,
    () => 'entity-assessments',
    entityAssessmentRowToRecordEntry,
  );

  // --- Process publications ---
  publicationsCount = mergeCollection(
    'publications',
    publicationsResult,
    ['publications'],
    (row) => row.entityId,
    () => 'publications',
    publicationRowToRecordEntry,
  );

  return {
    personnel: personnelCount,
    grants: grantsCount,
    fundingRounds: fundingRoundsCount,
    investments: investmentsCount,
    equityPositions: equityPositionsCount,
    divisions: divisionsCount,
    fundingPrograms: fundingProgramsCount,
    divisionPersonnel: divisionPersonnelCount,
    entityEvents: entityEventsCount,
    entityAssessments: entityAssessmentsCount,
    publications: publicationsCount,
  };
}

/**
 * Fetch all resources from the wiki-server PG database.
 * Returns them in the same shape as YAML resources (snake_case keys, cited_by array).
 * Falls back to null if the server is unavailable (caller should use YAML).
 */
export async function fetchResourcesFromPG() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) return null;

  const headers = buildHeaders();
  const allResources = [];
  let offset = 0;
  const limit = 200;

  try {
    // Paginate through all resources
    while (true) {
      const resp = await fetch(
        `${serverUrl}/api/resources/all-details?limit=${limit}&offset=${offset}`,
        { headers, signal: AbortSignal.timeout(30_000) }
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      const rows = data.resources || [];
      if (rows.length === 0) break;

      for (const r of rows) {
        // Transform PG camelCase -> YAML snake_case shape for backward compat
        allResources.push({
          id: r.id,
          url: r.url,
          title: r.title ?? undefined,
          type: r.type ?? undefined,
          summary: r.summary ?? undefined,
          review: r.review ?? undefined,
          abstract: r.abstract ?? undefined,
          key_points: r.keyPoints ?? undefined,
          publication_id: r.publicationId ?? undefined,
          authors: r.authors ?? undefined,
          published_date: r.publishedDate ?? undefined,
          tags: r.tags ?? undefined,
          local_filename: r.localFilename ?? undefined,
          credibility_override: r.credibilityOverride ?? undefined,
          fetched_at: r.fetchedAt ?? undefined,
          content_hash: r.contentHash ?? undefined,
          stable_id: r.stableId ?? undefined,
          fetch_status: r.fetchStatus ?? undefined,
          archive_url: r.archiveUrl ?? undefined,
          author_entity_ids: r.authorEntityIds ?? undefined,
          stance: r.stance ?? undefined,
          // Enrichment fields
          context_note: r.contextNote ?? undefined,
          resource_purpose: r.resourcePurpose ?? undefined,
          resource_subtype: r.resourceSubtype ?? undefined,
          type_metadata: r.typeMetadata ?? undefined,
          publisher_entity_id: r.publisherEntityId ?? undefined,
          related_entity_ids: r.relatedEntityIds ?? undefined,
          enrichment_status: r.enrichmentStatus ?? undefined,
          importance_score: r.importanceScore ?? undefined,
          // Sub-table data (if fetched via all-details endpoint)
          paper: r.paper ? {
            arxiv_id: r.paper.arxivId ?? undefined,
            doi: r.paper.doi ?? undefined,
            semantic_scholar_id: r.paper.semanticScholarId ?? undefined,
            abstract: r.paper.abstract ?? undefined,
            citation_count: r.paper.citationCount ?? undefined,
            influential_citation_count: r.paper.influentialCitationCount ?? undefined,
            categories: r.paper.categories ?? undefined,
            methodology: r.paper.methodology ?? undefined,
            year: r.paper.year ?? undefined,
          } : undefined,
          forum_post: r.forumPost ? {
            forum: r.forumPost.forum,
            forum_post_id: r.forumPost.forumPostId ?? undefined,
            forum_slug: r.forumPost.forumSlug ?? undefined,
            karma: r.forumPost.karma ?? undefined,
            comment_count: r.forumPost.commentCount ?? undefined,
            author_username: r.forumPost.authorUsername ?? undefined,
            forum_tags: r.forumPost.forumTags ?? undefined,
            sequence_title: r.forumPost.sequenceTitle ?? undefined,
            curated: r.forumPost.curated ?? undefined,
            cross_posted_from: r.forumPost.crossPostedFrom ?? undefined,
            canonical_forum: r.forumPost.canonicalForum ?? undefined,
          } : undefined,
          policy_doc: r.policyDoc ? {
            document_type: r.policyDoc.documentType ?? undefined,
            jurisdiction_entity_id: r.policyDoc.jurisdictionEntityId ?? undefined,
            agency_entity_id: r.policyDoc.agencyEntityId ?? undefined,
            policy_entity_id: r.policyDoc.policyEntityId ?? undefined,
            effective_date: r.policyDoc.effectiveDate ?? undefined,
            document_status: r.policyDoc.documentStatus ?? undefined,
            reference_number: r.policyDoc.referenceNumber ?? undefined,
          } : undefined,
        });
      }

      offset += rows.length;
      if (rows.length < limit) break;
    }

    // Fetch bulk citation index (resourceId -> pageIds[])
    try {
      const citResp = await fetch(
        `${serverUrl}/api/resources/citations/all`,
        { headers, signal: AbortSignal.timeout(15_000) }
      );
      if (citResp.ok) {
        const citData = await citResp.json();
        const citations = citData.citations || {};
        for (const r of allResources) {
          const pages = citations[r.id];
          if (pages && pages.length > 0) {
            r.cited_by = pages;
          }
        }
      }
    } catch (citErr) {
      // Non-fatal — cited_by from YAML will be used for pageResources
      console.log(`  resources-pg: citation fetch failed (${citErr instanceof Error ? citErr.message : String(citErr)})`);
    }

    return allResources;
  } catch (err) {
    logWikiServerWarning('resources-pg', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Fetch all page references (claim refs + citations) from the wiki-server.
 * Returns a map of pageId -> { claimReferences, citations } for the reference preprocessor.
 * Falls back to an empty object if the server is unavailable.
 */
export async function buildPageReferenceIndex() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  pageReferenceIndex: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return {};
  }

  const headers = buildHeaders();

  // Retry with increasing timeouts — this endpoint can be slow on large datasets
  const retryTimeouts = [30_000, 60_000];
  for (let i = 0; i < retryTimeouts.length; i++) {
    try {
      const res = await fetch(`${serverUrl}/api/references/all`, {
        headers,
        signal: AbortSignal.timeout(retryTimeouts[i]),
      });

      if (!res.ok) {
        console.log(`  pageReferenceIndex: server returned ${res.status} (attempt ${i + 1}/${retryTimeouts.length})`);
        if (i < retryTimeouts.length - 1) continue;
        console.warn('  ⚠ pageReferenceIndex: all attempts failed — citation footnotes will show reference IDs only');
        wikiServerWarningCount++;
        return {};
      }

      const data = await res.json();
      const pages = data.pages || {};
      const pageCount = Object.keys(pages).length;
      console.log(`  pageReferenceIndex: ${pageCount} pages, ${data.totalClaimRefs} claim refs, ${data.totalCitations} citations`);

      if (pageCount === 0 && data.totalCitations === 0) {
        console.warn('  ⚠ pageReferenceIndex: server returned 0 pages — citation footnotes will show reference IDs only');
      }

      return pages;
    } catch (err) {
      console.log(`  pageReferenceIndex: ${err.message || 'server unavailable'} (attempt ${i + 1}/${retryTimeouts.length})`);
      if (i < retryTimeouts.length - 1) continue;
      console.warn('  ⚠ pageReferenceIndex: all attempts failed — citation footnotes will show reference IDs only');
      wikiServerWarningCount++;
      return {};
    }
  }
  // Unreachable — loop always returns, but TypeScript/eslint may require it
  return {};
}

/**
 * Fetch entity_resources from wiki-server and group by entityId.
 * Returns: { [stableId]: { authored: resourceId[], subject: resourceId[] } }
 */
export async function fetchEntityResourceLinks() {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  entityResourceLinks: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return null;
  }

  const headers = buildHeaders();

  try {
    const url = `${serverUrl}/api/entity-resources/export`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) {
      logWikiServerWarning('entityResourceLinks', `HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const items = data.items || [];

    // Group by entityId
    const grouped = {};
    for (const row of items) {
      if (!grouped[row.entityId]) {
        grouped[row.entityId] = { authored: [], subject: [] };
      }
      if (row.authoredByEntity) {
        grouped[row.entityId].authored.push(row.resourceId);
      }
      if (row.isSubject) {
        grouped[row.entityId].subject.push(row.resourceId);
      }
    }

    console.log(`  entityResourceLinks: ${items.length} links across ${Object.keys(grouped).length} entities`);
    return grouped;
  } catch (err) {
    logWikiServerWarning('entityResourceLinks', err.message || String(err));
    return null;
  }
}
