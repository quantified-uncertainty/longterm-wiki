/**
 * Wikidata Deterministic Matcher — verify FactBase facts sourced from Wikidata
 * by querying the Wikidata API directly instead of reading HTML with an LLM.
 *
 * ~414 FactBase facts have Wikidata source URLs. This matcher extracts the QID
 * from the URL, fetches structured data via the wbgetentities API, and compares
 * values deterministically using the existing fuzzy-match utilities.
 *
 * Cost: $0 (API calls only, no LLM). Replaces ~$4.25/week of LLM verification.
 *
 * QUA-92: Wikidata deterministic matcher for sourcing pipeline.
 */

import { z } from 'zod';
import type { VerifyItem, VerifyResult, FactItemData } from './orchestrator-types.ts';
import type { SourcingVerdict } from '../../../apps/wiki-server/src/api-types.ts';
import { nameMatches, dateMatches } from './fuzzy-match.ts';
import { urlMatches } from './fuzzy-match.ts';
import { hostMatches } from '@longterm-wiki/url-utils';

// ── Types ───────────────────────────────────────────────────────────

/** A single Wikidata claim (statement) value */
interface WikidataClaim {
  mainsnak: {
    snaktype: string;
    property: string;
    datavalue?: {
      type: string;
      value: unknown;
    };
  };
  rank: 'preferred' | 'normal' | 'deprecated';
}

/** Wikidata entity structure (subset of wbgetentities response) */
interface WikidataEntity {
  id: string;
  labels?: Record<string, { language: string; value: string }>;
  claims?: Record<string, WikidataClaim[]>;
  sitelinks?: Record<string, { site: string; title: string }>;
}

/**
 * Zod schema for the wbgetentities response. Validates each entity's
 * top-level shape (`id`, `labels`, `claims`, `sitelinks`) and each claim's
 * `mainsnak` + `rank`, so the downstream `as WikidataEntity` cast is
 * structurally honest. Per-claim narrowing on `datavalue.type` is still
 * done by `getStringValue` / `getTimeValue` / `getEntityRefQid` /
 * `getQuantityValue` below.
 */
const WikidataClaimSchema = z.object({
  mainsnak: z.object({
    snaktype: z.string(),
    property: z.string(),
    datavalue: z.object({
      type: z.string(),
      value: z.unknown(),
    }).optional(),
  }).passthrough(),
  rank: z.enum(['preferred', 'normal', 'deprecated']),
}).passthrough();

const WikidataLabelSchema = z.object({
  language: z.string(),
  value: z.string(),
}).passthrough();

const WikidataSitelinkSchema = z.object({
  site: z.string(),
  title: z.string(),
}).passthrough();

const WikidataEntitySchema = z.object({
  id: z.string().optional(),
  missing: z.unknown().optional(),
  labels: z.record(z.string(), WikidataLabelSchema).optional(),
  claims: z.record(z.string(), z.array(WikidataClaimSchema)).optional(),
  sitelinks: z.record(z.string(), WikidataSitelinkSchema).optional(),
}).passthrough();

const WbGetEntitiesResponseSchema = z.object({
  entities: z.record(z.string(), z.unknown()),
}).passthrough();

/** Match strategy for a property */
type MatchStrategy =
  | { type: 'url'; pid: string }
  | { type: 'sitelink' }
  | { type: 'date'; pid: string }
  | { type: 'year'; pid: string }
  | { type: 'entityRef'; pid: string; multiValued?: boolean }
  | { type: 'quantity'; pid: string; tolerance?: number }
  | { type: 'skip' };

// ── Property-to-PID map ─────────────────────────────────────────────

/**
 * Maps FactBase property IDs to Wikidata PIDs and match strategies.
 *
 * Each entry defines:
 * - pid: Wikidata property ID (e.g. "P856" for official website)
 * - type: How to extract and compare the value
 *   - url: Compare URLs (strip www, normalize http/https)
 *   - sitelink: Construct Wikipedia URL from entity sitelinks
 *   - date: Compare ISO date strings with granularity tolerance
 *   - year: Extract year from Wikidata date, compare as year
 *   - entityRef: Resolve entity reference (Q-number) to label, then nameMatches
 *   - skip: No Wikidata property exists; fall through to LLM
 */
const PROPERTY_MAP: Record<string, MatchStrategy> = {
  'website': { type: 'url', pid: 'P856' },
  'wikipedia-url': { type: 'sitelink' },
  'founded-date': { type: 'date', pid: 'P571' },
  'country': { type: 'entityRef', pid: 'P17' },
  'headquarters': { type: 'entityRef', pid: 'P159' },
  'founded-by-name': { type: 'entityRef', pid: 'P112', multiValued: true },
  'education': { type: 'entityRef', pid: 'P69', multiValued: true },
  'legal-structure': { type: 'entityRef', pid: 'P1454' },
  'born-year': { type: 'year', pid: 'P569' },
  'ceo': { type: 'entityRef', pid: 'P169' },
  'parent-organization': { type: 'entityRef', pid: 'P749' },
  'headcount': { type: 'quantity', pid: 'P1128', tolerance: 0.15 },
  'revenue': { type: 'quantity', pid: 'P2139', tolerance: 0.10 },
  'description': { type: 'skip' },
};

// ── Entity cache (memo for API calls) ───────────────────────────────

/** In-memory cache for fetched Wikidata entities */
const entityCache = new Map<string, WikidataEntity | null>();

/**
 * Clear the entity cache. Useful between test runs.
 */
export function clearEntityCache(): void {
  entityCache.clear();
}

// ── QID extraction ──────────────────────────────────────────────────

/** Regex to extract QID from Wikidata URLs. Handles trailing commas in ~136 URLs. */
const QID_REGEX = /Q(\d+)/;

/**
 * Match `wikidata.org/wiki/Q<n>` or `wikidata.org/entity/Q<n>` anywhere in a
 * string, ignoring trailing punctuation. Used by `extractQidFromHtml` to find
 * Wikidata references inside HTML body, schema.org `sameAs`, `<link rel>`
 * blocks, etc.
 */
const WIKIDATA_REF_RE = /wikidata\.org\/(?:wiki|entity)\/(Q\d+)/i;

/**
 * Extract QID from a source URL.
 *
 * Handles:
 *   - https://www.wikidata.org/wiki/Q123
 *   - https://www.wikidata.org/wiki/Q123,
 *   - https://www.wikidata.org/entity/Q123
 *
 * Returns null for URLs that don't reference wikidata.org or that point at
 * non-item pages (e.g. `Property:P856`).
 */
export function extractQid(url: string): string | null {
  if (!hostMatches(url, 'wikidata.org')) return null;
  const match = url.match(QID_REGEX);
  return match ? `Q${match[1]}` : null;
}

/** Cap how much HTML the QID extractor scans. Wikidata references on a page
 *  are almost always in the head/early body (canonical link, sameAs, og:url);
 *  we cap to 64KB to bound the regex cost when callers pass full pages. */
const HTML_SCAN_LIMIT = 64 * 1024;

/**
 * Find the first Wikidata QID referenced inside an HTML/text payload.
 *
 * Looks for `wikidata.org/wiki/Q<n>` or `wikidata.org/entity/Q<n>` patterns,
 * which cover the common emission paths:
 *   - `<link rel="alternate" href="https://www.wikidata.org/wiki/Q...">`
 *   - schema.org `sameAs` arrays
 *   - article-body links to Wikidata pages
 *   - Open Graph / Twitter cards that reference the canonical Wikidata URL
 *
 * Only the first `HTML_SCAN_LIMIT` chars are scanned — a limit that comfortably
 * covers `<head>` plus the first screen of body, where canonical / sameAs links
 * always live, while bounding regex cost on multi-megabyte payloads.
 *
 * Returns null if no Wikidata reference is found. Callers should treat null
 * as "unknown subject" (fail-open) rather than "different subject".
 *
 * Subject-identity gate (QUA-724) uses this to compare a candidate URL's
 * primary subject against the entity's QID before persisting suggestions.
 */
export function extractQidFromHtml(html: string): string | null {
  const slice = html.length > HTML_SCAN_LIMIT ? html.slice(0, HTML_SCAN_LIMIT) : html;
  const m = slice.match(WIKIDATA_REF_RE);
  return m ? m[1] : null;
}

// ── Wikidata API calls ──────────────────────────────────────────────

/**
 * Fetch one or more Wikidata entities via wbgetentities API.
 * Results are cached in memory. Batches up to 50 QIDs per call.
 */
export async function fetchEntities(qids: string[]): Promise<Map<string, WikidataEntity>> {
  const result = new Map<string, WikidataEntity>();
  const uncached: string[] = [];

  for (const qid of qids) {
    const cached = entityCache.get(qid);
    if (cached !== undefined) {
      if (cached) result.set(qid, cached);
      continue;
    }
    uncached.push(qid);
  }

  if (uncached.length === 0) return result;

  // Batch in groups of 50
  for (let i = 0; i < uncached.length; i += 50) {
    const batch = uncached.slice(i, i + 50);
    const ids = batch.join('|');
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&format=json&props=labels|claims|sitelinks&languages=en`;

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'LongtermWiki-Sourcing/1.0 (https://longtermwiki.com)' },
      });

      if (!response.ok) {
        console.warn(`[wikidata-matcher] API returned ${response.status} for batch ${i / 50 + 1}`);
        for (const qid of batch) entityCache.set(qid, null);
        continue;
      }

      const rawJson: unknown = await response.json().catch(() => null);
      const parsed = WbGetEntitiesResponseSchema.safeParse(rawJson);
      if (!parsed.success) {
        console.warn(`[wikidata-matcher] Invalid wbgetentities response for batch ${i / 50 + 1}: ${parsed.error.message.slice(0, 200)}`);
        for (const qid of batch) entityCache.set(qid, null);
        continue;
      }
      const data = parsed.data;
      for (const qid of batch) {
        const rawEntity = data.entities[qid];
        const entityParse = WikidataEntitySchema.safeParse(rawEntity);
        // Drop entities that fail shape validation OR are flagged `missing`
        // by Wikidata. Strategy matchers below tolerate undefined fields.
        if (entityParse.success && entityParse.data.missing === undefined) {
          const entity = entityParse.data as WikidataEntity;
          entityCache.set(qid, entity);
          result.set(qid, entity);
        } else {
          entityCache.set(qid, null);
        }
      }
    } catch (e: unknown) {
      console.warn(`[wikidata-matcher] Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      for (const qid of batch) entityCache.set(qid, null);
    }
  }

  return result;
}

// ── Claim extraction ────────────────────────────────────────────────

/**
 * Get claims for a property, filtered by rank.
 * Preferred claims take precedence; deprecated claims are excluded.
 */
function getClaimsForProperty(entity: WikidataEntity, pid: string): WikidataClaim[] {
  const allClaims = entity.claims?.[pid];
  if (!allClaims || allClaims.length === 0) return [];

  // Filter out deprecated claims
  const active = allClaims.filter(c => c.rank !== 'deprecated');
  if (active.length === 0) return [];

  // If there are preferred claims, use only those
  const preferred = active.filter(c => c.rank === 'preferred');
  return preferred.length > 0 ? preferred : active;
}

/**
 * Extract a string value from a claim's datavalue.
 */
function getStringValue(claim: WikidataClaim): string | null {
  const dv = claim.mainsnak.datavalue;
  if (!dv) return null;
  if (dv.type === 'string') return dv.value as string;
  return null;
}

/**
 * Extract a time value from a claim's datavalue.
 * Wikidata times look like "+2015-12-11T00:00:00Z"
 */
function getTimeValue(claim: WikidataClaim): string | null {
  const dv = claim.mainsnak.datavalue;
  if (!dv || dv.type !== 'time') return null;
  const time = dv.value as { time: string; precision: number };
  return time.time;
}

/**
 * Extract a year from a Wikidata time value.
 */
function getYearFromTime(claim: WikidataClaim): string | null {
  const timeStr = getTimeValue(claim);
  if (!timeStr) return null;
  // Format: "+2015-12-11T00:00:00Z" or "-0044-03-15T00:00:00Z"
  const match = timeStr.match(/([+-]?\d+)-/);
  return match ? String(parseInt(match[1], 10)) : null;
}

/**
 * Extract a numeric quantity from a claim's datavalue.
 * Wikidata quantities look like { amount: "+1234", unit: "http://www.wikidata.org/entity/Q4917" }
 * for typed quantities (e.g. USD), or { amount: "+1234", unit: "1" } for dimensionless counts.
 * Returns the amount alongside the unit QID (or null for dimensionless) so callers can
 * enforce unit compatibility before comparing.
 */
function getQuantityValue(
  claim: WikidataClaim,
): { amount: number; unit: string | null } | null {
  const dv = claim.mainsnak.datavalue;
  if (!dv || dv.type !== 'quantity') return null;
  const val = dv.value as { amount: string; unit?: string };
  const amount = Number(val.amount);
  if (!Number.isFinite(amount)) return null;
  if (!val.unit || val.unit === '1') return { amount, unit: null };
  const unitMatch = val.unit.match(/\/(Q\d+)$/);
  return { amount, unit: unitMatch ? unitMatch[1] : val.unit };
}

/**
 * Map currency symbols in a FactBase value to Wikidata currency QIDs.
 * Only unambiguous symbols are included — "$" is treated as USD (the most common
 * and the default used across the FactBase), "¥" is deliberately omitted because
 * it's ambiguous between JPY and CNY.
 */
const CURRENCY_SYMBOL_TO_QID: Record<string, string> = {
  $: 'Q4917', // United States dollar
  '€': 'Q4916', // Euro
  '£': 'Q25224', // Pound sterling
};

function detectCurrencyQid(factValue: string): string | null {
  for (const [symbol, qid] of Object.entries(CURRENCY_SYMBOL_TO_QID)) {
    if (factValue.includes(symbol)) return qid;
  }
  return null;
}

/**
 * Extract an entity reference QID from a claim.
 * Entity references have datavalue.type === 'wikibase-entityid'
 */
function getEntityRefQid(claim: WikidataClaim): string | null {
  const dv = claim.mainsnak.datavalue;
  if (!dv || dv.type !== 'wikibase-entityid') return null;
  const val = dv.value as { id?: string; 'entity-type'?: string; 'numeric-id'?: number };
  return val.id ?? null;
}

/**
 * Resolve entity reference QIDs to English labels.
 * Uses the same cached fetch mechanism as the main entity fetch.
 */
async function resolveLabels(qids: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const entities = await fetchEntities(qids);
  for (const [qid, entity] of entities) {
    const label = entity.labels?.en?.value;
    if (label) labels.set(qid, label);
  }
  return labels;
}

// ── Wikipedia sitelink URL construction ─────────────────────────────

/**
 * Construct a Wikipedia URL from a Wikidata entity's sitelink.
 * Title spaces are replaced with underscores per Wikipedia convention.
 */
function getWikipediaUrl(entity: WikidataEntity): string | null {
  const sitelink = entity.sitelinks?.enwiki;
  if (!sitelink) return null;
  const title = sitelink.title.replace(/ /g, '_');
  return `https://en.wikipedia.org/wiki/${title}`;
}

// ── Main matcher ────────────────────────────────────────────────────

/**
 * Try to verify a FactBase fact sourced from Wikidata using the structured API.
 *
 * Returns:
 * - VerifyResult with verdict if the match succeeds or definitively fails
 * - null if the property has no PID mapping, the API fails, or we can't match
 *   (caller should fall through to LLM verification)
 */
export async function tryWikidataMatch(item: VerifyItem): Promise<VerifyResult | null> {
  if (item.data.kind !== 'fact') return null;

  const factData = item.data as FactItemData;
  const sourceUrl = factData.fact.source;
  if (!sourceUrl) return null;

  // Extract QID from source URL
  const qid = extractQid(sourceUrl);
  if (!qid) return null;

  // Look up match strategy for this property
  const strategy = PROPERTY_MAP[factData.propertyName];
  if (!strategy || strategy.type === 'skip') return null;

  // Fetch the Wikidata entity
  const entities = await fetchEntities([qid]);
  const entity = entities.get(qid);
  if (!entity) return null;

  const factValue = String(factData.formattedValue);

  // Dispatch to strategy-specific matcher
  try {
    switch (strategy.type) {
      case 'url':
        return matchUrl(item, entity, strategy.pid, factValue, qid);
      case 'sitelink':
        return matchSitelink(item, entity, factValue, qid);
      case 'date':
        return matchDate(item, entity, strategy.pid, factValue, qid);
      case 'year':
        return matchYear(item, entity, strategy.pid, factValue, qid);
      case 'entityRef':
        return await matchEntityRef(item, entity, strategy.pid, factValue, qid, !!strategy.multiValued);
      case 'quantity':
        return matchQuantity(item, entity, strategy.pid, factValue, qid, strategy.tolerance ?? 0.10);
    }
  } catch (e: unknown) {
    console.warn(`[wikidata-matcher] Match failed for ${item.id}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ── Strategy matchers ───────────────────────────────────────────────

function makeResult(
  item: VerifyItem,
  verdict: SourcingVerdict,
  confidence: number,
  extractedValue: string,
  reasoning: string,
): VerifyResult {
  return {
    itemId: item.id,
    kind: item.kind,
    description: item.description,
    verdict,
    confidence,
    extractedValue,
    reasoning,
    sourceUrl: item.sourceUrl ?? '',
    checkerModel: 'wikidata-api',
  };
}

function matchUrl(
  item: VerifyItem,
  entity: WikidataEntity,
  pid: string,
  factValue: string,
  qid: string,
): VerifyResult | null {
  const claims = getClaimsForProperty(entity, pid);
  if (claims.length === 0) {
    return makeResult(item, 'unverifiable', 0.80,
      `Wikidata ${pid} not present on ${qid}`,
      `[wikidata-api] Property ${pid} missing from ${qid}`);
  }

  for (const claim of claims) {
    const wdUrl = getStringValue(claim);
    if (wdUrl && urlMatches(factValue, wdUrl)) {
      return makeResult(item, 'confirmed', 0.95,
        `Wikidata ${pid} (website) = ${wdUrl}`,
        `[wikidata-api] FactBase value '${factValue}' matches Wikidata ${pid} = '${wdUrl}'`);
    }
  }

  const wdUrls = claims.map(c => getStringValue(c)).filter(Boolean);
  return makeResult(item, 'contradicted', 0.90,
    `Wikidata ${pid} (website) = ${wdUrls.join(', ')}`,
    `[wikidata-api] FactBase value '${factValue}' does not match Wikidata ${pid} values`);
}

function matchSitelink(
  item: VerifyItem,
  entity: WikidataEntity,
  factValue: string,
  qid: string,
): VerifyResult | null {
  const wikiUrl = getWikipediaUrl(entity);
  if (!wikiUrl) {
    return makeResult(item, 'unverifiable', 0.80,
      `No English Wikipedia sitelink on ${qid}`,
      `[wikidata-api] No enwiki sitelink on ${qid}`);
  }

  if (urlMatches(factValue, wikiUrl)) {
    return makeResult(item, 'confirmed', 0.95,
      `Wikidata sitelink (enwiki) = ${wikiUrl}`,
      `[wikidata-api] FactBase value '${factValue}' matches Wikipedia URL from sitelink`);
  }

  return makeResult(item, 'contradicted', 0.90,
    `Wikidata sitelink (enwiki) = ${wikiUrl}`,
    `[wikidata-api] FactBase value '${factValue}' does not match Wikipedia sitelink URL '${wikiUrl}'`);
}

function matchDate(
  item: VerifyItem,
  entity: WikidataEntity,
  pid: string,
  factValue: string,
  qid: string,
): VerifyResult | null {
  const claims = getClaimsForProperty(entity, pid);
  if (claims.length === 0) {
    return makeResult(item, 'unverifiable', 0.80,
      `Wikidata ${pid} not present on ${qid}`,
      `[wikidata-api] Property ${pid} missing from ${qid}`);
  }

  for (const claim of claims) {
    const timeStr = getTimeValue(claim);
    if (!timeStr) continue;
    // Convert Wikidata time "+2015-12-11T00:00:00Z" to "2015-12"
    const match = timeStr.match(/([+-]?\d+)-(\d{2})-(\d{2})/);
    if (!match) continue;
    const year = String(parseInt(match[1], 10));
    const wdDate = `${year}-${match[2]}`;
    if (dateMatches(factValue, wdDate)) {
      return makeResult(item, 'confirmed', 0.95,
        `Wikidata ${pid} (${propertyLabel(pid)}) = ${wdDate}`,
        `[wikidata-api] FactBase value '${factValue}' matches Wikidata ${pid} = '${wdDate}'`);
    }
  }

  const wdDates = claims.map(c => {
    const t = getTimeValue(c);
    if (!t) return null;
    const m = t.match(/([+-]?\d+)-(\d{2})/);
    return m ? `${parseInt(m[1], 10)}-${m[2]}` : null;
  }).filter(Boolean);

  return makeResult(item, 'contradicted', 0.90,
    `Wikidata ${pid} (${propertyLabel(pid)}) = ${wdDates.join(', ')}`,
    `[wikidata-api] FactBase value '${factValue}' does not match Wikidata ${pid} values`);
}

function matchYear(
  item: VerifyItem,
  entity: WikidataEntity,
  pid: string,
  factValue: string,
  qid: string,
): VerifyResult | null {
  const claims = getClaimsForProperty(entity, pid);
  if (claims.length === 0) {
    return makeResult(item, 'unverifiable', 0.80,
      `Wikidata ${pid} not present on ${qid}`,
      `[wikidata-api] Property ${pid} missing from ${qid}`);
  }

  for (const claim of claims) {
    const year = getYearFromTime(claim);
    if (!year) continue;
    // FactBase born-year is stored as just the year number
    if (String(factValue) === String(year)) {
      return makeResult(item, 'confirmed', 0.95,
        `Wikidata ${pid} (${propertyLabel(pid)}) year = ${year}`,
        `[wikidata-api] FactBase value '${factValue}' matches Wikidata ${pid} year = '${year}'`);
    }
  }

  const wdYears = claims.map(c => getYearFromTime(c)).filter(Boolean);
  return makeResult(item, 'contradicted', 0.90,
    `Wikidata ${pid} (${propertyLabel(pid)}) years = ${wdYears.join(', ')}`,
    `[wikidata-api] FactBase value '${factValue}' does not match Wikidata ${pid} year values`);
}

async function matchEntityRef(
  item: VerifyItem,
  entity: WikidataEntity,
  pid: string,
  factValue: string,
  qid: string,
  multiValued: boolean,
): Promise<VerifyResult | null> {
  const claims = getClaimsForProperty(entity, pid);
  if (claims.length === 0) {
    return makeResult(item, 'unverifiable', 0.80,
      `Wikidata ${pid} not present on ${qid}`,
      `[wikidata-api] Property ${pid} missing from ${qid}`);
  }

  // Extract all referenced entity QIDs
  const refQids = claims.map(c => getEntityRefQid(c)).filter((q): q is string => q !== null);
  if (refQids.length === 0) {
    return makeResult(item, 'unverifiable', 0.80,
      `Wikidata ${pid} claims have no entity references on ${qid}`,
      `[wikidata-api] Property ${pid} on ${qid} has no wikibase-entityid values`);
  }

  // Resolve QIDs to English labels
  const labels = await resolveLabels(refQids);
  if (labels.size === 0) {
    // No English labels found — can't compare, fall through to LLM
    return null;
  }

  const labelValues = [...labels.values()];
  const labelEntries = [...labels.entries()];

  if (multiValued) {
    // For multi-valued properties (e.g., founders), check if the fact value
    // matches ANY of the Wikidata values. The fact value might be one of several.
    const matchedLabels: string[] = [];
    for (const [refQid, label] of labelEntries) {
      if (nameMatches(factValue, label)) {
        matchedLabels.push(`${refQid} (${label})`);
      }
    }

    if (matchedLabels.length > 0) {
      return makeResult(item, 'confirmed', 0.95,
        `Wikidata ${pid} (${propertyLabel(pid)}) includes ${matchedLabels.join(', ')}`,
        `[wikidata-api] FactBase value '${factValue}' matches Wikidata ${pid}: ${matchedLabels.join(', ')}`);
    }

    // No match found — could be partial (value is a different founder not in Wikidata, etc.)
    const allLabels = labelEntries.map(([q, l]) => `${q} (${l})`).join(', ');
    return makeResult(item, 'contradicted', 0.90,
      `Wikidata ${pid} (${propertyLabel(pid)}) = ${allLabels}`,
      `[wikidata-api] FactBase value '${factValue}' not found in Wikidata ${pid} values: ${labelValues.join(', ')}`);
  } else {
    // Single-valued: check the first (preferred or normal rank) claim
    for (const [refQid, label] of labelEntries) {
      if (nameMatches(factValue, label)) {
        return makeResult(item, 'confirmed', 0.95,
          `Wikidata ${pid} (${propertyLabel(pid)}) = ${refQid} (${label})`,
          `[wikidata-api] FactBase value '${factValue}' matches Wikidata ${pid} = '${label}'`);
      }
    }

    const allLabels = labelEntries.map(([q, l]) => `${q} (${l})`).join(', ');
    return makeResult(item, 'contradicted', 0.90,
      `Wikidata ${pid} (${propertyLabel(pid)}) = ${allLabels}`,
      `[wikidata-api] FactBase value '${factValue}' does not match Wikidata ${pid} = '${labelValues.join(', ')}'`);
  }
}

function matchQuantity(
  item: VerifyItem,
  entity: WikidataEntity,
  pid: string,
  factValue: string,
  qid: string,
  tolerance: number,
): VerifyResult | null {
  const claims = getClaimsForProperty(entity, pid);
  if (claims.length === 0) {
    return makeResult(item, 'unverifiable', 0.80,
      `Wikidata ${pid} not present on ${qid}`,
      `[wikidata-api] Property ${pid} missing from ${qid}`);
  }

  // Detect the fact's currency (if any) BEFORE stripping symbols, so we can
  // enforce unit compatibility against Wikidata claims below.
  const factCurrency = detectCurrencyQid(factValue);

  // Parse the fact value as a number (strip currency symbols, commas, whitespace).
  // Enforce a strict numeric match so values like "$5.8 billion" or "3100 employees"
  // fall through to LLM verification instead of being silently partial-parsed.
  const cleanedFact = factValue.replace(/[$€£¥,\s]/g, '');
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(cleanedFact)) {
    return null; // Can't parse cleanly — fall through to LLM
  }
  const factNum = Number(cleanedFact);

  // Only compare against claims whose unit matches the fact's currency
  // (or both sides are dimensionless, e.g. for P1128 employee counts).
  // Cross-currency comparisons like €6B vs $6B would otherwise produce
  // false confirmations.
  const compatibleClaims: Array<{ amount: number; unit: string | null }> = [];
  for (const claim of claims) {
    const wd = getQuantityValue(claim);
    if (wd == null) continue;
    if (wd.unit === factCurrency) compatibleClaims.push(wd);
  }

  if (compatibleClaims.length === 0) {
    // No unit-compatible claim — fall through to LLM rather than risk a false
    // contradiction across different currencies / units.
    return null;
  }

  for (const wd of compatibleClaims) {
    const ratio = Math.abs(factNum - wd.amount) / Math.max(Math.abs(wd.amount), 1);
    if (ratio <= tolerance) {
      return makeResult(item, 'confirmed', 0.95,
        `Wikidata ${pid} (${propertyLabel(pid)}) = ${wd.amount}`,
        `[wikidata-api] FactBase value '${factValue}' (~${factNum}) matches Wikidata ${pid} = ${wd.amount} (within ${(tolerance * 100).toFixed(0)}% tolerance)`);
    }
  }

  const wdValues = compatibleClaims.map(v => v.amount);
  return makeResult(item, 'contradicted', 0.90,
    `Wikidata ${pid} (${propertyLabel(pid)}) = ${wdValues.join(', ')}`,
    `[wikidata-api] FactBase value '${factValue}' (~${factNum}) does not match Wikidata ${pid} = ${wdValues.join(', ')}`);
}

// ── Utility ─────────────────────────────────────────────────────────

/** Human-readable labels for common Wikidata properties */
const PID_LABELS: Record<string, string> = {
  P856: 'official website',
  P571: 'inception',
  P17: 'country',
  P159: 'headquarters',
  P112: 'founded by',
  P69: 'educated at',
  P1454: 'legal form',
  P569: 'date of birth',
  P169: 'CEO',
  P749: 'parent organization',
  P1128: 'employees',
  P2139: 'revenue',
};

function propertyLabel(pid: string): string {
  return PID_LABELS[pid] ?? pid;
}

// ── Batch pre-fetch ─────────────────────────────────────────────────

/**
 * Pre-fetch Wikidata entities for a batch of verify items.
 * Scans items for Wikidata source URLs, extracts QIDs, and fetches them
 * in batches of 50 to warm the cache before individual verification.
 */
export async function prefetchWikidataEntities(items: VerifyItem[]): Promise<number> {
  const qids = new Set<string>();
  for (const item of items) {
    if (item.data.kind !== 'fact') continue;
    const factData = item.data as FactItemData;
    const source = factData.fact.source;
    if (!source) continue;
    const qid = extractQid(source);
    if (qid) qids.add(qid);
  }

  if (qids.size === 0) return 0;

  await fetchEntities([...qids]);
  return qids.size;
}
