/**
 * Source Fetcher — fetch and cache source documents for source-checking.
 *
 * Shared by factbase-source-check and source-check-orchestrate. Handles:
 * - SSRF protection (block private/internal hosts)
 * - Unverifiable domain detection
 * - Wikidata structured data extraction (JSON API)
 * - Wiki-server citation content cache lookup
 * - Direct HTTP fetch with HTML-to-text stripping
 * - Paywall detection
 */

import {
  detectPaywall,
  isUnverifiableDomain,
  classifyFetchError,
} from '../search/paywall-detection.ts';
import { getCitationContentByUrl } from '../wiki-server/citations.ts';
import type { FetchSourceResult } from './types.ts';
import { SOURCE_CHECK_CONSTANTS } from './types.ts';

const { MAX_CONTENT_LENGTH, FETCH_TIMEOUT_MS } = SOURCE_CHECK_CONSTANTS;

/** HTTP status codes that indicate transient errors worth retrying. */
export const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

/** Maximum number of retry attempts for transient HTTP errors. */
export const MAX_RETRIES = 2;

/** Backoff delays in ms for each retry attempt (index 0 = first retry). */
export const RETRY_DELAYS_MS = [1000, 3000];

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Wikidata structured data extraction
// ---------------------------------------------------------------------------

/** Matches Wikidata entity page URLs like https://www.wikidata.org/wiki/Q15733006 */
const WIKIDATA_QID_PATTERN = /^https?:\/\/(?:www\.)?wikidata\.org\/wiki\/(Q\d+)$/;

/** Timeout for the Wikidata JSON API fetch (10s — separate from the general FETCH_TIMEOUT_MS) */
const WIKIDATA_FETCH_TIMEOUT_MS = 10_000;

/** Max bytes to read from the Wikidata JSON response (50 KB) */
const WIKIDATA_MAX_JSON_BYTES = 50_000;

/**
 * Wikidata property IDs we extract, mapped to human-readable labels.
 * These cover the most common structured facts used in FactBase sources.
 */
export const WIKIDATA_PROPERTIES: Record<string, string> = {
  P31: 'Instance of',
  P112: 'Founder',
  P159: 'Headquarters',
  P17: 'Country',
  P355: 'Subsidiary',
  P452: 'Industry',
  P571: 'Founded',
  P576: 'Dissolved',
  P749: 'Parent organization',
  P856: 'Website',
  P1128: 'Employee count',
  P1454: 'Legal form',
  P1830: 'Owner of',
  P2139: 'Total revenue',
  P2403: 'Total assets',
  P569: 'Date of birth',
  P570: 'Date of death',
  P27: 'Country of citizenship',
  P108: 'Employer',
  P69: 'Educated at',
  P166: 'Award received',
  P39: 'Position held',
  P463: 'Member of',
  P1416: 'Affiliation',
};

/**
 * Common Wikidata entity QIDs mapped to human-readable names.
 * Used to resolve references in claims (e.g., P159 → Q84 → "London").
 * This avoids needing recursive API calls for frequently-referenced entities.
 */
export const COMMON_ENTITY_LABELS: Record<string, string> = {
  // Countries
  Q30: 'United States', Q145: 'United Kingdom', Q148: 'China',
  Q142: 'France', Q183: 'Germany', Q17: 'Japan', Q408: 'Australia',
  Q16: 'Canada', Q38: 'Italy', Q29: 'Spain', Q155: 'Brazil',
  Q668: 'India', Q884: 'South Korea', Q801: 'Israel', Q55: 'Netherlands',
  Q39: 'Switzerland', Q34: 'Sweden', Q20: 'Norway', Q35: 'Denmark',
  Q36: 'Poland', Q28: 'Hungary', Q40: 'Austria', Q33: 'Finland',
  Q37: 'Lithuania', Q184: 'Belarus', Q159: 'Russia', Q212: 'Ukraine',
  Q869: 'Thailand', Q334: 'Singapore', Q865: 'Taiwan',
  Q858: 'South Africa',

  // Major cities
  Q84: 'London', Q90: 'Paris', Q64: 'Berlin', Q60: 'New York City',
  Q62: 'San Francisco', Q65: 'Los Angeles', Q18426: 'Mountain View',
  Q1781: 'Palo Alto', Q16552: 'Menlo Park', Q16553: 'Redmond',
  Q1297: 'Chicago', Q100: 'Boston', Q61: 'Washington, D.C.',
  Q1490: 'Tokyo', Q956: 'Beijing', Q8686: 'Shanghai',
  Q1218: 'Jerusalem', Q47554: 'Tel Aviv', Q1055: 'Hamburg',
  Q1726: 'Munich', Q649: 'Moscow', Q1854: 'Zurich', Q72: 'Geneva',
  Q36600: 'The Hague', Q727: 'Amsterdam', Q1748: 'Copenhagen',
  Q1757: 'Helsinki', Q1754: 'Stockholm', Q2807: 'Madrid',
  Q220: 'Rome', Q2256: 'Pittsburgh', Q34006: 'Seattle',
  Q1509: 'Austin', Q49: 'Toronto', Q1930: 'Cupertino',

  // Common organizations
  Q95: 'Google', Q312: 'Apple', Q2283: 'Microsoft',
  Q380: 'Meta Platforms', Q843899: 'DeepMind',
  Q21692564: 'Alphabet Inc.',

  // Legal forms
  Q4539: 'Public limited company',
  Q6881511: 'Limited liability company',
  Q7278: 'Political party',
  Q783794: 'Company',
  Q43229: 'Organization',
  Q4830453: 'Business',
  Q5341295: 'Educational institution',
  Q31855: 'Research institute',
  Q7210356: 'Technology company',
};

/**
 * Check if a URL is a Wikidata entity page.
 * Returns the QID (e.g., "Q15733006") if it matches, or null.
 */
export function extractWikidataQid(url: string): string | null {
  const match = url.match(WIKIDATA_QID_PATTERN);
  return match ? match[1] : null;
}

/**
 * Extract a human-readable value from a Wikidata claim snak.
 * Handles time, quantity, string, wikibase-entityid, and monolingualtext types.
 */
function extractSnakValue(snak: WikidataMainSnak): string | null {
  if (snak.snaktype !== 'value' || !snak.datavalue) return null;
  const dv = snak.datavalue;

  switch (dv.type) {
    case 'time': {
      const raw = (dv.value as WikidataTimeValue).time;
      // Format: "+2010-01-01T00:00:00Z" → extract year (and month/day if not Jan 1)
      const timeMatch = raw.match(/^[+-]?(\d{4})-(\d{2})-(\d{2})/);
      if (!timeMatch) return raw;
      const [, year, month, day] = timeMatch;
      if (month === '01' && day === '01') return year;
      if (day === '01') return `${year}-${month}`;
      return `${year}-${month}-${day}`;
    }
    case 'quantity': {
      const qv = dv.value as WikidataQuantityValue;
      const amount = qv.amount.replace(/^\+/, '');
      const unit = qv.unit;
      if (unit && unit !== '1' && !unit.includes('undefined')) {
        // Unit is a Wikidata URL like http://www.wikidata.org/entity/Q4917
        const unitQid = unit.match(/\/(Q\d+)$/)?.[1];
        const unitLabel = unitQid ? COMMON_ENTITY_LABELS[unitQid] : null;
        return unitLabel ? `${amount} ${unitLabel}` : amount;
      }
      return amount;
    }
    case 'string':
      return dv.value as string;
    case 'wikibase-entityid': {
      const entityId = (dv.value as WikidataEntityIdValue).id;
      return COMMON_ENTITY_LABELS[entityId] ?? entityId;
    }
    case 'monolingualtext':
      return (dv.value as WikidataMonolingualTextValue).text;
    default:
      return null;
  }
}

/**
 * Format extracted Wikidata claims into a human-readable text block.
 */
function formatWikidataEntity(
  qid: string,
  label: string | null,
  description: string | null,
  aliases: string[],
  claims: Record<string, string[]>,
): string {
  const lines: string[] = [];

  const entityHeader = label ? `${label} (${qid})` : qid;
  lines.push(`Entity: ${entityHeader}`);

  if (description) lines.push(`Description: ${description}`);
  if (aliases.length > 0) lines.push(`Also known as: ${aliases.join(', ')}`);
  lines.push('');

  // Output claims in a stable order matching WIKIDATA_PROPERTIES
  for (const [pid, propLabel] of Object.entries(WIKIDATA_PROPERTIES)) {
    const values = claims[pid];
    if (values && values.length > 0) {
      // Cap at 5 values per property to keep output concise
      const display = values.length > 5
        ? [...values.slice(0, 5), `(+${values.length - 5} more)`]
        : values;
      lines.push(`${propLabel}: ${display.join('; ')}`);
    }
  }

  return lines.join('\n');
}

// Minimal type definitions for the Wikidata JSON response shape we care about.
// These are not exhaustive — only what extractSnakValue reads.

interface WikidataTimeValue { time: string; }
interface WikidataQuantityValue { amount: string; unit: string; }
interface WikidataEntityIdValue { id: string; }
interface WikidataMonolingualTextValue { text: string; }

interface WikidataMainSnak {
  snaktype: string;
  datavalue?: {
    type: string;
    value: WikidataTimeValue | WikidataQuantityValue | WikidataEntityIdValue |
           WikidataMonolingualTextValue | string;
  };
}

interface WikidataClaim {
  mainsnak: WikidataMainSnak;
  rank?: string;
}

interface WikidataEntity {
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  aliases?: Record<string, Array<{ value: string }>>;
  claims?: Record<string, WikidataClaim[]>;
}

/**
 * Fetch structured data from Wikidata's JSON API and format it as readable text.
 *
 * Converts `https://www.wikidata.org/wiki/Q15733006` to
 * `https://www.wikidata.org/wiki/Special:EntityData/Q15733006.json`
 * and extracts labels, descriptions, and key claims.
 *
 * @returns FetchSourceResult with formatted text content, or null content on failure
 */
export async function fetchWikidataContent(
  qid: string,
  logPrefix = '[source-check]',
): Promise<FetchSourceResult> {
  const apiUrl = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WIKIDATA_FETCH_TIMEOUT_MS);

    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'LongtermWiki-SourceChecker/1.0 (https://www.longtermwiki.com)',
        'Accept': 'application/json',
      },
    });
    clearTimeout(timer);

    if (!response.ok) {
      console.warn(`${logPrefix} Wikidata JSON API returned HTTP ${response.status} for ${qid}`);
      return { content: null, errorType: 'fetch_error', errorMessage: `Wikidata API HTTP ${response.status}` };
    }

    // Read the body with a size limit to avoid memory issues on large entities
    const rawText = await response.text();
    const truncatedText = rawText.length > WIKIDATA_MAX_JSON_BYTES
      ? rawText.slice(0, WIKIDATA_MAX_JSON_BYTES)
      : rawText;

    let data: { entities?: Record<string, WikidataEntity> };
    try {
      // If we truncated, the JSON may be invalid — try to parse, fall back on failure
      data = JSON.parse(truncatedText);
    } catch {
      if (rawText.length > WIKIDATA_MAX_JSON_BYTES) {
        console.warn(`${logPrefix} Wikidata JSON truncated and unparseable for ${qid} (${rawText.length} bytes)`);
        return { content: null, errorType: 'fetch_error', errorMessage: 'Wikidata JSON too large to parse' };
      }
      throw new Error('Invalid JSON from Wikidata API');
    }

    const entity = data.entities?.[qid];
    if (!entity) {
      console.warn(`${logPrefix} Wikidata JSON has no entity ${qid}`);
      return { content: null, errorType: 'fetch_error', errorMessage: `No entity ${qid} in response` };
    }

    // Extract label, description, aliases (English preferred)
    const label = entity.labels?.en?.value ?? null;
    const description = entity.descriptions?.en?.value ?? null;
    const aliases = (entity.aliases?.en ?? []).map((a) => a.value);

    // Extract claims for our known properties
    const extractedClaims: Record<string, string[]> = {};
    if (entity.claims) {
      for (const pid of Object.keys(WIKIDATA_PROPERTIES)) {
        const claimGroup = entity.claims[pid];
        if (!claimGroup) continue;

        const values: string[] = [];
        for (const claim of claimGroup) {
          // Skip deprecated claims
          if (claim.rank === 'deprecated') continue;
          const val = extractSnakValue(claim.mainsnak);
          if (val) values.push(val);
        }
        if (values.length > 0) {
          extractedClaims[pid] = values;
        }
      }
    }

    const text = formatWikidataEntity(qid, label, description, aliases, extractedClaims);
    console.log(`${logPrefix} Wikidata: extracted structured data for ${qid}${label ? ` (${label})` : ''}`);
    return { content: text.slice(0, MAX_CONTENT_LENGTH) };
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      console.warn(`${logPrefix} Wikidata JSON fetch timed out for ${qid}`);
      return { content: null, errorType: 'timeout', errorMessage: 'Wikidata JSON fetch timed out' };
    }
    console.warn(
      `${logPrefix} Wikidata JSON fetch failed for ${qid}: ${e instanceof Error ? e.message : String(e)}`,
    );
    // Return null — caller will fall back to normal HTML fetch
    return { content: null, errorType: 'fetch_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Check if a hostname is a private/internal address that should be blocked (SSRF protection).
 */
export function isPrivateHost(host: string): boolean {
  return (
    host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
    host === '::1' || host === '0.0.0.0' || host === '[::]' || host === '::' ||
    host.endsWith('.local') || host.endsWith('.internal') ||
    /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^fe80:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^::ffff:127\./i.test(host) || /^::ffff:10\./i.test(host) ||
    /^::ffff:192\.168\./i.test(host) ||
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./i.test(host) ||
    /^::ffff:169\.254\./i.test(host)
  );
}

/**
 * Strip HTML tags and entities from raw HTML, returning plain text.
 * Prioritizes <main>, <article>, or role="main" content to avoid
 * nav/header/footer pollution that causes false "unverifiable" verdicts.
 */
export function htmlToText(html: string): string {
  // Try to extract the main content area first to avoid nav/menu noise
  const bodyContent = extractMainContent(html) ?? html;

  return bodyContent
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Try to extract the main content from an HTML page.
 * Returns the inner HTML of <main>, <article>, or role="main" element,
 * or null if none found.
 */
function extractMainContent(html: string): string | null {
  // Try <main> tag
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch && mainMatch[1].length > 200) return mainMatch[1];

  // Try role="main"
  const roleMainMatch = html.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/\w+>/i);
  if (roleMainMatch && roleMainMatch[1].length > 200) return roleMainMatch[1];

  // Try <article> tag
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch && articleMatch[1].length > 200) return articleMatch[1];

  // No main content area found — fall back to full HTML
  return null;
}

/**
 * Fetch source content from a URL for source-checking.
 *
 * Attempts in order:
 * 1. Wikidata JSON API (for wikidata.org/wiki/Q* URLs — structured data extraction)
 * 2. Wiki-server citation content cache
 * 3. Direct HTTP fetch (with retry for transient errors)
 *
 * Applies SSRF protection, unverifiable domain detection, and paywall detection.
 *
 * @param url - The source URL to fetch
 * @param userAgent - User-Agent string for direct HTTP fetches
 * @param logPrefix - Prefix for log messages (default: '[source-check]')
 */
export async function fetchSourceContent(
  url: string,
  userAgent = 'LongtermWiki-SourceChecker/1.0',
  logPrefix = '[source-check]',
): Promise<FetchSourceResult> {
  if (!url.startsWith('https://')) {
    return { content: null, errorType: 'fetch_error', errorMessage: 'Non-HTTPS URL' };
  }

  // SSRF protection
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (isPrivateHost(host)) {
      return { content: null, errorType: 'access_denied', errorMessage: 'Private host blocked' };
    }
  } catch {
    return { content: null, errorType: 'fetch_error', errorMessage: 'Invalid URL' };
  }

  if (isUnverifiableDomain(url)) {
    return { content: null, errorType: 'unverifiable_domain', errorMessage: 'Domain blocks automated access' };
  }

  // Wikidata special handling: fetch structured JSON instead of HTML
  const wikidataQid = extractWikidataQid(url);
  if (wikidataQid) {
    const wikidataResult = await fetchWikidataContent(wikidataQid, logPrefix);
    if (wikidataResult.content) {
      return wikidataResult;
    }
    // If Wikidata JSON fetch failed, fall through to normal HTML fetch
    console.warn(`${logPrefix} Wikidata JSON failed for ${wikidataQid}, falling back to HTML fetch`);
  }

  // Try wiki-server citation_content cache
  try {
    const result = await getCitationContentByUrl(url);
    if (result.ok && result.data) {
      const cached = result.data as Record<string, unknown>;
      const content = cached.fullText as string | null;
      if (content && content.length > 0) {
        if (detectPaywall(content)) {
          return { content: content.slice(0, MAX_CONTENT_LENGTH), errorType: 'paywall', errorMessage: 'Cached content appears paywalled' };
        }
        return { content: content.slice(0, MAX_CONTENT_LENGTH) };
      }
    }
  } catch (e: unknown) {
    console.warn(`${logPrefix} Cache miss: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Direct fetch with retry for transient errors
  let lastResult: FetchSourceResult | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,text/plain',
        },
      });
      clearTimeout(timer);

      if (!response.ok) {
        const status = response.status;
        // Consume the body to avoid leaking connections.
        // Intentionally quiet: body content is irrelevant for error responses.
        await response.text().catch(() => {});

        if (RETRYABLE_STATUS_CODES.has(status) && attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS_MS[attempt];
          console.warn(`${logPrefix} HTTP ${status} for ${url}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(delay);
          continue;
        }

        const errorType = classifyFetchError(status, null, null, url);
        return { content: null, errorType: errorType ?? 'fetch_error', errorMessage: `HTTP ${status}` };
      }

      const html = await response.text();
      const text = htmlToText(html).slice(0, MAX_CONTENT_LENGTH);

      if (detectPaywall(text)) {
        return { content: text, errorType: 'paywall', errorMessage: 'Content appears paywalled' };
      }

      return { content: text };
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        lastResult = { content: null, errorType: 'timeout', errorMessage: 'Request timed out' };
      } else {
        lastResult = { content: null, errorType: 'fetch_error', errorMessage: e instanceof Error ? e.message : String(e) };
      }

      // Network-level errors are also retryable (connection reset, DNS timeout, etc.)
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[attempt];
        console.warn(`${logPrefix} Fetch error for ${url}: ${lastResult.errorMessage}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }
    }
  }

  // All retries exhausted — return the last error result
  return lastResult ?? { content: null, errorType: 'fetch_error', errorMessage: 'All retries exhausted' };
}
