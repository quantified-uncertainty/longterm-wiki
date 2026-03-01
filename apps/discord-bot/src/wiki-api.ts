/**
 * Wiki API client for the discord-bot.
 *
 * Response types are imported from the shared crux/lib/wiki-server/ modules
 * to prevent drift between codebases (#595, #620).
 *
 * Types that are discord-bot-specific (health checks, stats, risk reports,
 * citation health) remain defined locally since crux doesn't need them.
 */

import { WIKI_SERVER_URL, WIKI_SERVER_API_KEY } from "./config.js";
import { logger } from "./log.js";

// ---------------------------------------------------------------------------
// Shared types — imported from crux/lib/wiki-server/
// ---------------------------------------------------------------------------

import type {
  PageSearchResult,
  PageDetail,
  RelatedResult,
  BacklinksResult,
  CitationQuote,
  CitationQuotesResult,
} from "../../../crux/lib/wiki-server/pages.ts";

import type {
  EntityEntry,
  EntitySearchResult,
} from "../../../crux/lib/wiki-server/entities.ts";

import type {
  FactEntry,
  FactsByEntityResult,
} from "../../../crux/lib/wiki-server/facts.ts";

import type {
  SessionEntry,
} from "../../../crux/lib/wiki-server/sessions.ts";

import type {
  AutoUpdateRunEntry,
} from "../../../crux/lib/wiki-server/auto-update.ts";

// Re-export shared types for consumers within discord-bot
export type {
  PageSearchResult,
  PageDetail,
  RelatedResult,
  BacklinksResult,
  CitationQuote,
  CitationQuotesResult,
  EntityEntry,
  EntitySearchResult,
  FactsByEntityResult,
  FactEntry,
  SessionEntry,
  AutoUpdateRunEntry,
};

// ---------------------------------------------------------------------------
// Discord-bot-specific types (not in crux)
// ---------------------------------------------------------------------------

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

export interface RecentChangesResponse {
  sessions: SessionEntry[];
}

export interface AutoUpdateStatusResponse {
  entries: AutoUpdateRunEntry[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
  };
  if (WIKI_SERVER_API_KEY) {
    h["Authorization"] = `Bearer ${WIKI_SERVER_API_KEY}`;
  }
  return h;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function searchWiki(
  query: string,
  limit = 10
): Promise<PageSearchResult["results"]> {
  const url = new URL("/api/pages/search", WIKI_SERVER_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      logger.error({ status: res.status, statusText: res.statusText, fn: "searchWiki" }, "Wiki search failed");
      return [];
    }
    const data = (await res.json()) as PageSearchResult;
    return data.results;
  } catch (error) {
    logger.error({ err: error, fn: "searchWiki" }, "Wiki search error");
    return [];
  }
}

export async function getPage(id: string): Promise<PageDetail | null> {
  const url = new URL(`/api/pages/${encodeURIComponent(id)}`, WIKI_SERVER_URL);

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      logger.error({ status: res.status, statusText: res.statusText, fn: "getPage", id }, "Wiki getPage failed");
      return null;
    }
    return (await res.json()) as PageDetail;
  } catch (error) {
    logger.error({ err: error, fn: "getPage", id }, "Wiki getPage error");
    return null;
  }
}

export async function getRelatedPages(
  id: string,
  limit = 10
): Promise<RelatedResult | null> {
  const url = new URL(
    `/api/links/related/${encodeURIComponent(id)}`,
    WIKI_SERVER_URL
  );
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      logger.error({ status: res.status, statusText: res.statusText, fn: "getRelatedPages", id }, "getRelatedPages failed");
      return null;
    }
    return (await res.json()) as RelatedResult;
  } catch (error) {
    logger.error({ err: error, fn: "getRelatedPages", id }, "getRelatedPages error");
    return null;
  }
}

export async function getEntity(id: string): Promise<EntityEntry | null> {
  const url = new URL(
    `/api/entities/${encodeURIComponent(id)}`,
    WIKI_SERVER_URL
  );

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      logger.error({ status: res.status, statusText: res.statusText, fn: "getEntity", id }, "getEntity failed");
      return null;
    }
    return (await res.json()) as EntityEntry;
  } catch (error) {
    logger.error({ err: error, fn: "getEntity", id }, "getEntity error");
    return null;
  }
}

export async function searchEntities(
  query: string,
  limit = 10
): Promise<EntitySearchResult | null> {
  const url = new URL("/api/entities/search", WIKI_SERVER_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      logger.error({ status: res.status, statusText: res.statusText, fn: "searchEntities", query }, "searchEntities failed");
      return null;
    }
    return (await res.json()) as EntitySearchResult;
  } catch (error) {
    logger.error({ err: error, fn: "searchEntities", query }, "searchEntities error");
    return null;
  }
}

export async function getFacts(entityId: string): Promise<FactsByEntityResult | null> {
  const url = new URL(
    `/api/facts/by-entity/${encodeURIComponent(entityId)}`,
    WIKI_SERVER_URL
  );

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      logger.error({ status: res.status, statusText: res.statusText, fn: "getFacts", entityId }, "getFacts failed");
      return null;
    }
    return (await res.json()) as FactsByEntityResult;
  } catch (error) {
    logger.error({ err: error, fn: "getFacts", entityId }, "getFacts error");
    return null;
  }
}

export async function getPageCitations(
  pageId: string
): Promise<CitationQuotesResult | null> {
  const url = new URL("/api/citations/quotes", WIKI_SERVER_URL);
  url.searchParams.set("page_id", pageId);

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      logger.error({ status: res.status, statusText: res.statusText, fn: "getPageCitations", pageId }, "getPageCitations failed");
      return null;
    }
    return (await res.json()) as CitationQuotesResult;
  } catch (error) {
    logger.error({ err: error, fn: "getPageCitations", pageId }, "getPageCitations error");
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
      logger.error({ status: res.status, statusText: res.statusText, fn: "searchResources", query }, "searchResources failed");
      return null;
    }
    return (await res.json()) as ResourceSearchResponse;
  } catch (error) {
    logger.error({ err: error, fn: "searchResources", query }, "searchResources error");
    return null;
  }
}

export async function getBacklinks(
  id: string,
  limit = 20
): Promise<BacklinksResult | null> {
  const url = new URL(
    `/api/links/backlinks/${encodeURIComponent(id)}`,
    WIKI_SERVER_URL
  );
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      logger.error({ status: res.status, statusText: res.statusText, fn: "getBacklinks", id }, "getBacklinks failed");
      return null;
    }
    return (await res.json()) as BacklinksResult;
  } catch (error) {
    logger.error({ err: error, fn: "getBacklinks", id }, "getBacklinks error");
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
      logger.error({ status: healthRes.status, statusText: healthRes.statusText, fn: "getWikiStats", endpoint: "/health" }, "getWikiStats /health failed");
      return null;
    }
    if (!citationsRes.ok) {
      logger.error({ status: citationsRes.status, statusText: citationsRes.statusText, fn: "getWikiStats", endpoint: "/api/citations/stats" }, "getWikiStats /api/citations/stats failed");
      return null;
    }

    const health = (await healthRes.json()) as WikiHealth;
    const citations = (await citationsRes.json()) as CitationStats;
    return { health, citations };
  } catch (error) {
    logger.error({ err: error, fn: "getWikiStats" }, "getWikiStats error");
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
      logger.error({ status: res.status, statusText: res.statusText, fn: "getRecentChanges" }, "getRecentChanges failed");
      return null;
    }
    return (await res.json()) as RecentChangesResponse;
  } catch (error) {
    logger.error({ err: error, fn: "getRecentChanges" }, "getRecentChanges error");
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
      logger.error({ status: res.status, statusText: res.statusText, fn: "getAutoUpdateStatus" }, "getAutoUpdateStatus failed");
      return null;
    }
    return (await res.json()) as AutoUpdateStatusResponse;
  } catch (error) {
    logger.error({ err: error, fn: "getAutoUpdateStatus" }, "getAutoUpdateStatus error");
    return null;
  }
}

export async function getCitationHealth(): Promise<CitationHealthResponse | null> {
  const url = new URL("/api/citations/broken", WIKI_SERVER_URL);

  try {
    const res = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      logger.error({ status: res.status, statusText: res.statusText, fn: "getCitationHealth" }, "getCitationHealth failed");
      return null;
    }
    return (await res.json()) as CitationHealthResponse;
  } catch (error) {
    logger.error({ err: error, fn: "getCitationHealth" }, "getCitationHealth error");
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
      logger.error({ status: res.status, statusText: res.statusText, fn: "getRiskReport", level }, "getRiskReport failed");
      return null;
    }
    return (await res.json()) as RiskReportResponse;
  } catch (error) {
    logger.error({ err: error, fn: "getRiskReport", level }, "getRiskReport error");
    return null;
  }
}
