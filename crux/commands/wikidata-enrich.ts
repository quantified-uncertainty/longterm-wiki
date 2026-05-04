/**
 * Wikidata Enrichment Command
 *
 * Enriches FactBase entities with structured data from Wikidata via SPARQL.
 * Searches for entities by name, queries Wikidata for structured facts,
 * and writes new facts to entity YAML files (preserving existing facts).
 *
 * Usage:
 *   crux fb wikidata-enrich [options]
 *
 * Options:
 *   --dry-run         Preview facts without writing to disk
 *   --limit=N         Process at most N entities
 *   --entity=<slug>   Process a single entity by slug
 *   --type=<type>     Only process entities of a given type (e.g., organization)
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import {
  loadGraphFull,
  FACTBASE_DATA_DIR,
} from '../lib/factbase-loader.ts';
import {
  readEntityDocument,
  appendFact,
  writeEntityDocument,
  findEntityFilePath,
} from '../lib/factbase-writer.ts';
import type { Entity, Fact } from '../../packages/factbase/src/types.ts';
import { truncate } from '../lib/text-utils.ts';

// ── Types ──────────────────────────────────────────────────────────────

interface WikidataEnrichOptions extends BaseOptions {
  dryRun?: boolean;
  'dry-run'?: boolean;
  limit?: string;
  entity?: string;
  type?: string;
}

interface WikidataSearchResult {
  id: string; // Q-number, e.g. "Q116758847"
  label: string;
  description?: string;
}

interface WikidataFact {
  property: string; // FactBase property ID
  value: unknown;
  source: string;
  notes: string;
}

// ── Wikidata property mapping ──────────────────────────────────────────

/**
 * Maps Wikidata property IDs to FactBase property IDs.
 * Each entry defines how to extract and convert the SPARQL result.
 */
const WIKIDATA_PROPERTY_MAP: {
  wikidataProperty: string;
  sparqlVariable: string;
  factbaseProperty: string;
  extractValue: (binding: Record<string, SparqlValue>) => unknown | null;
  formatNotes: (binding: Record<string, SparqlValue>, qid: string) => string;
}[] = [
  {
    wikidataProperty: 'P571',
    sparqlVariable: 'foundedDate',
    factbaseProperty: 'founded-date',
    extractValue: (b) => {
      const raw = b.foundedDate?.value;
      if (!raw) return null;
      // Wikidata dates are like "2015-12-11T00:00:00Z"
      const match = raw.match(/^(\d{4})-(\d{2})/);
      return match ? `${match[1]}-${match[2]}` : null;
    },
    formatNotes: (_b, qid) => `From Wikidata ${qid}`,
  },
  {
    wikidataProperty: 'P159',
    sparqlVariable: 'headquartersLabel',
    factbaseProperty: 'headquarters',
    extractValue: (b) => b.headquartersLabel?.value || null,
    formatNotes: (_b, qid) => `From Wikidata ${qid}`,
  },
  {
    wikidataProperty: 'P17',
    sparqlVariable: 'countryLabel',
    factbaseProperty: 'country',
    extractValue: (b) => b.countryLabel?.value || null,
    formatNotes: (_b, qid) => `From Wikidata ${qid}`,
  },
  {
    wikidataProperty: 'P856',
    sparqlVariable: 'website',
    factbaseProperty: 'website',
    extractValue: (b) => b.website?.value || null,
    formatNotes: (_b, qid) => `From Wikidata ${qid}`,
  },
  {
    wikidataProperty: 'P169',
    sparqlVariable: 'ceoLabel',
    factbaseProperty: 'ceo',
    extractValue: (b) => b.ceoLabel?.value || null,
    formatNotes: (_b, qid) => `From Wikidata ${qid}`,
  },
  {
    wikidataProperty: 'P1128',
    sparqlVariable: 'employees',
    factbaseProperty: 'headcount',
    extractValue: (b) => {
      const raw = b.employees?.value;
      if (!raw) return null;
      const num = Number(raw);
      return isNaN(num) ? null : num;
    },
    formatNotes: (_b, qid) => `From Wikidata ${qid}`,
  },
  {
    wikidataProperty: 'P2139',
    sparqlVariable: 'revenue',
    factbaseProperty: 'revenue',
    extractValue: (b) => {
      const raw = b.revenue?.value;
      if (!raw) return null;
      const num = Number(raw);
      return isNaN(num) ? null : num;
    },
    formatNotes: (_b, qid) => `From Wikidata ${qid}`,
  },
  {
    wikidataProperty: 'P749',
    sparqlVariable: 'parentOrgLabel',
    factbaseProperty: 'parent-organization',
    extractValue: (b) => b.parentOrgLabel?.value || null,
    formatNotes: (_b, qid) => `From Wikidata ${qid}`,
  },
  {
    wikidataProperty: 'P112',
    sparqlVariable: 'founderLabel',
    factbaseProperty: 'founded-by-name',
    extractValue: (b) => b.founderLabel?.value || null,
    formatNotes: (_b, qid) =>
      `From Wikidata ${qid}; text value (not entity ref)`,
  },
  {
    wikidataProperty: 'P1454',
    sparqlVariable: 'legalFormLabel',
    factbaseProperty: 'legal-structure',
    extractValue: (b) => b.legalFormLabel?.value || null,
    formatNotes: (_b, qid) => `From Wikidata ${qid}`,
  },
];

// ── SPARQL types ───────────────────────────────────────────────────────

interface SparqlValue {
  type: string;
  value: string;
  'xml:lang'?: string;
  datatype?: string;
}

interface SparqlResults {
  results: {
    bindings: Record<string, SparqlValue>[];
  };
}

// ── Rate limiting ──────────────────────────────────────────────────────

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1100; // ~1 request per second

async function rateLimitedFetch(url: string, init?: RequestInit): Promise<Response> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest);
  }
  lastRequestTime = Date.now();
  return fetch(url, {
    ...init,
    headers: {
      'User-Agent': 'LongtermWiki/1.0 (https://www.longtermwiki.com; bot@longtermwiki.com)',
      Accept: 'application/json',
      ...(init?.headers || {}),
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Wikidata API functions ─────────────────────────────────────────────

/**
 * Search Wikidata for an entity by name.
 * Returns the top match or null.
 */
async function searchWikidata(name: string): Promise<WikidataSearchResult | null> {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: name,
    language: 'en',
    format: 'json',
    limit: '5',
    type: 'item',
  });

  const url = `https://www.wikidata.org/w/api.php?${params.toString()}`;

  try {
    const response = await rateLimitedFetch(url);
    if (!response.ok) {
      console.warn(`  Wikidata search failed for "${name}": HTTP ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      search?: Array<{ id: string; label: string; description?: string }>;
    };

    if (!data.search || data.search.length === 0) {
      return null;
    }

    // Return the first result — usually the best match
    const match = data.search[0];
    return {
      id: match.id,
      label: match.label,
      description: match.description,
    };
  } catch (err) {
    console.warn(
      `  Wikidata search error for "${name}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Query Wikidata SPARQL for structured facts about an entity.
 */
async function queryWikidataSparql(qid: string): Promise<Record<string, SparqlValue>[]> {
  // Build SPARQL query for all properties we want
  const sparql = `
SELECT ?foundedDate ?headquartersLabel ?countryLabel ?website
       ?ceoLabel ?employees ?revenue ?parentOrgLabel
       ?founderLabel ?legalFormLabel ?wikipediaUrl
WHERE {
  OPTIONAL { wd:${qid} wdt:P571 ?foundedDate. }
  OPTIONAL { wd:${qid} wdt:P159 ?headquarters. }
  OPTIONAL { wd:${qid} wdt:P17 ?country. }
  OPTIONAL { wd:${qid} wdt:P856 ?website. }
  OPTIONAL { wd:${qid} wdt:P169 ?ceo. }
  OPTIONAL { wd:${qid} wdt:P1128 ?employees. }
  OPTIONAL { wd:${qid} wdt:P2139 ?revenue. }
  OPTIONAL { wd:${qid} wdt:P749 ?parentOrg. }
  OPTIONAL { wd:${qid} wdt:P112 ?founder. }
  OPTIONAL { wd:${qid} wdt:P1454 ?legalForm. }
  OPTIONAL {
    ?wikipediaUrl schema:about wd:${qid};
                  schema:isPartOf <https://en.wikipedia.org/>.
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 10
`;

  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}`;

  try {
    const response = await rateLimitedFetch(url, {
      headers: {
        Accept: 'application/sparql-results+json',
        'User-Agent': 'LongtermWiki/1.0 (https://www.longtermwiki.com; bot@longtermwiki.com)',
      },
    });

    if (!response.ok) {
      console.warn(`  SPARQL query failed for ${qid}: HTTP ${response.status}`);
      return [];
    }

    const data = (await response.json()) as SparqlResults;
    return data.results.bindings;
  } catch (err) {
    console.warn(
      `  SPARQL query error for ${qid}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Extract structured facts from SPARQL results.
 */
function extractFacts(
  bindings: Record<string, SparqlValue>[],
  qid: string,
): WikidataFact[] {
  if (bindings.length === 0) return [];

  const facts: WikidataFact[] = [];
  const seenProperties = new Set<string>();

  // Merge all bindings (SPARQL may return multiple rows for multi-valued properties)
  for (const binding of bindings) {
    for (const propDef of WIKIDATA_PROPERTY_MAP) {
      if (seenProperties.has(propDef.factbaseProperty)) continue;

      const value = propDef.extractValue(binding);
      if (value === null || value === undefined) continue;

      seenProperties.add(propDef.factbaseProperty);
      facts.push({
        property: propDef.factbaseProperty,
        value,
        source: `https://www.wikidata.org/wiki/${qid}`,
        notes: propDef.formatNotes(binding, qid),
      });
    }

    // Wikipedia URL (not in the property map since it's special)
    if (!seenProperties.has('wikipedia-url') && binding.wikipediaUrl?.value) {
      seenProperties.add('wikipedia-url');
      facts.push({
        property: 'wikipedia-url',
        value: binding.wikipediaUrl.value,
        source: `https://www.wikidata.org/wiki/${qid}`,
        notes: `From Wikidata ${qid}`,
      });
    }
  }

  return facts;
}

/**
 * Check whether a fact already exists for an entity (by property and approximate value).
 */
function factAlreadyExists(
  existingFacts: Fact[],
  newProperty: string,
  newValue: unknown,
): boolean {
  for (const f of existingFacts) {
    if (f.propertyId !== newProperty) continue;

    // For text values, compare case-insensitively
    if (typeof newValue === 'string' && f.value.type === 'text') {
      if (f.value.value.toLowerCase() === newValue.toLowerCase()) return true;
    }

    // For number values, compare with tolerance
    if (typeof newValue === 'number' && f.value.type === 'number') {
      if (f.value.value === newValue) return true;
    }

    // For date values
    if (typeof newValue === 'string' && f.value.type === 'date') {
      // Check if the existing date starts with or matches the new date
      if (f.value.value.startsWith(newValue) || newValue.startsWith(f.value.value)) {
        return true;
      }
    }
  }
  return false;
}

// ── Main command ───────────────────────────────────────────────────────

async function wikidataEnrichCommand(
  args: string[],
  options: WikidataEnrichOptions,
): Promise<CommandResult> {
  const dryRun = options.dryRun || options['dry-run'] || false;
  const limit = options.limit ? parseInt(options.limit, 10) : undefined;
  const entityFilter = options.entity;
  const typeFilter = options.type;

  const lines: string[] = [];
  const log = (msg: string) => {
    lines.push(msg);
    console.log(msg);
  };

  log('Loading FactBase...');
  const kb = await loadGraphFull();
  const entities = kb.graph.getAllEntities();

  log(`Loaded ${entities.length} entities.`);

  // Filter entities
  let candidates: Entity[] = entities;

  if (entityFilter) {
    const entity = entities.find(
      (e) =>
        e.id === entityFilter ||
        e.name.toLowerCase() === entityFilter.toLowerCase() ||
        kb.filenameMap.get(e.id) === entityFilter,
    );
    if (!entity) {
      return { exitCode: 1, output: `Entity not found: ${entityFilter}` };
    }
    candidates = [entity];
  }

  if (typeFilter) {
    candidates = candidates.filter((e) => e.type === typeFilter);
  }

  if (limit && limit > 0) {
    candidates = candidates.slice(0, limit);
  }

  log(`Processing ${candidates.length} entities${dryRun ? ' (dry run)' : ''}...`);
  log('');

  // Stats
  let entitiesMatched = 0;
  let entitiesWithNewFacts = 0;
  let totalNewFacts = 0;
  let entitiesSkipped = 0;
  let entitiesNotFound = 0;

  for (const entity of candidates) {
    const slug = kb.filenameMap.get(entity.id) || entity.id;
    log(`[${slug}] Searching Wikidata for "${entity.name}"...`);

    // Search for this entity on Wikidata
    const match = await searchWikidata(entity.name);
    if (!match) {
      log(`  No Wikidata match found.`);
      entitiesNotFound++;
      continue;
    }

    entitiesMatched++;
    log(`  Matched: ${match.id} — ${match.label}${match.description ? ` (${match.description})` : ''}`);

    // Query SPARQL for structured data
    const bindings = await queryWikidataSparql(match.id);
    const wikidataFacts = extractFacts(bindings, match.id);

    if (wikidataFacts.length === 0) {
      log(`  No structured facts found on Wikidata.`);
      continue;
    }

    // Filter out facts that already exist
    const existingFacts = kb.graph.getFacts(entity.id);
    const newFacts = wikidataFacts.filter(
      (wf) => !factAlreadyExists(existingFacts, wf.property, wf.value),
    );

    if (newFacts.length === 0) {
      log(`  All ${wikidataFacts.length} facts already exist — skipping.`);
      entitiesSkipped++;
      continue;
    }

    log(`  Found ${wikidataFacts.length} facts, ${newFacts.length} are new:`);
    for (const nf of newFacts) {
      const displayValue =
        typeof nf.value === 'string'
          ? truncate(nf.value, 60, { ellipsis: '...' })
          : String(nf.value);
      log(`    + ${nf.property}: ${displayValue}`);
    }

    // Write if not dry run
    if (!dryRun) {
      const filePath = findEntityFilePath(slug, FACTBASE_DATA_DIR);
      if (!filePath) {
        log(`  WARNING: Could not find YAML file for ${slug} — skipping write.`);
        continue;
      }

      const doc = readEntityDocument(filePath);
      for (const nf of newFacts) {
        appendFact(doc, {
          property: nf.property,
          value: nf.value,
          source: nf.source,
          notes: nf.notes,
        });
      }
      writeEntityDocument(filePath, doc);
      log(`  Wrote ${newFacts.length} new facts to ${slug}.yaml`);
    }

    entitiesWithNewFacts++;
    totalNewFacts += newFacts.length;
  }

  // Summary
  log('');
  log('════════════════════════════════════════════════════');
  log('Wikidata Enrichment Summary');
  log('════════════════════════════════════════════════════');
  log(`  Entities processed:       ${candidates.length}`);
  log(`  Wikidata matches:         ${entitiesMatched}`);
  log(`  No match found:           ${entitiesNotFound}`);
  log(`  Entities with new facts:  ${entitiesWithNewFacts}`);
  log(`  Entities fully covered:   ${entitiesSkipped}`);
  log(`  Total new facts:          ${totalNewFacts}`);
  if (dryRun) {
    log('');
    log('  (Dry run — no files were modified)');
  }

  return { exitCode: 0, output: '' };
}

// ── Exports ────────────────────────────────────────────────────────────

export const commands = {
  default: wikidataEnrichCommand,
};

export function getHelp(): string {
  return `
Wikidata Enrichment — Enrich FactBase entities with Wikidata SPARQL data

Usage:
  crux fb wikidata-enrich [options]

Options:
  --dry-run         Preview discovered facts without writing to YAML files
  --limit=N         Process at most N entities (useful for testing)
  --entity=<slug>   Process a single entity by slug (e.g., --entity=anthropic)
  --type=<type>     Only process entities of a given type (e.g., --type=organization)

Wikidata Properties Queried:
  P571   Founded date        → founded-date
  P159   Headquarters        → headquarters
  P17    Country             → country
  P856   Official website    → website
  P169   CEO/director        → ceo
  P1128  Number of employees → headcount
  P2139  Revenue             → revenue
  P749   Parent organization → parent-organization
  P112   Founded by          → founded-by-name
  P1454  Legal form          → legal-structure
  -      Wikipedia URL       → wikipedia-url

Notes:
  - Rate-limited to ~1 request/second to respect Wikidata's API guidelines
  - Only adds NEW facts — never overwrites existing data
  - Uses Wikidata search API for name matching, then SPARQL for structured data
  - Fact IDs are auto-generated 10-char alphanumeric strings

Examples:
  crux fb wikidata-enrich --dry-run --limit=5         Preview 5 entities
  crux fb wikidata-enrich --entity=anthropic           Enrich a single entity
  crux fb wikidata-enrich --type=organization          Enrich all organizations
  crux fb wikidata-enrich --dry-run                    Preview all entities
`;
}
