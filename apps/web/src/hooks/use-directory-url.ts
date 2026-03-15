"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface DirectoryUrlSort {
  field: string;
  dir: "asc" | "desc";
}

export interface UseDirectoryUrlConfig {
  /** Default sort when no `sort` param is present in the URL. */
  defaultSort?: DirectoryUrlSort;
  /** Filter param names that may appear in the URL (e.g., ["type", "category"]). */
  filters?: string[];
}

export interface UseDirectoryUrlResult {
  search: string;
  setSearch: (q: string) => void;
  sort: DirectoryUrlSort;
  setSort: (sort: DirectoryUrlSort) => void;
  page: number;
  setPage: (p: number) => void;
  filters: Record<string, string>;
  setFilter: (name: string, value: string) => void;
  resetAll: () => void;
}

/**
 * Syncs directory table state (search, sort, page, filters) to URL query
 * parameters so that the current view is shareable and browser-navigable.
 *
 * - `page` is 0-indexed internally but 1-indexed in the URL.
 * - Default values are omitted from the URL for cleanliness.
 * - Changing search, sort, or filters resets the page to 0.
 * - Search URL updates are debounced (300 ms) but the local state updates
 *   immediately for responsive UI.
 */
const DEFAULT_SORT: DirectoryUrlSort = { field: "name", dir: "asc" };

export function useDirectoryUrl(
  config: UseDirectoryUrlConfig = {},
): UseDirectoryUrlResult {
  const {
    defaultSort = DEFAULT_SORT,
    filters: filterNames = [],
  } = config;

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // ── Parse initial state from URL (runs once per mount) ──

  const initialState = useMemo(() => {
    const q = searchParams.get("q") ?? "";

    const sortParam = searchParams.get("sort");
    let sort = defaultSort;
    if (sortParam) {
      const [field, dir] = sortParam.split(":");
      if (field && (dir === "asc" || dir === "desc")) {
        sort = { field, dir };
      }
    }

    const pageParam = searchParams.get("page");
    const parsedPage = pageParam ? parseInt(pageParam, 10) : NaN;
    const page = Number.isNaN(parsedPage) ? 0 : Math.max(0, parsedPage - 1);

    const filters: Record<string, string> = {};
    for (const name of filterNames) {
      const val = searchParams.get(name);
      if (val) {
        filters[name] = val;
      }
    }

    return { q, sort, page, filters };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only read URL on mount
  }, []);

  // ── Local state ──

  const [search, setSearchRaw] = useState(initialState.q);
  const [sort, setSortState] = useState<DirectoryUrlSort>(initialState.sort);
  const [page, setPageState] = useState(initialState.page);
  const [filters, setFiltersState] = useState<Record<string, string>>(
    initialState.filters,
  );

  // Keep a ref of debouncedSearch for the URL sync effect
  const [debouncedSearch, setDebouncedSearch] = useState(initialState.q);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Debounce search ──

  useEffect(() => {
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [search]);

  // ── Sync state → URL ──

  // Track whether this is the initial render to avoid pushing the URL on mount
  const isInitialRender = useRef(true);

  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }

    const params = new URLSearchParams();

    if (debouncedSearch) {
      params.set("q", debouncedSearch);
    }

    const sortStr = `${sort.field}:${sort.dir}`;
    const defaultStr = `${defaultSort.field}:${defaultSort.dir}`;
    if (sortStr !== defaultStr) {
      params.set("sort", sortStr);
    }

    if (page > 0) {
      params.set("page", String(page + 1));
    }

    for (const [name, value] of Object.entries(filters)) {
      if (value && value !== "all") {
        params.set(name, value);
      }
    }

    const qs = params.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;

    router.replace(url, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally tracking specific deps
  }, [debouncedSearch, sort, page, filters, pathname, router, defaultSort]);

  // ── Setters ──

  const setSearch = useCallback((q: string) => {
    setSearchRaw(q);
    setPageState(0);
  }, []);

  const setSort = useCallback((nextSort: DirectoryUrlSort) => {
    setSortState(nextSort);
    setPageState(0);
  }, []);

  const setPage = useCallback((p: number) => {
    setPageState(p);
  }, []);

  const setFilter = useCallback((name: string, value: string) => {
    setFiltersState((prev) => {
      if (value === "all") {
        if (!(name in prev)) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      }
      if (prev[name] === value) return prev;
      return { ...prev, [name]: value };
    });
    setPageState(0);
  }, []);

  const resetAll = useCallback(() => {
    setSearchRaw("");
    setDebouncedSearch("");
    setSortState(defaultSort);
    setPageState(0);
    setFiltersState({});
  }, [defaultSort]);

  return {
    search,
    setSearch,
    sort,
    setSort,
    page,
    setPage,
    filters,
    setFilter,
    resetAll,
  };
}
