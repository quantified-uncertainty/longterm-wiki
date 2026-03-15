/**
 * People Enrich Subcommand
 *
 * Enrich person KB entities with data from Wikidata.
 */

import type { CommandResult } from '../../lib/command-types.ts';
import { loadGraphFull, resolveEntity, KB_DATA_DIR } from '../../lib/factbase-loader.ts';
import {
  readEntityDocument,
  appendFact,
  writeEntityDocument,
  findEntityFilePath,
} from '../../lib/factbase-writer.ts';
import type { RawFactInput } from '../../lib/factbase-writer.ts';
import type { Entity, Fact } from '../../../packages/factbase/src/types.ts';
import type { Graph } from '../../../packages/factbase/src/graph.ts';
import type { PeopleCommandOptions } from './shared.ts';

// ---------------------------------------------------------------------------
// Types — Wikidata enrichment
// ---------------------------------------------------------------------------

interface WikidataSearchResult {
  id: string;
  label: string;
  description?: string;
}

interface WikidataClaim {
  mainsnak: {
    snaktype: string;
    datatype?: string;
    datavalue?: {
      type: string;
      value: unknown;
    };
  };
}

interface EnrichmentProposal {
  entityId: string;
  entityName: string;
  wikidataQid: string;
  wikidataDescription: string;
  proposals: FactProposal[];
}

interface FactProposal {
  property: string;
  propertyName: string;
  value: string | number;
  source: string;
  notes?: string;
  action: 'add' | 'skip-exists';
  existingValue?: string;
}

// ── Wikidata API helpers ────────────────────────────────────────────

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const RATE_LIMIT_MS = 1000; // 1s between requests to respect Wikidata limits
const MAX_RETRIES = 3;
// Wikidata requires a proper User-Agent; requests without one get blocked.
const USER_AGENT = 'longterm-wiki-bot/1.0 (https://longtermwiki.com; bot@longtermwiki.com)';
const FETCH_HEADERS = { 'User-Agent': USER_AGENT };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with retry on 429 (rate limit) responses.
 * Backs off exponentially: 2s, 4s, 8s.
 */
async function fetchWithRetry(url: string): Promise<Response> {
  const totalAttempts = MAX_RETRIES + 1; // initial + retries
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      const resp = await fetch(url, { headers: FETCH_HEADERS });
      if (resp.status === 429 && attempt < totalAttempts - 1) {
        const backoff = Math.pow(2, attempt + 1) * 1000;
        process.stderr.write(`Rate limited (429), retrying in ${backoff / 1000}s...\n`);
        await sleep(backoff);
        continue;
      }
      return resp;
    } catch (e: unknown) {
      if (attempt < totalAttempts - 1) {
        const backoff = Math.pow(2, attempt + 1) * 1000;
        process.stderr.write(`Fetch error, retrying in ${backoff / 1000}s...\n`);
        await sleep(backoff);
        continue;
      }
      throw e;
    }
  }
  // Should not reach here, but TypeScript needs a return
  return fetch(url, { headers: FETCH_HEADERS });
}

/**
 * Search Wikidata for a person by name.
 * Returns candidates sorted by relevance.
 */
async function searchWikidata(name: string): Promise<WikidataSearchResult[]> {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: name,
    language: 'en',
    format: 'json',
    type: 'item',
    limit: '5',
  });

  let resp: Response;
  try {
    resp = await fetchWithRetry(`${WIKIDATA_API}?${params}`);
  } catch (e: unknown) {
    console.warn(`Wikidata search failed for "${name}": ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  if (!resp.ok) {
    console.warn(`Wikidata search failed for "${name}": HTTP ${resp.status}`);
    return [];
  }

  const data = (await resp.json()) as {
    search?: Array<{ id: string; label: string; description?: string }>;
  };
  return (data.search ?? []).map((r) => ({
    id: r.id,
    label: r.label,
    description: r.description,
  }));
}

/**
 * Get claims (structured properties) for a Wikidata entity by QID.
 */
async function getWikidataClaims(
  qid: string,
): Promise<Record<string, WikidataClaim[]>> {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: qid,
    format: 'json',
    props: 'claims|labels',
  });

  const resp = await fetchWithRetry(`${WIKIDATA_API}?${params}`);
  if (!resp.ok) {
    console.warn(`Wikidata entity fetch failed for ${qid}: HTTP ${resp.status}`);
    return {};
  }

  const data = (await resp.json()) as {
    entities?: Record<
      string,
      { claims?: Record<string, WikidataClaim[]> }
    >;
  };
  return data.entities?.[qid]?.claims ?? {};
}

/**
 * Get the label (name) of a Wikidata entity by QID.
 * Used to resolve employer/education institution QIDs to human-readable names.
 */
async function getWikidataLabel(qid: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: qid,
    format: 'json',
    props: 'labels',
    languages: 'en',
  });

  const resp = await fetchWithRetry(`${WIKIDATA_API}?${params}`);
  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    entities?: Record<
      string,
      { labels?: Record<string, { value: string }> }
    >;
  };
  return data.entities?.[qid]?.labels?.en?.value ?? null;
}

// ── Relevance filtering ─────────────────────────────────────────────

/**
 * Negative keywords that disqualify a match outright.
 * Prevents matching politicians, athletes, etc.
 */
const DISQUALIFY_KEYWORDS = [
  'politician',
  'footballer',
  'soccer',
  'rugby',
  'basketball',
  'baseball',
  'cricketer',
  'actor',
  'actress',
  'singer',
  'musician',
  'painter',
  'sculptor',
];

/**
 * Positive keywords that indicate AI/tech/academic relevance.
 * Only these count — no nationality-only matches.
 */
const RELEVANT_KEYWORDS = [
  'computer scientist',
  'artificial intelligence',
  'machine learning',
  'deep learning',
  'researcher',
  'professor',
  'entrepreneur',
  'ceo',
  'investor',
  'philanthropist',
  'philosopher',
  'physicist',
  'mathematician',
  'cognitive',
  'neuroscien',
  'engineer',
  'developer',
  'technology',
  'writer',
  'author',
  'blogger',
  'forecaster',
  'statistician',
  'economist',
  'effective altruism',
  'ai safety',
  'openai',
  'anthropic',
  'deepmind',
  'google',
  'meta',
  'microsoft',
  'venture capital',
  'venture-capital',
  'capitalist',
  'billionaire',
  'software',
  'psychologist',
  'psycholinguist',
  'linguist',
  'academic',
  'science',
  'nonprofit',
  'silicon valley',
  'executive',
  'business',
  'ethicist',
];

/**
 * Check if a Wikidata description suggests this is a relevant person
 * (AI/tech/policy/academic). Returns true if description contains
 * relevant keywords and no disqualifying ones.
 */
function isRelevantMatch(description: string | undefined): boolean {
  if (!description) return false;

  const desc = description.toLowerCase();

  // Reject if any disqualifying keyword appears
  if (DISQUALIFY_KEYWORDS.some((kw) => desc.includes(kw))) return false;

  // Accept if any positive keyword appears
  return RELEVANT_KEYWORDS.some((kw) => desc.includes(kw));
}

// ── Wikidata property extraction ────────────────────────────────────

/**
 * Extract birth year from Wikidata P569 (date of birth).
 */
function extractBirthYear(
  claims: Record<string, WikidataClaim[]>,
): number | null {
  const birthClaims = claims['P569'];
  if (!birthClaims || birthClaims.length === 0) return null;

  const claim = birthClaims[0];
  if (claim.mainsnak.snaktype !== 'value') return null;

  const dv = claim.mainsnak.datavalue;
  if (!dv || dv.type !== 'time') return null;

  const timeValue = dv.value as { time: string };
  // Time format: +1983-01-01T00:00:00Z
  const match = timeValue.time.match(/[+-](\d{4})/);
  if (!match) return null;

  return parseInt(match[1], 10);
}

/**
 * Extract education institutions from Wikidata P69 (educated at).
 * Returns a formatted education string.
 */
async function extractEducation(
  claims: Record<string, WikidataClaim[]>,
): Promise<string | null> {
  const eduClaims = claims['P69'];
  if (!eduClaims || eduClaims.length === 0) return null;

  const institutions: string[] = [];

  for (const claim of eduClaims) {
    if (claim.mainsnak.snaktype !== 'value') continue;
    const dv = claim.mainsnak.datavalue;
    if (!dv || dv.type !== 'wikibase-entityid') continue;

    const entityId = (dv.value as { id: string }).id;
    const label = await getWikidataLabel(entityId);
    if (label) {
      institutions.push(label);
    }
    await sleep(RATE_LIMIT_MS);
  }

  if (institutions.length === 0) return null;
  return institutions.join('; ');
}

/**
 * Extract employer from Wikidata P108 (employer).
 * Returns the most recent employer name.
 */
async function extractEmployer(
  claims: Record<string, WikidataClaim[]>,
): Promise<string | null> {
  const employerClaims = claims['P108'];
  if (!employerClaims || employerClaims.length === 0) return null;

  // Take the first (most recent) employer
  const claim = employerClaims[0];
  if (claim.mainsnak.snaktype !== 'value') return null;
  const dv = claim.mainsnak.datavalue;
  if (!dv || dv.type !== 'wikibase-entityid') return null;

  const entityId = (dv.value as { id: string }).id;
  const label = await getWikidataLabel(entityId);
  return label;
}

/**
 * Extract occupation from Wikidata P106 (occupation).
 * Returns a comma-separated list of occupations.
 */
async function extractOccupation(
  claims: Record<string, WikidataClaim[]>,
): Promise<string | null> {
  const occupationClaims = claims['P106'];
  if (!occupationClaims || occupationClaims.length === 0) return null;

  const occupations: string[] = [];

  // Limit to first 3 occupations
  for (const claim of occupationClaims.slice(0, 3)) {
    if (claim.mainsnak.snaktype !== 'value') continue;
    const dv = claim.mainsnak.datavalue;
    if (!dv || dv.type !== 'wikibase-entityid') continue;

    const entityId = (dv.value as { id: string }).id;
    const label = await getWikidataLabel(entityId);
    if (label) {
      occupations.push(label);
    }
    await sleep(RATE_LIMIT_MS);
  }

  if (occupations.length === 0) return null;
  return occupations.join(', ');
}

// ── Core enrichment logic ───────────────────────────────────────────

/**
 * Strip parenthetical annotations from entity names.
 * e.g. "Marc Andreessen (AI Investor)" -> "Marc Andreessen"
 */
function cleanName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Check if two names are equivalent: all words in name A appear in name B
 * (case-insensitive, handles middle initials like "Stuart J. Russell").
 */
function namesMatch(nameA: string, nameB: string): boolean {
  const wordsA = cleanName(nameA).toLowerCase().replace(/[.]/g, '').split(/\s+/).filter(Boolean);
  const wordsB = cleanName(nameB).toLowerCase().replace(/[.]/g, '').split(/\s+/).filter(Boolean);
  // All words from A must appear in B (allows B to have extra words like middle names)
  return wordsA.every((w) => wordsB.includes(w));
}

/**
 * Try to find a relevant match from a list of Wikidata search results.
 */
function findBestMatch(
  results: WikidataSearchResult[],
  entity: Entity,
): WikidataSearchResult | null {
  // Priority 1: exact name match + relevant description
  for (const r of results) {
    if (!isRelevantMatch(r.description)) continue;
    if (r.label.toLowerCase() === entity.name.toLowerCase()) {
      return r;
    }
  }

  // Priority 2: fuzzy name match (all words present) + relevant description
  for (const r of results) {
    if (!isRelevantMatch(r.description)) continue;
    if (namesMatch(entity.name, r.label) || namesMatch(r.label, entity.name)) {
      return r;
    }
  }

  // Priority 3: entity aliases match Wikidata label + relevant description
  for (const r of results) {
    if (!isRelevantMatch(r.description)) continue;
    for (const alias of entity.aliases ?? []) {
      if (namesMatch(alias, r.label) || namesMatch(r.label, alias)) {
        return r;
      }
    }
  }

  return null;
}

/**
 * Find the best Wikidata match for a person entity.
 * Requires the description to contain relevant keywords and no disqualifying ones.
 * Tries primary name first; only searches aliases if no match found (reduces API calls).
 */
async function findWikidataMatch(
  entity: Entity,
): Promise<WikidataSearchResult | null> {
  // First try: search by cleaned primary name (strip parenthetical annotations)
  const searchName = cleanName(entity.name);
  const primaryResults = await searchWikidata(searchName);
  await sleep(RATE_LIMIT_MS);

  const primaryMatch = findBestMatch(primaryResults, entity);
  if (primaryMatch) return primaryMatch;

  // Second try: search by aliases (only if primary name failed)
  const aliases = entity.aliases ?? [];
  for (const alias of aliases) {
    const cleanAlias = cleanName(alias);
    // Skip very short aliases (single names) and aliases identical to search name
    if (cleanAlias.length < 4 || cleanAlias.toLowerCase() === searchName.toLowerCase()) continue;

    const aliasResults = await searchWikidata(cleanAlias);
    await sleep(RATE_LIMIT_MS);

    const aliasMatch = findBestMatch(aliasResults, entity);
    if (aliasMatch) return aliasMatch;
  }

  return null;
}

/**
 * Build enrichment proposals for a single entity from Wikidata data.
 */
async function buildProposals(
  entity: Entity,
  graph: Graph,
  qid: string,
  description: string,
): Promise<EnrichmentProposal> {
  const claims = await getWikidataClaims(qid);
  await sleep(RATE_LIMIT_MS);

  const existingFacts = graph.getFacts(entity.id);
  const existingProps = new Map<string, Fact[]>();
  for (const f of existingFacts) {
    const existing = existingProps.get(f.propertyId);
    if (existing) {
      existing.push(f);
    } else {
      existingProps.set(f.propertyId, [f]);
    }
  }

  const proposals: FactProposal[] = [];
  const wikidataUrl = `https://www.wikidata.org/wiki/${qid}`;

  // 1. Birth year (P569 -> born-year)
  const birthYear = extractBirthYear(claims);
  if (birthYear) {
    const existing = existingProps.get('born-year');
    if (existing && existing.length > 0) {
      proposals.push({
        property: 'born-year',
        propertyName: 'Birth Year',
        value: birthYear,
        source: wikidataUrl,
        action: 'skip-exists',
        existingValue: 'value' in existing[0].value ? String(existing[0].value.value) : JSON.stringify(existing[0].value),
      });
    } else {
      proposals.push({
        property: 'born-year',
        propertyName: 'Birth Year',
        value: birthYear,
        source: wikidataUrl,
        notes: `From Wikidata ${qid}`,
        action: 'add',
      });
    }
  }

  // 2. Education (P69 -> education)
  const education = await extractEducation(claims);
  if (education) {
    const existing = existingProps.get('education');
    if (existing && existing.length > 0) {
      proposals.push({
        property: 'education',
        propertyName: 'Education',
        value: education,
        source: wikidataUrl,
        action: 'skip-exists',
        existingValue: 'value' in existing[0].value ? String(existing[0].value.value) : JSON.stringify(existing[0].value),
      });
    } else {
      proposals.push({
        property: 'education',
        propertyName: 'Education',
        value: education,
        source: wikidataUrl,
        notes: `From Wikidata ${qid}`,
        action: 'add',
      });
    }
  }

  return {
    entityId: entity.id,
    entityName: entity.name,
    wikidataQid: qid,
    wikidataDescription: description,
    proposals,
  };
}

// ── Command handler ─────────────────────────────────────────────────

export async function enrichCommand(
  args: string[],
  options: PeopleCommandOptions,
): Promise<CommandResult> {
  const source = options.source;
  const dryRun = options['dry-run'] || options.dryRun;
  const apply = options.apply;
  const entityFilter = options.entity;
  const ci = options.ci;
  const limit = options.limit ? parseInt(String(options.limit), 10) : undefined;

  if (source !== 'wikidata') {
    return {
      exitCode: 1,
      output: `Unknown source: "${source ?? '(none)'}". Currently supported: wikidata\n\nUsage:\n  crux people enrich --source=wikidata --dry-run\n  crux people enrich --source=wikidata --apply\n  crux people enrich --source=wikidata --entity=dario-amodei`,
    };
  }

  if (!dryRun && !apply) {
    return {
      exitCode: 1,
      output: `Must specify either --dry-run or --apply.\n\nUsage:\n  crux people enrich --source=wikidata --dry-run\n  crux people enrich --source=wikidata --apply`,
    };
  }

  const kb = await loadGraphFull();
  const { graph, filenameMap } = kb;

  // Get person entities
  let persons = graph.getAllEntities().filter((e) => e.type === 'person');

  if (entityFilter) {
    const entity = resolveEntity(entityFilter, kb);
    if (!entity) {
      return {
        exitCode: 1,
        output: `Entity not found: "${entityFilter}"`,
      };
    }
    if (entity.type !== 'person') {
      return {
        exitCode: 1,
        output: `Entity "${entity.name}" is type "${entity.type}", not "person"`,
      };
    }
    persons = [entity];
  }

  if (limit && limit > 0) {
    persons = persons.slice(0, limit);
  }

  const lines: string[] = [];
  const allProposals: EnrichmentProposal[] = [];
  let matched = 0;
  let notMatched = 0;
  let totalAdded = 0;
  let totalSkipped = 0;

  if (!ci) {
    lines.push(
      `\x1b[1mWikidata Enrichment${dryRun ? ' (DRY RUN)' : ''}\x1b[0m`,
    );
    lines.push(`Processing ${persons.length} person entities...`);
    lines.push('');
  }

  for (const person of persons) {
    if (!ci) {
      process.stderr.write(`  Searching: ${person.name}...\r`);
    }

    const match = await findWikidataMatch(person);
    await sleep(RATE_LIMIT_MS);

    if (!match) {
      notMatched++;
      if (!ci) {
        lines.push(`  \x1b[90m- ${person.name}: no Wikidata match\x1b[0m`);
      }
      continue;
    }

    matched++;
    const proposal = await buildProposals(
      person,
      graph,
      match.id,
      match.description ?? '',
    );
    allProposals.push(proposal);

    const adds = proposal.proposals.filter((p) => p.action === 'add');
    const skips = proposal.proposals.filter((p) => p.action === 'skip-exists');
    totalAdded += adds.length;
    totalSkipped += skips.length;

    if (!ci) {
      if (adds.length === 0 && skips.length === 0) {
        lines.push(
          `  \x1b[90m${person.name} (${match.id}): no new facts available\x1b[0m`,
        );
      } else {
        lines.push(
          `  \x1b[1m${person.name}\x1b[0m (${match.id}: ${match.description ?? 'no description'})`,
        );

        for (const p of adds) {
          lines.push(
            `    \x1b[32m+ ${p.propertyName}: ${p.value}\x1b[0m`,
          );
        }
        for (const p of skips) {
          lines.push(
            `    \x1b[90m= ${p.propertyName}: already exists (${p.existingValue})\x1b[0m`,
          );
        }
      }
    }

    // Apply if requested
    if (apply && adds.length > 0) {
      const slug = filenameMap.get(person.id);
      if (!slug) {
        lines.push(
          `    \x1b[31m! Cannot find filename for ${person.id}\x1b[0m`,
        );
        continue;
      }

      const filePath = findEntityFilePath(slug, KB_DATA_DIR);
      if (!filePath) {
        lines.push(
          `    \x1b[31m! Cannot find YAML file for ${slug}\x1b[0m`,
        );
        continue;
      }

      const doc = readEntityDocument(filePath);

      for (const p of adds) {
        const factInput: RawFactInput = {
          property: p.property,
          value: p.value,
          source: p.source,
          ...(p.notes && { notes: p.notes }),
        };
        const factId = appendFact(doc, factInput);
        if (!ci) {
          lines.push(`    \x1b[32m  -> wrote ${factId}\x1b[0m`);
        }
      }

      writeEntityDocument(filePath, doc);
    }
  }

  // Clear the progress line
  if (!ci) {
    process.stderr.write('                                          \r');
  }

  // Summary
  if (ci) {
    const data = {
      source: 'wikidata',
      mode: apply ? 'apply' : 'dry-run',
      totalPersons: persons.length,
      matched,
      notMatched,
      factsAdded: totalAdded,
      factsSkipped: totalSkipped,
      proposals: allProposals,
    };
    return { exitCode: 0, output: JSON.stringify(data, null, 2) };
  }

  lines.push('');
  lines.push(`\x1b[1mSummary:\x1b[0m`);
  lines.push(`  Persons processed: ${persons.length}`);
  lines.push(`  Wikidata matches:  ${matched}`);
  lines.push(`  No match:          ${notMatched}`);
  lines.push(
    `  Facts to add:      \x1b[32m${totalAdded}\x1b[0m`,
  );
  lines.push(
    `  Facts skipped:     \x1b[90m${totalSkipped} (already exist)\x1b[0m`,
  );

  if (dryRun && totalAdded > 0) {
    lines.push('');
    lines.push(
      `\x1b[33mRe-run with --apply to write these facts.\x1b[0m`,
    );
  }

  return { exitCode: 0, output: lines.join('\n') };
}
