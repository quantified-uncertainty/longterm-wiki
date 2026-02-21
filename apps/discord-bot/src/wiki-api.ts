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
