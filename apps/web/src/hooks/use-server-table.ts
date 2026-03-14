"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";

export interface ServerTableMeta {
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface ServerTableSort {
  field: string;
  dir: "asc" | "desc";
}

export interface UseServerTableOptions<T> {
  /** API endpoint URL (e.g., "/api/grants/by-entity/open-philanthropy") */
  endpoint: string;
  /** Default items per page */
  defaultPageSize?: number;
  /** Default sort configuration */
  defaultSort?: ServerTableSort;
  /** Debounce delay for search input (ms) */
  debounceMs?: number;
  /** Transform API response JSON into rows and total count */
  transform: (json: unknown) => { rows: T[]; total: number };
  /** Set false to disable fetching (e.g., in static mode) */
  enabled?: boolean;
}

export interface UseServerTableResult<T> {
  data: T[];
  meta: ServerTableMeta;
  isLoading: boolean;
  error: string | null;
  search: string;
  setSearch: (q: string) => void;
  sort: ServerTableSort;
  setSort: (field: string, dir?: "asc" | "desc") => void;
  page: number;
  setPage: (p: number) => void;
  pageSize: number;
  setPageSize: (s: number) => void;
  filters: Record<string, string>;
  setFilter: (key: string, value: string | undefined) => void;
}

/**
 * Reusable hook for server-paginated tables.
 *
 * Manages page, pageSize, search (debounced), sort, and arbitrary filters.
 * Fetches data from the given endpoint with these params as query strings.
 * Uses AbortController to cancel stale requests.
 */
export function useServerTable<T>(
  options: UseServerTableOptions<T>,
): UseServerTableResult<T> {
  const {
    endpoint,
    defaultPageSize = 50,
    defaultSort = { field: "amount", dir: "desc" as const },
    debounceMs = 300,
    enabled = true,
  } = options;

  // Use a ref for transform to avoid re-fetching when the function reference changes
  const transformRef = useRef(options.transform);
  transformRef.current = options.transform;

  const [data, setData] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearchRaw] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sort, setSortState] = useState<ServerTableSort>(defaultSort);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(defaultPageSize);
  const [filters, setFilters] = useState<Record<string, string>>({});

  const abortRef = useRef<AbortController | null>(null);

  // Debounce search and reset to page 1
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPageState(1);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [search, debounceMs]);

  // Build the query string (stable serialization for effect deps)
  const queryKey = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", String(pageSize));
    params.set("offset", String((page - 1) * pageSize));
    if (debouncedSearch) params.set("q", debouncedSearch);
    params.set("sort", `${sort.field}:${sort.dir}`);
    for (const [k, v] of Object.entries(filters)) {
      if (v) params.set(k, v);
    }
    return params.toString();
  }, [pageSize, page, debouncedSearch, sort, filters]);

  // Fetch data when query changes
  useEffect(() => {
    if (!enabled) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    fetch(`${endpoint}?${queryKey}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const result = transformRef.current(json);
        setData(result.rows);
        setTotal(result.total);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [endpoint, queryKey, enabled]);

  // Wrapped setters that reset page when appropriate
  const setSearch = useCallback((q: string) => {
    setSearchRaw(q);
    // page reset happens in the debounce effect
  }, []);

  const setSort = useCallback(
    (field: string, dir?: "asc" | "desc") => {
      setSortState((prev) => {
        if (prev.field === field && !dir) {
          return { field, dir: prev.dir === "asc" ? "desc" : "asc" };
        }
        return { field, dir: dir ?? "desc" };
      });
      setPageState(1);
    },
    [],
  );

  const setPage = useCallback((p: number) => {
    setPageState(p);
  }, []);

  const setPageSize = useCallback((s: number) => {
    setPageSizeState(s);
    setPageState(1);
  }, []);

  const setFilter = useCallback(
    (key: string, value: string | undefined) => {
      setFilters((prev) => {
        if (value === undefined && !(key in prev)) return prev;
        if (value !== undefined && prev[key] === value) return prev;
        const next = { ...prev };
        if (value === undefined) {
          delete next[key];
        } else {
          next[key] = value;
        }
        return next;
      });
      setPageState(1);
    },
    [],
  );

  const meta = useMemo<ServerTableMeta>(
    () => ({
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    }),
    [total, page, pageSize],
  );

  return {
    data,
    meta,
    isLoading,
    error,
    search,
    setSearch,
    sort,
    setSort,
    page,
    setPage,
    pageSize,
    setPageSize,
    filters,
    setFilter,
  };
}
