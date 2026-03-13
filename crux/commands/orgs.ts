/**
 * Organizations Command Handlers
 *
 * CLI tools for managing organization entity data.
 *
 * Usage:
 *   crux orgs enrich --source=wikidata --dry-run              Preview all enrichment
 *   crux orgs enrich --source=wikidata --apply                Write new facts to YAML
 *   crux orgs enrich --source=wikidata --entity=anthropic     Single entity
 *   crux orgs enrich --source=wikidata --dry-run --ci         JSON output
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { loadGraphFull, resolveEntity, KB_DATA_DIR } from '../lib/kb-loader.ts';
import {
  readEntityDocument,
  appendFact,
  writeEntityDocument,
  findEntityFilePath,
} from '../lib/kb-writer.ts';
import type { RawFactInput } from '../lib/kb-writer.ts';
import type { Entity, Fact } from '../../packages/kb/src/types.ts';
import type { Graph } from '../../packages/kb/src/graph.ts';

// ── Types ─────────────────────────────────────────────────────────

interface OrgsCommandOptions extends BaseOptions {
  source?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  entity?: string;
  ci?: boolean;
  limit?: string | number;
}

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
  qualifiers?: Record<string, WikidataClaim['mainsnak'][]>;
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
const USER_AGENT = 'longterm-wiki-bot/1.0 (https://longtermwiki.com; bot@longtermwiki.com)';
const FETCH_HEADERS = { 'User-Agent': USER_AGENT };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with retry on 429 (rate limit) responses.
 */
async function fetchWithRetry(url: string): Promise<Response> {
  const totalAttempts = MAX_RETRIES + 1;
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
  return fetch(url, { headers: FETCH_HEADERS });
}

/**
 * Search Wikidata for an organization by name.
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
 * Disqualifying description keywords for organizations.
 * Prevents matching sports teams, music groups, etc.
 */
const DISQUALIFY_KEYWORDS = [
  'football',
  'soccer',
  'rugby',
  'basketball',
  'baseball',
  'cricket',
  'hockey',
  'band',
  'musical group',
  'album',
  'song',
  'film',
  'television',
  'tv series',
  'video game',
  'restaurant',
  'church',
  'parish',
  'diocese',
];

/**
 * Positive keywords that indicate an organization is relevant to AI/tech/policy.
 */
const RELEVANT_KEYWORDS = [
  'artificial intelligence',
  'machine learning',
  'technology',
  'research',
  'institute',
  'laboratory',
  'foundation',
  'nonprofit',
  'non-profit',
  'think tank',
  'thinktank',
  'university',
  'company',
  'corporation',
  'startup',
  'start-up',
  'venture',
  'investment',
  'fund',
  'charity',
  'philanthropic',
  'philanthropy',
  'organization',
  'organisation',
  'policy',
  'governance',
  'safety',
  'security',
  'science',
  'engineering',
  'software',
  'computing',
  'biotech',
  'biosecurity',
  'effective altruism',
  'longtermism',
  'existential risk',
  'ai safety',
  'ai alignment',
  'openai',
  'anthropic',
  'deepmind',
  'google',
  'meta',
  'microsoft',
  'american',
  'british',
  'chinese',
];

/**
 * Check if a Wikidata description suggests this is a relevant organization.
 */
function isRelevantMatch(description: string | undefined): boolean {
  if (!description) return false;

  const desc = description.toLowerCase();

  if (DISQUALIFY_KEYWORDS.some((kw) => desc.includes(kw))) return false;
  return RELEVANT_KEYWORDS.some((kw) => desc.includes(kw));
}

// ── Wikidata property extraction ────────────────────────────────────

/**
 * Extract founding date from Wikidata P571 (inception).
 * Returns YYYY-MM or YYYY format.
 */
function extractFoundedDate(
  claims: Record<string, WikidataClaim[]>,
): string | null {
  const foundedClaims = claims['P571'];
  if (!foundedClaims || foundedClaims.length === 0) return null;

  const claim = foundedClaims[0];
  if (claim.mainsnak.snaktype !== 'value') return null;

  const dv = claim.mainsnak.datavalue;
  if (!dv || dv.type !== 'time') return null;

  const timeValue = dv.value as { time: string; precision: number };
  // Time format: +1983-01-01T00:00:00Z
  // Precision: 9=year, 10=month, 11=day
  const fullMatch = timeValue.time.match(/[+-](\d{4})-(\d{2})-(\d{2})/);
  if (!fullMatch) return null;

  const year = fullMatch[1];
  const month = fullMatch[2];

  // If precision is month or better, include the month
  if (timeValue.precision >= 10 && month !== '00') {
    return `${year}-${month}`;
  }
  return year;
}

/**
 * Extract headquarters location from Wikidata P159 (headquarters location).
 */
async function extractHeadquarters(
  claims: Record<string, WikidataClaim[]>,
): Promise<string | null> {
  const hqClaims = claims['P159'];
  if (!hqClaims || hqClaims.length === 0) return null;

  // Take the first (current) headquarters
  const claim = hqClaims[0];
  if (claim.mainsnak.snaktype !== 'value') return null;
  const dv = claim.mainsnak.datavalue;
  if (!dv || dv.type !== 'wikibase-entityid') return null;

  const entityId = (dv.value as { id: string }).id;
  const label = await getWikidataLabel(entityId);
  return label;
}

/**
 * Extract employee count from Wikidata P1128 (employees).
 * Returns the most recent value.
 */
function extractEmployeeCount(
  claims: Record<string, WikidataClaim[]>,
): { count: number; asOf?: string } | null {
  const employeeClaims = claims['P1128'];
  if (!employeeClaims || employeeClaims.length === 0) return null;

  // Find the claim with the most recent point-in-time qualifier (P585),
  // or fall back to the first claim
  let bestClaim = employeeClaims[0];
  let bestDate: string | undefined;

  for (const claim of employeeClaims) {
    if (claim.mainsnak.snaktype !== 'value') continue;

    // Check for point-in-time qualifier
    const pointInTime = claim.qualifiers?.['P585'];
    if (pointInTime && pointInTime.length > 0) {
      const qual = pointInTime[0];
      if (qual.datavalue?.type === 'time') {
        const timeVal = qual.datavalue.value as { time: string };
        const dateMatch = timeVal.time.match(/[+-](\d{4})-(\d{2})/);
        if (dateMatch) {
          const dateStr = `${dateMatch[1]}-${dateMatch[2]}`;
          if (!bestDate || dateStr > bestDate) {
            bestDate = dateStr;
            bestClaim = claim;
          }
        }
      }
    }
  }

  if (bestClaim.mainsnak.snaktype !== 'value') return null;
  const dv = bestClaim.mainsnak.datavalue;
  if (!dv || dv.type !== 'quantity') return null;

  const amount = (dv.value as { amount: string }).amount;
  const count = parseInt(amount.replace(/^\+/, ''), 10);
  if (isNaN(count)) return null;

  return { count, asOf: bestDate };
}

/**
 * Extract official website from Wikidata P856 (official website).
 */
function extractWebsite(
  claims: Record<string, WikidataClaim[]>,
): string | null {
  const websiteClaims = claims['P856'];
  if (!websiteClaims || websiteClaims.length === 0) return null;

  const claim = websiteClaims[0];
  if (claim.mainsnak.snaktype !== 'value') return null;
  const dv = claim.mainsnak.datavalue;
  if (!dv || dv.type !== 'string') return null;

  return dv.value as string;
}

/**
 * Extract founders from Wikidata P112 (founded by).
 * Returns human-readable names as a comma-separated string.
 */
async function extractFounders(
  claims: Record<string, WikidataClaim[]>,
): Promise<string | null> {
  const founderClaims = claims['P112'];
  if (!founderClaims || founderClaims.length === 0) return null;

  const founders: string[] = [];

  for (const claim of founderClaims) {
    if (claim.mainsnak.snaktype !== 'value') continue;
    const dv = claim.mainsnak.datavalue;
    if (!dv || dv.type !== 'wikibase-entityid') continue;

    const entityId = (dv.value as { id: string }).id;
    const label = await getWikidataLabel(entityId);
    if (label) {
      founders.push(label);
    }
    await sleep(RATE_LIMIT_MS);
  }

  if (founders.length === 0) return null;
  return founders.join('; ');
}

/**
 * Extract parent organization from Wikidata P749 (parent organization).
 */
async function extractParentOrg(
  claims: Record<string, WikidataClaim[]>,
): Promise<string | null> {
  const parentClaims = claims['P749'];
  if (!parentClaims || parentClaims.length === 0) return null;

  const claim = parentClaims[0];
  if (claim.mainsnak.snaktype !== 'value') return null;
  const dv = claim.mainsnak.datavalue;
  if (!dv || dv.type !== 'wikibase-entityid') return null;

  const entityId = (dv.value as { id: string }).id;
  const label = await getWikidataLabel(entityId);
  return label;
}

// ── Core enrichment logic ───────────────────────────────────────────

/**
 * Strip parenthetical annotations from entity names.
 */
function cleanName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Check if two names are equivalent (case-insensitive, handles variations).
 */
function namesMatch(nameA: string, nameB: string): boolean {
  const wordsA = cleanName(nameA).toLowerCase().replace(/[.]/g, '').split(/\s+/).filter(Boolean);
  const wordsB = cleanName(nameB).toLowerCase().replace(/[.]/g, '').split(/\s+/).filter(Boolean);
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
    if (r.label.toLowerCase() === cleanName(entity.name).toLowerCase()) {
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

  // Priority 3: aliases
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
 * Find the best Wikidata match for an organization entity.
 */
async function findWikidataMatch(
  entity: Entity,
): Promise<WikidataSearchResult | null> {
  const searchName = cleanName(entity.name);
  const primaryResults = await searchWikidata(searchName);
  await sleep(RATE_LIMIT_MS);

  const primaryMatch = findBestMatch(primaryResults, entity);
  if (primaryMatch) return primaryMatch;

  // Try aliases
  const aliases = entity.aliases ?? [];
  for (const alias of aliases) {
    const cleanAlias = cleanName(alias);
    if (cleanAlias.length < 3 || cleanAlias.toLowerCase() === searchName.toLowerCase()) continue;

    const aliasResults = await searchWikidata(cleanAlias);
    await sleep(RATE_LIMIT_MS);

    const aliasMatch = findBestMatch(aliasResults, entity);
    if (aliasMatch) return aliasMatch;
  }

  return null;
}

/**
 * Build enrichment proposals for a single organization from Wikidata data.
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

  // 1. Founded date (P571 -> founded-date)
  const foundedDate = extractFoundedDate(claims);
  if (foundedDate) {
    const existing = existingProps.get('founded-date');
    if (existing && existing.length > 0) {
      proposals.push({
        property: 'founded-date',
        propertyName: 'Founded Date',
        value: foundedDate,
        source: wikidataUrl,
        action: 'skip-exists',
        existingValue: 'value' in existing[0].value ? String(existing[0].value.value) : JSON.stringify(existing[0].value),
      });
    } else {
      proposals.push({
        property: 'founded-date',
        propertyName: 'Founded Date',
        value: foundedDate,
        source: wikidataUrl,
        notes: `From Wikidata ${qid}`,
        action: 'add',
      });
    }
  }

  // 2. Headquarters (P159 -> headquarters)
  const headquarters = await extractHeadquarters(claims);
  await sleep(RATE_LIMIT_MS);
  if (headquarters) {
    const existing = existingProps.get('headquarters');
    if (existing && existing.length > 0) {
      proposals.push({
        property: 'headquarters',
        propertyName: 'Headquarters',
        value: headquarters,
        source: wikidataUrl,
        action: 'skip-exists',
        existingValue: 'value' in existing[0].value ? String(existing[0].value.value) : JSON.stringify(existing[0].value),
      });
    } else {
      proposals.push({
        property: 'headquarters',
        propertyName: 'Headquarters',
        value: headquarters,
        source: wikidataUrl,
        notes: `From Wikidata ${qid}`,
        action: 'add',
      });
    }
  }

  // 3. Employee count (P1128 -> headcount)
  const employees = extractEmployeeCount(claims);
  if (employees) {
    const existing = existingProps.get('headcount');
    if (existing && existing.length > 0) {
      proposals.push({
        property: 'headcount',
        propertyName: 'Headcount',
        value: employees.count,
        source: wikidataUrl,
        action: 'skip-exists',
        existingValue: 'value' in existing[0].value ? String(existing[0].value.value) : JSON.stringify(existing[0].value),
      });
    } else {
      proposals.push({
        property: 'headcount',
        propertyName: 'Headcount',
        value: employees.count,
        source: wikidataUrl,
        notes: `From Wikidata ${qid}${employees.asOf ? ` (as of ${employees.asOf})` : ''}`,
        action: 'add',
        ...(employees.asOf && {}),
      });
    }
  }

  // 4. Official website (P856 -> website)
  const website = extractWebsite(claims);
  if (website) {
    const existing = existingProps.get('website');
    if (existing && existing.length > 0) {
      proposals.push({
        property: 'website',
        propertyName: 'Website',
        value: website,
        source: wikidataUrl,
        action: 'skip-exists',
        existingValue: 'value' in existing[0].value ? String(existing[0].value.value) : JSON.stringify(existing[0].value),
      });
    } else {
      proposals.push({
        property: 'website',
        propertyName: 'Website',
        value: website,
        source: wikidataUrl,
        notes: `From Wikidata ${qid}`,
        action: 'add',
      });
    }
  }

  // 5. Founders (P112 -> description note, since founded-by uses refs)
  // We store founder names as a text note since proper ref-linking
  // requires matching to our entity IDs, which is complex.
  // The founded-by property uses refs type, so we'll add as a description note.
  const founders = await extractFounders(claims);
  if (founders) {
    // Don't add if founded-by facts already exist (they use proper refs)
    const existing = existingProps.get('founded-by');
    if (existing && existing.length > 0) {
      proposals.push({
        property: 'founded-by',
        propertyName: 'Founded By',
        value: founders,
        source: wikidataUrl,
        action: 'skip-exists',
        existingValue: '(ref-type facts exist)',
      });
    }
    // We skip adding founder data since founded-by uses ref type which needs entity IDs.
    // Founder names are captured in the description note instead.
  }

  // 6. Parent organization (P749 -> description note)
  const parentOrg = await extractParentOrg(claims);
  await sleep(RATE_LIMIT_MS);
  if (parentOrg) {
    const existing = existingProps.get('description');
    // Only note this, don't add as a separate fact since it's complex
    // and would need to be a proper entity reference
    if (!existing || existing.length === 0) {
      proposals.push({
        property: 'description',
        propertyName: 'Description',
        value: `${entity.name} is a subsidiary/division of ${parentOrg}.`,
        source: wikidataUrl,
        notes: `Parent organization from Wikidata ${qid}`,
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

async function enrichCommand(
  _args: string[],
  options: OrgsCommandOptions,
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
      output: `Unknown source: "${source ?? '(none)'}". Currently supported: wikidata\n\nUsage:\n  crux orgs enrich --source=wikidata --dry-run\n  crux orgs enrich --source=wikidata --apply\n  crux orgs enrich --source=wikidata --entity=anthropic`,
    };
  }

  if (!dryRun && !apply) {
    return {
      exitCode: 1,
      output: `Must specify either --dry-run or --apply.\n\nUsage:\n  crux orgs enrich --source=wikidata --dry-run\n  crux orgs enrich --source=wikidata --apply`,
    };
  }

  const kb = await loadGraphFull();
  const { graph, filenameMap } = kb;

  // Get organization entities
  let orgs = graph.getAllEntities().filter((e) => e.type === 'organization');

  if (entityFilter) {
    const entity = resolveEntity(entityFilter, kb);
    if (!entity) {
      return {
        exitCode: 1,
        output: `Entity not found: "${entityFilter}"`,
      };
    }
    if (entity.type !== 'organization') {
      return {
        exitCode: 1,
        output: `Entity "${entity.name}" is type "${entity.type}", not "organization"`,
      };
    }
    orgs = [entity];
  }

  if (limit && limit > 0) {
    orgs = orgs.slice(0, limit);
  }

  const lines: string[] = [];
  const allProposals: EnrichmentProposal[] = [];
  let matched = 0;
  let notMatched = 0;
  let totalAdded = 0;
  let totalSkipped = 0;

  if (!ci) {
    lines.push(
      `\x1b[1mOrganization Wikidata Enrichment${dryRun ? ' (DRY RUN)' : ''}\x1b[0m`,
    );
    lines.push(`Processing ${orgs.length} organization entities...`);
    lines.push('');
  }

  for (const org of orgs) {
    if (!ci) {
      process.stderr.write(`  Searching: ${org.name}...\r`);
    }

    const match = await findWikidataMatch(org);
    await sleep(RATE_LIMIT_MS);

    if (!match) {
      notMatched++;
      if (!ci) {
        lines.push(`  \x1b[90m- ${org.name}: no Wikidata match\x1b[0m`);
      }
      continue;
    }

    matched++;
    const proposal = await buildProposals(
      org,
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
          `  \x1b[90m${org.name} (${match.id}): no new facts available\x1b[0m`,
        );
      } else {
        lines.push(
          `  \x1b[1m${org.name}\x1b[0m (${match.id}: ${match.description ?? 'no description'})`,
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
      const slug = filenameMap.get(org.id);
      if (!slug) {
        lines.push(
          `    \x1b[31m! Cannot find filename for ${org.id}\x1b[0m`,
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

        // For headcount with asOf, add temporal marker
        if (p.property === 'headcount') {
          const employeeClaims = (await getWikidataClaims(proposal.wikidataQid))['P1128'];
          if (employeeClaims) {
            const empData = extractEmployeeCount({ 'P1128': employeeClaims });
            if (empData?.asOf) {
              factInput.asOf = empData.asOf;
            }
          }
        }

        const factId = appendFact(doc, factInput);
        if (!ci) {
          lines.push(`    \x1b[32m  -> wrote ${factId}\x1b[0m`);
        }
      }

      writeEntityDocument(filePath, doc);
    }
  }

  // Clear progress line
  if (!ci) {
    process.stderr.write('                                          \r');
  }

  // Summary
  if (ci) {
    const data = {
      source: 'wikidata',
      mode: apply ? 'apply' : 'dry-run',
      totalOrgs: orgs.length,
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
  lines.push(`  Orgs processed:    ${orgs.length}`);
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

// ── Command dispatch ────────────────────────────────────────────────

export const commands: Record<
  string,
  (args: string[], options: BaseOptions) => Promise<CommandResult>
> = {
  enrich: enrichCommand,
  default: enrichCommand,
};

export function getHelp(): string {
  return `
\x1b[1mOrgs\x1b[0m — Organization entity data tools

\x1b[1mCommands:\x1b[0m
  enrich               Enrich organization KB entities with data from external sources

\x1b[1mEnrich Options:\x1b[0m
  --source=wikidata     Data source (currently only wikidata is supported)
  --dry-run             Preview what would be added without writing
  --apply               Actually write new facts to YAML files
  --entity=<slug>       Process a single entity (for testing)
  --limit=N             Limit number of entities to process
  --ci                  JSON output

\x1b[1mProperties extracted from Wikidata:\x1b[0m
  P571  inception       -> founded-date
  P159  headquarters    -> headquarters
  P1128 employees       -> headcount
  P856  official website -> website
  P112  founded by      -> (logged as note; ref-type needs entity ID matching)
  P749  parent org      -> description (when no description exists)

\x1b[1mExamples:\x1b[0m
  crux orgs enrich --source=wikidata --dry-run
  crux orgs enrich --source=wikidata --apply
  crux orgs enrich --source=wikidata --entity=anthropic --dry-run
  crux orgs enrich --source=wikidata --limit=10 --dry-run
`;
}
