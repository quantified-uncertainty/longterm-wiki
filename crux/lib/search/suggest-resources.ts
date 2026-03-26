/**
 * Resource Suggestion — ensure URLs have resource records and fresh content.
 *
 * Part of the claims-first verification pipeline (#3253).
 * Research agents call this before submitting claims that reference URLs.
 *
 * Flow:
 *   1. Call POST /api/resources/suggest → get resourceIds + contentStatus
 *   2. For URLs needing content: call fetchSources() concurrently
 *   3. Return final results with enriched metadata
 */

import { fetchSources } from './source-fetcher.ts';
import { suggestResourcesApi, type SuggestResourcesResult } from '../wiki-server/resources.ts';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SuggestResourcesOptions {
  urls: string[];
  entityId?: string;
  agentSessionId?: string;
  maxContentAgeMs?: number;
  /** Max concurrent fetches. Default: 5 */
  concurrency?: number;
}

export interface SuggestedResource {
  url: string;
  resourceId: string;
  status: 'ok' | 'error' | 'paywall' | 'dead';
  contentLength: number;
  title: string | null;
}

export interface SuggestResourcesOutput {
  resources: SuggestedResource[];
  fetchedCount: number;
  cachedCount: number;
  errorCount: number;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function suggestResources(
  options: SuggestResourcesOptions,
): Promise<SuggestResourcesOutput> {
  const { urls, entityId, agentSessionId, maxContentAgeMs, concurrency = 5 } = options;

  if (urls.length === 0) {
    return { resources: [], fetchedCount: 0, cachedCount: 0, errorCount: 0 };
  }

  // Step 1: Call wiki-server to get/create resources and check freshness
  const apiResult = await suggestResourcesApi({
    urls,
    entityId,
    agentSessionId,
    maxContentAgeMs,
  });

  if (!apiResult.ok) {
    throw new Error(`suggestResources API failed: ${apiResult.error ?? apiResult.message}`);
  }

  const { results } = apiResult.data;

  // Step 2: Identify URLs that need fetching
  const fresh = results.filter((r) => r.contentStatus === 'fresh');
  const needsFetch = results.filter((r) => r.contentStatus !== 'fresh');

  // Step 3: Fetch content for URLs that need it
  const fetchResultMap = new Map<string, { status: string; contentLength: number; title: string }>();

  if (needsFetch.length > 0) {
    const fetchRequests = needsFetch.map((r) => ({
      url: r.url,
      resourceId: r.resourceId,
      extractMode: 'full' as const,
      updateResourceStatus: true,
    }));

    const fetchResults = await fetchSources(fetchRequests, { concurrency });

    for (let i = 0; i < needsFetch.length; i++) {
      const resp = fetchResults[i];
      fetchResultMap.set(needsFetch[i].url, {
        status: resp.status,
        contentLength: resp.content?.length ?? 0,
        title: resp.title,
      });
    }
  }

  // Step 4: Assemble final results
  let fetchedCount = 0;
  let errorCount = 0;

  const resources: SuggestedResource[] = results.map((r) => {
    if (r.contentStatus === 'fresh') {
      return {
        url: r.url,
        resourceId: r.resourceId,
        status: 'ok' as const,
        contentLength: 0, // fresh content exists but we didn't re-fetch, so length unknown
        title: r.title,
      };
    }

    const fetched = fetchResultMap.get(r.url);
    const status = (fetched?.status ?? 'error') as SuggestedResource['status'];
    if (status === 'ok') fetchedCount++;
    else errorCount++;

    return {
      url: r.url,
      resourceId: r.resourceId,
      status,
      contentLength: fetched?.contentLength ?? 0,
      title: fetched?.title ?? r.title,
    };
  });

  return {
    resources,
    fetchedCount,
    cachedCount: fresh.length,
    errorCount,
  };
}
