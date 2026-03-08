/**
 * Shared helper for fetching all pages from a paginated wiki-server endpoint.
 *
 * All paginated wiki-server endpoints return `{ <key>: T[], total, limit, offset }`.
 * This helper fetches page 1 to learn `total`, then fetches remaining pages
 * in parallel and concatenates the results.
 *
 * Error policy: if any intermediate page fails, the entire fetch fails.
 * This avoids silently returning partial data as if it were complete.
 */

import { fetchDetailed, type FetchResult } from "./wiki-server";

export interface FetchAllPaginatedOptions {
  /** API path prefix, e.g. "/api/statements" */
  path: string;
  /** Key in the response object that holds the array, e.g. "statements" or "claims" */
  itemsKey: string;
  /** Max items per page (default: 500). Must not exceed the server's maxLimit. */
  pageSize?: number;
  /** Extra query params to append (e.g. "includeSources=true") */
  extraParams?: string;
  /** Next.js ISR revalidate in seconds (default: 300) */
  revalidate?: number;
  /** Per-request timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Total time budget in ms. If exceeded between pages, stops and fails (default: 90000) */
  deadlineMs?: number;
}

export interface FetchAllPaginatedResult<T> {
  items: T[];
  total: number;
  /** Number of pages fetched */
  pagesFetched: number;
}

/**
 * Fetch all items from a paginated wiki-server endpoint.
 *
 * Fetches the first page to learn the total, then fetches remaining pages
 * in parallel. Fails if any page request fails — never returns partial data.
 */
export async function fetchAllPaginated<T>(
  options: FetchAllPaginatedOptions
): Promise<FetchResult<FetchAllPaginatedResult<T>>> {
  const {
    path,
    itemsKey,
    pageSize = 500,
    extraParams,
    revalidate = 300,
    timeoutMs = 30_000,
    deadlineMs = 90_000,
  } = options;

  const deadline = Date.now() + deadlineMs;

  function buildUrl(limit: number, offset: number): string {
    const params = `limit=${limit}&offset=${offset}`;
    const extra = extraParams ? `&${extraParams}` : "";
    const sep = path.includes("?") ? "&" : "?";
    return `${path}${sep}${params}${extra}`;
  }

  // Fetch first page to learn total
  const first = await fetchDetailed<Record<string, unknown>>(
    buildUrl(pageSize, 0),
    { revalidate, timeoutMs }
  );
  if (!first.ok) return first;

  const rawTotal = first.data.total;
  if (typeof rawTotal !== "number" || !Number.isFinite(rawTotal)) {
    return {
      ok: false,
      error: {
        type: "connection-error",
        message: `Expected numeric "total" in response, got ${typeof rawTotal} (${String(rawTotal)})`,
      },
    };
  }
  const total = rawTotal;
  const firstItems = first.data[itemsKey] as T[];
  if (!Array.isArray(firstItems)) {
    return {
      ok: false,
      error: {
        type: "connection-error",
        message: `Expected array at response key "${itemsKey}", got ${typeof first.data[itemsKey]}`,
      },
    };
  }

  // Single page — done
  if (total <= pageSize) {
    return {
      ok: true,
      data: { items: firstItems, total, pagesFetched: 1 },
    };
  }

  // Check deadline before launching parallel fetches
  if (Date.now() > deadline) {
    return {
      ok: false,
      error: {
        type: "connection-error",
        message: `Deadline exceeded after first page (${total} total items, ${Math.ceil(total / pageSize)} pages needed)`,
      },
    };
  }

  const totalPages = Math.ceil(total / pageSize);
  console.warn(
    `[fetchAllPaginated] ${path}: ${total} items across ${totalPages} pages — fetching remaining ${totalPages - 1} pages in parallel`
  );

  // Fetch remaining pages in parallel
  const remainingPromises: Promise<FetchResult<Record<string, unknown>>>[] = [];
  for (let offset = pageSize; offset < total; offset += pageSize) {
    remainingPromises.push(
      fetchDetailed<Record<string, unknown>>(buildUrl(pageSize, offset), {
        revalidate,
        timeoutMs,
      })
    );
  }

  const pages = await Promise.all(remainingPromises);

  // Fail if any page errored — don't silently return partial data
  const all = [...firstItems];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!page.ok) {
      return {
        ok: false,
        error: {
          type: "connection-error",
          message: `Page ${i + 2}/${totalPages} failed: ${page.error.type === "connection-error" ? page.error.message : `${page.error.type}`}`,
        },
      };
    }
    const pageItems = page.data[itemsKey] as T[];
    if (!Array.isArray(pageItems)) {
      return {
        ok: false,
        error: {
          type: "connection-error",
          message: `Page ${i + 2}: expected array at "${itemsKey}", got ${typeof page.data[itemsKey]}`,
        },
      };
    }
    all.push(...pageItems);
  }

  return {
    ok: true,
    data: { items: all, total, pagesFetched: totalPages },
  };
}
