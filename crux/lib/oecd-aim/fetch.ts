/**
 * Fetch incidents from the OECD AI Incident Monitor (AIM) JSON API.
 *
 * The AIM "Download results" button on https://oecd.ai/en/incidents only
 * exports the currently-visible page (≤ 20 rows) as XLSX — it is NOT a
 * bulk-download endpoint. The list endpoint that backs the page is the
 * actual bulk source:
 *
 *   POST https://incidents-server.oecdai.org/api/v1/incidents/fetch-incidents
 *   body: { from_date, to_date, num_results, format: "JSON", ... }
 *
 * Constraints discovered via probing:
 *   - `num_results` is server-capped at 100. A 200 request returns
 *     `{"detail":"num results should be maximum of 100"}`.
 *   - `skip` / `offset` / `start_index` are silently IGNORED — the only
 *     pagination axis is the date window.
 *   - 14,574 incidents over ~6 years (~6/day average), with ~150-200 in
 *     the busiest months. So we slice by date window and recurse when
 *     `total_results > 100`.
 *
 * Rate limiting: AIM has no documented rate limit. We default to a 200ms
 * delay between requests (~5 req/s). For ~14k incidents pulled in
 * adaptive 14-day windows that's ~80 req per pass; well under any
 * reasonable bound.
 */

const DEFAULT_BASE_URL = "https://incidents-server.oecdai.org";
const ENDPOINT = "/api/v1/incidents/fetch-incidents";
const DETAIL_ENDPOINT_PREFIX = "/api/v1/incidents/";

/** Max incidents per response; enforced server-side. */
export const MAX_NUM_RESULTS = 100;

/** Default starting window in days. Adaptive halving handles dense periods. */
export const DEFAULT_WINDOW_DAYS = 14;

/** Floor for adaptive halving; prevents infinite recursion on >100/day surges. */
export const MIN_WINDOW_DAYS = 1;

/** Earliest data point in AIM (April 2020 from sampled time series). */
export const AIM_EARLIEST_DATE = "2020-04-29";

import type {
  OecdAimIncidentRaw,
  OecdAimArticleRaw,
} from "./transform.ts";

interface ListEndpointBody {
  search_terms: string[];
  and_condition: boolean;
  countries: string[];
  from_date: string;
  to_date: string;
  properties_config: {
    principles: string[];
    industries: string[];
    harm_types: string[];
    harm_levels: string[];
    harmed_entities: string[];
    business_functions: string[];
    ai_tasks: string[];
    autonomy_levels: string[];
    languages: string[];
  };
  order_by: string;
  num_results: number;
  format: "JSON" | "EXCEL";
}

interface ListEndpointResponse {
  total_results: number;
  incidents: OecdAimIncidentRaw[];
  /** Other top-level keys (time series, stats) — ignored for ingest. */
  [key: string]: unknown;
}

interface DetailEndpointResponse extends OecdAimIncidentRaw {
  articles: OecdAimArticleRaw[] | null;
}

export interface FetchOptions {
  /** Override base URL (tests / staging). */
  baseUrl?: string;
  /** Custom fetch impl (tests). */
  fetchImpl?: typeof fetch;
  /** Politeness delay between requests in ms. Default 200. */
  delayMs?: number;
  /** Cap on the global request count. Aborts the run when exceeded. */
  maxRequests?: number;
}

function buildBody(fromDate: string, toDate: string): ListEndpointBody {
  return {
    search_terms: [],
    and_condition: false,
    countries: [],
    from_date: fromDate,
    to_date: toDate,
    properties_config: {
      principles: [],
      industries: [],
      harm_types: [],
      harm_levels: [],
      harmed_entities: [],
      business_functions: [],
      ai_tasks: [],
      autonomy_levels: [],
      languages: [],
    },
    order_by: "date",
    num_results: MAX_NUM_RESULTS,
    format: "JSON",
  };
}

async function postList(
  url: string,
  body: ListEndpointBody,
  fetchImpl: typeof fetch,
): Promise<ListEndpointResponse> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://oecd.ai",
    },
    body: JSON.stringify(body),
    redirect: "error",
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `AIM list endpoint ${res.status} ${res.statusText}: ${errText.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as ListEndpointResponse;
  if (!json || typeof json !== "object" || !Array.isArray(json.incidents)) {
    throw new Error(
      `AIM list endpoint returned unexpected shape: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return json;
}

async function getDetail(
  base: string,
  id: string,
  fetchImpl: typeof fetch,
): Promise<DetailEndpointResponse> {
  // The AIM id format is `YYYY-MM-DD-XXXX` — strict enough to safely
  // interpolate into the path. Defense-in-depth: validate before fetching.
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9]+$/i.test(id)) {
    throw new Error(`Refusing to fetch detail with malformed AIM id: ${id}`);
  }
  const url = `${base}${DETAIL_ENDPOINT_PREFIX}${encodeURIComponent(id)}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Origin: "https://oecd.ai" },
    redirect: "error",
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `AIM detail ${id} ${res.status} ${res.statusText}: ${errText.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as DetailEndpointResponse;
  if (!json || typeof json !== "object" || typeof json.id !== "string") {
    throw new Error(
      `AIM detail ${id} returned unexpected shape: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return json;
}

/** Add `days` (positive or negative) to a YYYY-MM-DD string and return YYYY-MM-DD. */
export function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Difference in days between two YYYY-MM-DD strings (b − a). */
export function daysBetween(aISO: string, bISO: string): number {
  const a = new Date(`${aISO}T00:00:00Z`).getTime();
  const b = new Date(`${bISO}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface FetchResult {
  incidents: OecdAimIncidentRaw[];
  /** Number of list-endpoint requests issued. */
  listRequests: number;
  /** Number of windows that needed adaptive halving. */
  windowSplits: number;
}

/**
 * Walk the date range with adaptive windowing and collect every incident.
 *
 * Algorithm:
 *   1. Start at the full range with `windowDays` per slice.
 *   2. POST the list endpoint for the slice.
 *   3. If `total_results > MAX_NUM_RESULTS` and the slice spans > 1 day,
 *      halve the slice and recurse on each half.
 *   4. Otherwise emit the returned incidents.
 *   5. Move to the next non-overlapping slice.
 *
 * Dedup is by `id` because adjacent slices share the boundary date (AIM
 * `from_date`/`to_date` are inclusive on both ends), and the recursion
 * itself can produce overlapping recursive halves at the boundary.
 */
export async function fetchAllIncidents(
  fromDate: string,
  toDate: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const delayMs = options.delayMs ?? 200;
  const maxRequests = options.maxRequests ?? 5000;

  const seen = new Set<string>();
  const out: OecdAimIncidentRaw[] = [];
  let listRequests = 0;
  let windowSplits = 0;

  async function fetchSlice(
    sliceFrom: string,
    sliceTo: string,
  ): Promise<void> {
    if (listRequests >= maxRequests) {
      throw new Error(
        `AIM ingest exceeded maxRequests=${maxRequests} — bug or upstream change?`,
      );
    }
    const body = buildBody(sliceFrom, sliceTo);
    const url = `${baseUrl}${ENDPOINT}`;
    listRequests++;
    const res = await postList(url, body, fetchImpl);
    if (delayMs > 0) await sleep(delayMs);

    if (
      res.total_results > MAX_NUM_RESULTS &&
      daysBetween(sliceFrom, sliceTo) >= MIN_WINDOW_DAYS * 2
    ) {
      // Recurse: halve the slice. Both halves get the boundary day; we
      // dedup by id below.
      windowSplits++;
      const mid = addDaysISO(
        sliceFrom,
        Math.floor(daysBetween(sliceFrom, sliceTo) / 2),
      );
      await fetchSlice(sliceFrom, mid);
      await fetchSlice(addDaysISO(mid, 1), sliceTo);
      return;
    }

    if (res.total_results > MAX_NUM_RESULTS) {
      // Single-day slice but more than MAX_NUM_RESULTS incidents — this
      // would silently drop rows. AIM has never had such a day in observed
      // data; surface loudly so we notice if it ever happens.
      throw new Error(
        `AIM single-day slice ${sliceFrom} returned total_results=${res.total_results} ` +
          `but MAX_NUM_RESULTS=${MAX_NUM_RESULTS} — pagination not possible. Investigate.`,
      );
    }

    for (const inc of res.incidents) {
      if (!inc?.id || seen.has(inc.id)) continue;
      seen.add(inc.id);
      out.push(inc);
    }
  }

  // Walk forward in `windowDays` chunks. The recursion handles dense periods;
  // dense+sparse mixed years still bottom out at single-day slices.
  const windowDays = options ? DEFAULT_WINDOW_DAYS : DEFAULT_WINDOW_DAYS;
  let cursor = fromDate;
  while (cursor <= toDate) {
    const sliceEnd = (() => {
      const candidate = addDaysISO(cursor, windowDays - 1);
      return candidate > toDate ? toDate : candidate;
    })();
    await fetchSlice(cursor, sliceEnd);
    cursor = addDaysISO(sliceEnd, 1);
  }

  return { incidents: out, listRequests, windowSplits };
}

/**
 * Fetch the article list (with URLs) for one incident.
 *
 * Used optionally during ingest to populate `reports[]` / `aiIncidentReports`
 * rows. Slow path — one request per incident — so callers should opt-in.
 */
export async function fetchIncidentDetail(
  id: string,
  options: FetchOptions = {},
): Promise<DetailEndpointResponse> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  return getDetail(baseUrl, id, fetchImpl);
}
