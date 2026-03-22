/**
 * Federal Register Provider — discovers regulatory documents, executive orders,
 * and proposed rules.
 *
 * API: https://www.federalregister.gov/developers/documentation/api/v1
 * No auth required. Free API with generous rate limits.
 *
 * Only activated for `policy` entity type.
 */

import type { SearchProvider, SearchHit } from './types.ts';

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

interface FederalRegisterDocument {
  title: string;
  html_url: string;
  abstract?: string | null;
  publication_date: string;
  document_type?: string;
  type?: string;
  agencies?: Array<{ name: string; raw_name?: string }>;
  document_number?: string;
  citation?: string;
}

interface FederalRegisterResponse {
  count: number;
  results: FederalRegisterDocument[];
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const FR_BASE = 'https://www.federalregister.gov/api/v1';

async function frFetch(path: string): Promise<FederalRegisterResponse> {
  const response = await fetch(`${FR_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Federal Register API error ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json() as Promise<FederalRegisterResponse>;
}

function documentToHit(doc: FederalRegisterDocument): SearchHit {
  const agencies = doc.agencies?.map(a => a.name).join(', ') ?? '';
  return {
    url: doc.html_url,
    title: doc.title,
    snippet: [
      doc.publication_date,
      doc.document_type ?? doc.type ?? null,
      agencies || null,
      doc.abstract?.slice(0, 200) ?? null,
    ].filter(Boolean).join(' — '),
    provider: 'federal-register',
  };
}

// ---------------------------------------------------------------------------
// Search functions
// ---------------------------------------------------------------------------

/**
 * Detect if the query is about executive orders specifically.
 * Matches patterns like "Executive Order", "EO 14110", etc.
 */
function isExecutiveOrderQuery(query: string): boolean {
  return /executive\s+order|^\s*EO\s+\d/i.test(query);
}

async function searchDocuments(query: string, maxResults: number): Promise<SearchHit[]> {
  const params = new URLSearchParams({
    'conditions[term]': query,
    per_page: String(maxResults),
    order: 'relevance',
  });

  // Add executive order specialization if detected
  if (isExecutiveOrderQuery(query)) {
    params.set('conditions[presidential_document_type]', 'executive_order');
  }

  const data = await frFetch(`/documents.json?${params.toString()}`);

  return data.results
    .filter(doc => doc.title && doc.html_url)
    .map(documentToHit);
}

// ---------------------------------------------------------------------------
// Public provider
// ---------------------------------------------------------------------------

/**
 * Create a Federal Register search provider.
 *
 * Only meaningful for policy entity types. Searches for regulatory documents,
 * executive orders, proposed rules, and notices.
 */
export function createFederalRegisterProvider(): SearchProvider {
  return {
    name: 'federal-register',

    isAvailable(): boolean {
      // No API key required — always available
      return true;
    },

    async search(query: string, maxResults: number, _entityType?: string): Promise<SearchHit[]> {
      return searchDocuments(query, maxResults);
    },
  };
}
