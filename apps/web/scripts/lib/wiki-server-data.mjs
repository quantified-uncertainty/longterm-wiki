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
        console.log(`  assessments: skipped (HTTP ${resp.status})`);
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
    console.log(`  assessments: skipped (${err instanceof Error ? err.message : err})`);
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
        console.log(`  benchmark-results: skipped (HTTP ${resp.status})`);
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
    console.log(`  benchmark-results: skipped (${err instanceof Error ? err.message : err})`);
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
        console.log(`  research-areas: skipped (HTTP ${resp.status})`);
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
    console.log(`  research-areas: skipped (${err instanceof Error ? err.message : err})`);
    return [];
  }
}

/**
 * Fetch record verification verdicts from wiki-server.
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
      const url = `${serverUrl}/api/record-verifications/verdicts?limit=${pageSize}&offset=${offset}`;
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) {
        console.log(`  record-verdicts: skipped (HTTP ${resp.status})`);
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
    console.log(`  record-verdicts: skipped (${err instanceof Error ? err.message : err})`);
    return {};
  }
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

  if (row.roleType === 'key-person') {
    fields.person = row.personId;
    fields.title = row.role;
    if (row.startDate) fields.start = row.startDate;
    if (row.endDate) fields.end = row.endDate;
    if (row.isFounder) fields.is_founder = true;
  } else if (row.roleType === 'board') {
    fields.member = row.personId;
    fields.role = row.role;
    if (row.startDate) fields.appointed = row.startDate;
    if (row.endDate) fields.departed = row.endDate;
    if (row.appointedBy) fields.appointed_by = row.appointedBy;
    if (row.background) fields.background = row.background;
  } else if (row.roleType === 'career') {
    fields.organization = row.organizationId;
    fields.title = row.role;
    if (row.startDate) fields.start = row.startDate;
    if (row.endDate) fields.end = row.endDate;
  }

  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;

  const entry = {
    key: row.id,
    schema,
    ownerEntityId: row.roleType === 'career' ? row.personId : row.organizationId,
    fields,
  };
  // Embed resolved display name from API JOIN (personnel API returns personResolvedName)
  if (row.personResolvedName) entry.displayName = row.personResolvedName;
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
    ownerEntityId: row.organizationId,
    fields,
  };
  // Embed resolved grantee display name from API JOIN
  if (row.granteeResolvedName) entry.displayName = row.granteeResolvedName;
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
  if (row.raised != null) fields.raised = row.raised;
  if (row.valuation != null) fields.valuation = row.valuation;
  if (row.instrument) fields.instrument = row.instrument;
  if (row.leadInvestor) fields.lead_investor = row.leadInvestor;
  if (row.source) fields.source = row.source;
  if (row.notes) fields.notes = row.notes;
  // Embed the server-side-resolved company name so the frontend can display it
  // even when companyEntityId is null (legacy numeric companyId rows).
  if (row.companyResolvedName) fields.company_name = row.companyResolvedName;

  const entry = {
    key: row.id,
    schema: 'funding-round',
    // Prefer companyEntityId (proper stableId FK) over legacy companyId for entity resolution.
    // Falls back to companyId for backward compatibility.
    ownerEntityId: row.companyEntityId ?? row.companyId,
    fields,
  };
  // Embed resolved lead investor display name from API JOIN
  if (row.leadInvestorResolvedName) entry.displayName = row.leadInvestorResolvedName;
  return entry;
}

/**
 * Convert a PG investment row to the RecordEntry format used by frontend components.
 */
function investmentRowToRecordEntry(row) {
  const fields = {};
  fields.investor = row.investorId;
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
    ownerEntityId: row.companyId,
    fields,
  };
  // Embed resolved investor display name from API JOIN
  if (row.investorResolvedName) entry.displayName = row.investorResolvedName;
  return entry;
}

/**
 * Convert a PG equity position row to the RecordEntry format used by frontend components.
 */
function equityPositionRowToRecordEntry(row) {
  const fields = {};
  fields.holder = row.holderId;
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
    ownerEntityId: row.companyId,
    fields,
  };
  if (row.asOf) entry.asOf = row.asOf;
  if (row.validEnd) entry.validEnd = row.validEnd;
  // Embed resolved holder display name from API JOIN
  if (row.holderResolvedName) entry.displayName = row.holderResolvedName;
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
 * Fetch personnel, grants, funding rounds, investments, and equity positions
 * from the wiki-server PG tables and merge them into the serialized KB records
 * structure (same format as YAML-sourced records).
 *
 * PG stores canonical entity IDs (10-char) in personId/organizationId fields,
 * which match the keys used in kb.records. No slug->entityId remapping needed.
 *
 * For collections that exist in both YAML and PG, PG records replace YAML.
 * Falls back gracefully if the wiki-server is unavailable (YAML records remain).
 */
export async function mergePGRecordsIntoKB(kb) {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    console.log('  kb-pg: skipped (LONGTERMWIKI_SERVER_URL not set)');
    return { personnel: 0, grants: 0, fundingRounds: 0, investments: 0, equityPositions: 0, divisions: 0, fundingPrograms: 0, divisionPersonnel: 0 };
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
  ] = await Promise.allSettled([
    fetchAllPages('/api/personnel/all', 'personnel'),
    fetchAllPages('/api/grants/all', 'grants'),
    fetchAllPages('/api/funding-rounds/all', 'fundingRounds'),
    fetchAllPages('/api/investments/all', 'investments'),
    fetchAllPages('/api/equity-positions/all', 'equityPositions'),
    fetchAllPages('/api/divisions/all', 'divisions'),
    fetchAllPages('/api/funding-programs/all', 'fundingPrograms'),
    fetchAllPages('/api/division-personnel/all', 'divisionPersonnel'),
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
      console.log(`  kb-pg ${label}: skipped (${reason || 'server unavailable'})`);
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
      const entityKey = getEntityKey(row);
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
      if (row.roleType === 'career') return row.personId;
      return row.organizationId;
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
    (row) => row.organizationId,
    () => 'grants',
    grantRowToRecordEntry,
  );

  // --- Process funding rounds ---
  fundingRoundsCount = mergeCollection(
    'funding-rounds',
    fundingRoundsResult,
    ['funding-rounds'],
    (row) => row.companyId,
    () => 'funding-rounds',
    fundingRoundRowToRecordEntry,
  );

  // --- Process investments ---
  investmentsCount = mergeCollection(
    'investments',
    investmentsResult,
    ['investments'],
    (row) => row.companyId,
    () => 'investments',
    investmentRowToRecordEntry,
  );

  // --- Process equity positions ---
  equityPositionsCount = mergeCollection(
    'equity-positions',
    equityPositionsResult,
    ['equity-positions'],
    (row) => row.companyId,
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

  return {
    personnel: personnelCount,
    grants: grantsCount,
    fundingRounds: fundingRoundsCount,
    investments: investmentsCount,
    equityPositions: equityPositionsCount,
    divisions: divisionsCount,
    fundingPrograms: fundingProgramsCount,
    divisionPersonnel: divisionPersonnelCount,
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
        `${serverUrl}/api/resources/all?limit=${limit}&offset=${offset}`,
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
    console.log(`  resources-pg: fetch failed (${err instanceof Error ? err.message : String(err)})`);
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
        console.warn('  ⚠ pageReferenceIndex: all attempts failed — citations will show "data unavailable"');
        return {};
      }

      const data = await res.json();
      const pages = data.pages || {};
      const pageCount = Object.keys(pages).length;
      console.log(`  pageReferenceIndex: ${pageCount} pages, ${data.totalClaimRefs} claim refs, ${data.totalCitations} citations`);

      if (pageCount === 0 && data.totalCitations === 0) {
        console.warn('  ⚠ pageReferenceIndex: server returned 0 pages — citations will show "data unavailable"');
      }

      return pages;
    } catch (err) {
      console.log(`  pageReferenceIndex: ${err.message || 'server unavailable'} (attempt ${i + 1}/${retryTimeouts.length})`);
      if (i < retryTimeouts.length - 1) continue;
      console.warn('  ⚠ pageReferenceIndex: all attempts failed — citations will show "data unavailable"');
      return {};
    }
  }
  // Unreachable — loop always returns, but TypeScript/eslint may require it
  return {};
}
