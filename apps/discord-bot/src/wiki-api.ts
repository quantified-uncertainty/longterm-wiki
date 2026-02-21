import { WIKI_SERVER_URL, WIKI_SERVER_API_KEY } from "./config.js";

export interface SearchResult {
  id: string;
  numericId: string | null;
  title: string;
  description: string | null;
  entityType: string | null;
  category: string | null;
  readerImportance: number | null;
  quality: number | null;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  total: number;
}

export interface PageDetail {
  id: string;
  numericId: string | null;
  title: string;
  description: string | null;
  llmSummary: string | null;
  category: string | null;
  subcategory: string | null;
  entityType: string | null;
  tags: string | null;
  quality: number | null;
  readerImportance: number | null;
  contentPlaintext: string | null;
  wordCount: number | null;
  lastUpdated: string | null;
}

export interface RelatedPage {
  id: string;
  type: string;
  title: string;
  score: number;
  label?: string;
}

export interface RelatedPagesResponse {
  entityId: string;
  related: RelatedPage[];
  total: number;
}

export interface EntityDetail {
  id: string;
  numericId: string | null;
  entityType: string;
  title: string;
  description: string | null;
  website: string | null;
  tags: string[] | null;
  clusters: string[] | null;
  status: string | null;
  lastUpdated: string | null;
  customFields: Array<{ label: string; value: string; link?: string }> | null;
  relatedEntries: Array<{ id: string; type: string; relationship?: string }> | null;
  sources: Array<{ title: string; url?: string; author?: string; date?: string }> | null;
}

export interface EntitySearchResponse {
  results: EntityDetail[];
  query: string;
  total: number;
}

export interface Fact {
  id: number;
  entityId: string;
  factId: string;
  label: string | null;
  value: string | null;
  numeric: number | null;
  low: number | null;
  high: number | null;
  asOf: string | null;
  measure: string | null;
  subject: string | null;
  note: string | null;
  source: string | null;
  sourceResource: string | null;
  format: string | null;
  formatDivisor: number | null;
}

export interface FactsResponse {
  entityId: string;
  facts: Fact[];
  total: number;
  limit: number;
  offset: number;
}

export interface CitationQuote {
  id: number;
  pageId: string;
  footnote: number;
  url: string | null;
  resourceId: string | null;
  claimText: string;
  claimContext: string | null;
  sourceQuote: string | null;
  sourceLocation: string | null;
  quoteVerified: boolean;
  verificationScore: number | null;
  sourceTitle: string | null;
  sourceType: string | null;
  accuracyVerdict: string | null;
  accuracyScore: number | null;
}

export interface PageCitationsResponse {
  quotes: CitationQuote[];
}

export interface Resource {
  id: string;
  url: string;
  title: string | null;
  type: string | null;
  summary: string | null;
  review: string | null;
  authors: string[] | null;
  publishedDate: string | null;
  tags: string[] | null;
}

export interface ResourceSearchResponse {
  results: Resource[];
  count: number;
  query: string;
}

export interface Backlink {
  id: string;
  type: string;
  title: string;
  relationship?: string;
  linkType: string;
  weight: number;
}

export interface BacklinksResponse {
  targetId: string;
  backlinks: Backlink[];
  total: number;
}

export interface WikiHealth {
  status: string;
  database: string;
  totalIds: number;
  totalPages: number;
  totalEntities: number;
  totalFacts: number;
  nextId: number;
  uptime: number;
}

export interface CitationStats {
  totalQuotes: number;
  withQuotes: number;
  verified: number;
  unverified: number;
  totalPages: number;
  averageScore: number | null;
}

export interface WikiStats {
  health: WikiHealth;
  citations: CitationStats;
}

export interface PageChange {
  id: number;
  date: string;
  branch: string | null;
  title: string;
  summary: string | null;
  model: string | null;
  duration: string | null;
  cost: string | null;
  prUrl: string | null;
  pages: string[];
}

export interface RecentChangesResponse {
  sessions: PageChange[];
}

export interface AutoUpdateRun {
  id: number;
  date: string;
  startedAt: string;
  completedAt: string | null;
  trigger: string;
  budgetLimit: number | null;
  budgetSpent: number | null;
  sourcesChecked: number | null;
  itemsFetched: number | null;
  itemsRelevant: number | null;
  pagesPlanned: number | null;
  pagesUpdated: number | null;
  pagesFailed: number | null;
  newPagesCreated: string[];
  results: Array<{
    pageId: string;
    status: string;
    tier: string | null;
    errorMessage: string | null;
  }>;
}

export interface AutoUpdateStatusResponse {
  entries: AutoUpdateRun[];
  total: number;
  limit: number;
  offset: number;
}

export interface BrokenCitation {
  pageId: string;
  footnote: number;
  url: string | null;
  claimText: string;
  verificationScore: number | null;
}

export interface CitationHealthResponse {
  broken: BrokenCitation[];
}

export interface RiskPage {
  pageId: string;
  score: number;
  level: "low" | "medium" | "high";
  factors: string[] | null;
  integrityIssues: string[] | null;
  computedAt: string;
}

export interface RiskReportResponse {
  pages: RiskPage[];
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
  };
  if (WIKI_SERVER_API_KEY) {
    h["Authorization"] = `Bearer ${WIKI_SERVER_API_KEY}`;
  }
  return h;
}

export async function searchWiki(
  query: string,
  limit = 10
): Promise<SearchResult[]> {
  const url = new URL("/api/pages/search", WIKI_SERVER_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      console.error(`Wiki search failed: ${res.status} ${res.statusText}`);
      return [];
    }
    const data = (await res.json()) as SearchResponse;
    return data.results;
  } catch (error) {
    console.error("Wiki search error:", error);
    return [];
  }
}

export async function getPage(id: string): Promise<PageDetail | null> {
  const url = new URL(`/api/pages/${encodeURIComponent(id)}`, WIKI_SERVER_URL);

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`Wiki getPage failed: ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as PageDetail;
  } catch (error) {
    console.error("Wiki getPage error:", error);
    return null;
  }
}

export async function getRelatedPages(
  id: string,
  limit = 10
): Promise<RelatedPagesResponse | null> {
  const url = new URL(
    `/api/links/related/${encodeURIComponent(id)}`,
    WIKI_SERVER_URL
  );
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`getRelatedPages failed: ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as RelatedPagesResponse;
  } catch (error) {
    console.error("getRelatedPages error:", error);
    return null;
  }
}

export async function getEntity(id: string): Promise<EntityDetail | null> {
  const url = new URL(
    `/api/entities/${encodeURIComponent(id)}`,
    WIKI_SERVER_URL
  );

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`getEntity failed: ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as EntityDetail;
  } catch (error) {
    console.error("getEntity error:", error);
    return null;
  }
}

export async function searchEntities(
  query: string,
  limit = 10
): Promise<EntitySearchResponse | null> {
  const url = new URL("/api/entities/search", WIKI_SERVER_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      console.error(`searchEntities failed: ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as EntitySearchResponse;
  } catch (error) {
    console.error("searchEntities error:", error);
    return null;
  }
}

export async function getFacts(entityId: string): Promise<FactsResponse | null> {
  const url = new URL(
    `/api/facts/by-entity/${encodeURIComponent(entityId)}`,
    WIKI_SERVER_URL
  );

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`getFacts failed: ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as FactsResponse;
  } catch (error) {
    console.error("getFacts error:", error);
    return null;
  }
}

export async function getPageCitations(
  pageId: string
): Promise<PageCitationsResponse | null> {
  const url = new URL("/api/citations/quotes", WIKI_SERVER_URL);
  url.searchParams.set("page_id", pageId);

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      console.error(
        `getPageCitations failed: ${res.status} ${res.statusText}`
      );
      return null;
    }
    return (await res.json()) as PageCitationsResponse;
  } catch (error) {
    console.error("getPageCitations error:", error);
    return null;
  }
}

export async function searchResources(
  query: string,
  limit = 10
): Promise<ResourceSearchResponse | null> {
  const url = new URL("/api/resources/search", WIKI_SERVER_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      console.error(`searchResources failed: ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as ResourceSearchResponse;
  } catch (error) {
    console.error("searchResources error:", error);
    return null;
  }
}

export async function getBacklinks(
  id: string,
  limit = 20
): Promise<BacklinksResponse | null> {
  const url = new URL(
    `/api/links/backlinks/${encodeURIComponent(id)}`,
    WIKI_SERVER_URL
  );
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`getBacklinks failed: ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as BacklinksResponse;
  } catch (error) {
    console.error("getBacklinks error:", error);
    return null;
  }
}

export async function getWikiStats(): Promise<WikiStats | null> {
  try {
    const [healthRes, citationsRes] = await Promise.all([
      fetch(new URL("/health", WIKI_SERVER_URL).toString(), {
        headers: headers(),
      }),
      fetch(new URL("/api/citations/stats", WIKI_SERVER_URL).toString(), {
        headers: headers(),
      }),
    ]);

    if (!healthRes.ok) {
      console.error(`getWikiStats /health failed: ${healthRes.status} ${healthRes.statusText}`);
      return null;
    }
    if (!citationsRes.ok) {
      console.error(`getWikiStats /api/citations/stats failed: ${citationsRes.status} ${citationsRes.statusText}`);
      return null;
    }

    const health = (await healthRes.json()) as WikiHealth;
    const citations = (await citationsRes.json()) as CitationStats;
    return { health, citations };
  } catch (error) {
    console.error("getWikiStats error:", error);
    return null;
  }
}

export async function getRecentChanges(
  limit = 10,
  since?: string
): Promise<RecentChangesResponse | null> {
  const url = new URL("/api/sessions/page-changes", WIKI_SERVER_URL);
  url.searchParams.set("limit", String(limit));
  if (since) {
    url.searchParams.set("since", since);
  }

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      console.error(`getRecentChanges failed: ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as RecentChangesResponse;
  } catch (error) {
    console.error("getRecentChanges error:", error);
    return null;
  }
}

export async function getAutoUpdateStatus(
  limit = 5
): Promise<AutoUpdateStatusResponse | null> {
  const url = new URL("/api/auto-update-runs/all", WIKI_SERVER_URL);
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      console.error(
        `getAutoUpdateStatus failed: ${res.status} ${res.statusText}`
      );
      return null;
    }
    return (await res.json()) as AutoUpdateStatusResponse;
  } catch (error) {
    console.error("getAutoUpdateStatus error:", error);
    return null;
  }
}

export async function getCitationHealth(): Promise<CitationHealthResponse | null> {
  const url = new URL("/api/citations/broken", WIKI_SERVER_URL);

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      console.error(
        `getCitationHealth failed: ${res.status} ${res.statusText}`
      );
      return null;
    }
    return (await res.json()) as CitationHealthResponse;
  } catch (error) {
    console.error("getCitationHealth error:", error);
    return null;
  }
}

export async function getRiskReport(
  level: "low" | "medium" | "high" | undefined = "high",
  limit = 10
): Promise<RiskReportResponse | null> {
  const url = new URL("/api/hallucination-risk/latest", WIKI_SERVER_URL);
  url.searchParams.set("level", level);
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      console.error(`getRiskReport failed: ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as RiskReportResponse;
  } catch (error) {
    console.error("getRiskReport error:", error);
    return null;
  }
}
