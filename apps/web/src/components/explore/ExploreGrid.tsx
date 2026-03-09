"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import type { ExploreItem } from "@/data";
import { ENTITY_GROUPS } from "@/data/entity-ontology";
import { filterAndRankBySearch } from "@/lib/explore-search";
import { ContentCard } from "./ContentCard";
import { ExploreTable } from "./ExploreTable";

type ViewMode = "cards" | "table";

// FIELD filter — based on page clusters (or entity type for special entries)
const FIELD_GROUPS: { label: string; cluster: string | null; entityType?: string }[] = [
  { label: "All", cluster: null },
  { label: "AI Safety", cluster: "ai-safety" },
  { label: "Governance", cluster: "governance" },
  { label: "Epistemics", cluster: "epistemics" },
  { label: "Community", cluster: "community" },
  { label: "Cyber", cluster: "cyber" },
  { label: "Biorisks", cluster: "biorisks" },
  { label: "Internal", cluster: null, entityType: "internal" },
];

// SECTION filter — based on page category (wiki section).
const NAMED_SECTION_GROUPS: { label: string; categories: string[] }[] = [
  { label: "Risks", categories: ["risks"] },
  { label: "Responses", categories: ["responses"] },
  { label: "Organizations", categories: ["organizations"] },
  { label: "Models", categories: ["models"] },
  { label: "People", categories: ["people"] },
  { label: "Capabilities", categories: ["capabilities", "intelligence-paradigms"] },
  { label: "Metrics", categories: ["metrics"] },
  { label: "Concepts", categories: ["cruxes", "debates", "worldviews"] },
];

const NAMED_CATEGORIES = new Set(NAMED_SECTION_GROUPS.flatMap((g) => g.categories));

// RISK CATEGORY filter
const RISK_CATEGORY_GROUPS: { label: string; value: string | null }[] = [
  { label: "All Risks", value: null },
  { label: "Accident", value: "accident" },
  { label: "Misuse", value: "misuse" },
  { label: "Structural", value: "structural" },
  { label: "Epistemic", value: "epistemic" },
];

type SortKey = "recommended" | "relevance" | "title" | "readerImportance" | "researchImportance" | "tacticalValue" | "quality" | "wordCount" | "recentlyEdited" | "recentlyCreated" | "kbFacts";

/** Use pre-computed recommended score from build-time (see build-data.mjs). */
function recommendedScore(item: ExploreItem): number {
  return item.recommendedScore ?? 0;
}

/**
 * Resolve a URL param value (e.g. "organizations", "organization", "People")
 * to the matching ENTITY_GROUPS index. Returns 0 (All) if no match.
 */
function resolveEntityGroupIndex(param: string): number {
  const lower = param.toLowerCase();

  let idx = ENTITY_GROUPS.findIndex((g) => g.label.toLowerCase() === lower);
  if (idx >= 0) return idx;

  idx = ENTITY_GROUPS.findIndex((g) => g.types.includes(lower));
  if (idx >= 0) return idx;

  if (lower.endsWith("ies")) {
    const singular = lower.slice(0, -3) + "y";
    idx = ENTITY_GROUPS.findIndex((g) => g.types.includes(singular));
    if (idx >= 0) return idx;
  } else if (lower.endsWith("es")) {
    idx = ENTITY_GROUPS.findIndex((g) => g.types.includes(lower.slice(0, -2)));
    if (idx >= 0) return idx;
    idx = ENTITY_GROUPS.findIndex((g) => g.types.includes(lower.slice(0, -1)));
    if (idx >= 0) return idx;
  } else if (lower.endsWith("s")) {
    idx = ENTITY_GROUPS.findIndex((g) => g.types.includes(lower.slice(0, -1)));
    if (idx >= 0) return idx;
  }

  return 0;
}

function FilterRow({
  label,
  options,
  active,
  onSelect,
  counts,
}: {
  label: string;
  options: string[];
  active: number;
  onSelect: (i: number) => void;
  counts: number[];
}) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground w-16 flex-shrink-0">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt, i) => (
          <button
            key={opt}
            onClick={() => onSelect(i)}
            className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
              active === i
                ? "bg-foreground text-background border-foreground"
                : "bg-background text-foreground border-border hover:bg-muted"
            }`}
          >
            {opt}{" "}
            <span className={active === i ? "text-background/70" : "text-muted-foreground"}>
              {counts[i]}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Simple text-based filter used as a client-side fallback when wiki-server is unavailable. */
function textFilter(items: ExploreItem[], query: string): ExploreItem[] {
  const q = query.toLowerCase();
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.id.toLowerCase().includes(q) ||
      item.description?.toLowerCase().includes(q) ||
      item.tags.some((t) => t.toLowerCase().includes(q))
  );
}

// ---- Server-driven explore API types ----

interface ExploreFacets {
  clusters: Record<string, number>;
  categories: Record<string, number>;
  entityTypes: Record<string, number>;
  riskCategories: Record<string, number>;
}

interface ExploreResponse {
  items: ExploreItem[];
  total: number;
  limit: number;
  offset: number;
  facets: ExploreFacets;
}

// ---- Server-driven mode hook ----

const PAGE_SIZE = 50;

/**
 * Fetch explore data from the Next.js API route.
 * Returns null if the server is unavailable (503).
 */
async function fetchExploreData(params: {
  limit: number;
  offset: number;
  search?: string;
  cluster?: string;
  category?: string;
  entityType?: string;
  riskCategory?: string;
  sort: string;
}): Promise<ExploreResponse | null> {
  const searchParams = new URLSearchParams();
  searchParams.set("limit", String(params.limit));
  searchParams.set("offset", String(params.offset));
  searchParams.set("sort", params.sort);
  if (params.search) searchParams.set("search", params.search);
  if (params.cluster) searchParams.set("cluster", params.cluster);
  if (params.category) searchParams.set("category", params.category);
  if (params.entityType) searchParams.set("entityType", params.entityType);
  if (params.riskCategory) searchParams.set("riskCategory", params.riskCategory);

  try {
    const res = await fetch(`/api/explore?${searchParams.toString()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---- Props ----

export interface ExploreGridProps {
  /** Initial items for the first render (first page from server, or all items for fallback). */
  initialItems: ExploreItem[];
  /** Total number of items matching the initial query (for server mode). Null = fallback mode. */
  initialTotal: number | null;
  /** Initial faceted counts from server. Null = fallback mode. */
  initialFacets: ExploreFacets | null;
  /** All items for fallback mode (when server is unavailable). */
  allItems?: ExploreItem[];
}

// ---- Component ----

export function ExploreGrid({ initialItems, initialTotal, initialFacets, allItems }: ExploreGridProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Determine if we're in server-driven mode
  const serverAvailable = initialTotal !== null;

  // Server mode state
  const [serverItems, setServerItems] = useState<ExploreItem[]>(initialItems);
  const [serverTotal, setServerTotal] = useState(initialTotal ?? 0);
  const [serverFacets, setServerFacets] = useState<ExploreFacets | null>(initialFacets);
  const [serverOffset, setServerOffset] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  // Track whether we've fallen back to local mode after a server failure
  const [fallbackToLocal, setFallbackToLocal] = useState(!serverAvailable);

  // Use allItems for fallback, or initialItems if no allItems provided
  const fallbackItems = allItems ?? initialItems;

  // Build section groups with dynamic "Other" catch-all.
  const SECTION_GROUPS = useMemo(() => {
    const sourceItems = fallbackToLocal ? fallbackItems : serverItems;
    // In server mode, we rely on facets for categories
    const knownCategories = fallbackToLocal
      ? sourceItems.map((item) => item.category).filter((c): c is string => !!c)
      : Object.keys(serverFacets?.categories ?? {});
    const otherCategories = [
      ...new Set(knownCategories.filter((c) => !NAMED_CATEGORIES.has(c))),
    ];
    return [
      { label: "All", categories: [] as string[] },
      ...NAMED_SECTION_GROUPS,
      ...(otherCategories.length > 0
        ? [{ label: "Other", categories: otherCategories }]
        : []),
    ];
  }, [fallbackToLocal, fallbackItems, serverItems, serverFacets]);

  // Read initial state from URL params
  const initialTag = searchParams.get("tag") || "";
  const initialEntity = searchParams.get("entity") || "";
  const initialSection = searchParams.get("section") || "";
  const initialCluster = searchParams.get("cluster") || "";
  const initialRiskCat = searchParams.get("riskCategory") || null;
  const initialRiskCatIndex = initialRiskCat
    ? Math.max(0, RISK_CATEGORY_GROUPS.findIndex((g) => g.value === initialRiskCat))
    : 0;
  const initialEntityIndex = initialEntity ? resolveEntityGroupIndex(initialEntity) : 0;
  const initialSectionIndex = initialSection
    ? Math.max(0, SECTION_GROUPS.findIndex((g) => g.label.toLowerCase() === initialSection.toLowerCase()))
    : 0;
  const initialFieldIndex = initialCluster
    ? Math.max(0, FIELD_GROUPS.findIndex((g) => g.cluster === initialCluster))
    : 0;

  const rawView = searchParams.get("view");
  const initialView: ViewMode = rawView === "table" ? "table" : "cards";

  const VALID_SORT_KEYS: SortKey[] = ["recommended", "recentlyEdited", "recentlyCreated", "quality", "readerImportance", "researchImportance", "tacticalValue", "relevance", "wordCount", "title", "kbFacts"];
  const rawSort = searchParams.get("sort");
  const initialSort: SortKey = rawSort && VALID_SORT_KEYS.includes(rawSort as SortKey) ? (rawSort as SortKey) : "recommended";

  const [viewMode, setViewMode] = useState<ViewMode>(initialView);
  const [search, setSearch] = useState(initialTag);
  const [activeField, setActiveField] = useState(initialFieldIndex);
  const [activeSection, setActiveSection] = useState(initialSectionIndex);
  const [activeEntity, setActiveEntity] = useState(
    initialRiskCat ? 1 : initialEntityIndex
  );
  const [activeRiskCat, setActiveRiskCat] = useState(initialRiskCatIndex);
  const [sortKey, setSortKey] = useState<SortKey>(initialSort);
  const [hasDataOnly, setHasDataOnly] = useState(searchParams.get("hasData") === "1");
  const [visibleCount, setVisibleCount] = useState(60);

  // Debounced URL update for search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Debounced server fetch for search
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Abort controller for in-flight fetches
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // ---- Server fetch logic ----

  /** Build server fetch params from current filter state. */
  const getServerParams = useCallback(
    (overrides?: Partial<{
      search: string;
      activeField: number;
      activeSection: number;
      activeEntity: number;
      activeRiskCat: number;
      sortKey: SortKey;
      offset: number;
    }>) => {
      const s = overrides?.search ?? search;
      const field = overrides?.activeField ?? activeField;
      const section = overrides?.activeSection ?? activeSection;
      const entity = overrides?.activeEntity ?? activeEntity;
      const riskCat = overrides?.activeRiskCat ?? activeRiskCat;
      const sk = overrides?.sortKey ?? sortKey;
      const off = overrides?.offset ?? 0;

      const fieldGroup = FIELD_GROUPS[field];
      const sectionGroup = SECTION_GROUPS[section];
      const entityGroup = ENTITY_GROUPS[entity];
      const riskCatGroup = RISK_CATEGORY_GROUPS[riskCat];

      // Map client-only sort keys to "recommended" for server (relevance and kbFacts are client-only)
      const serverSort = sk === "relevance" || sk === "kbFacts" ? "recommended" : sk;

      return {
        limit: PAGE_SIZE,
        offset: off,
        search: s || undefined,
        cluster: fieldGroup.entityType ? undefined : (fieldGroup.cluster || undefined),
        // For "Internal" field, filter by entityType instead of cluster
        entityType: fieldGroup.entityType
          ? fieldGroup.entityType
          : entityGroup.types.length > 0
            ? entityGroup.types[0] // Use first type as representative
            : undefined,
        category: sectionGroup.categories.length === 1
          ? sectionGroup.categories[0]
          : undefined,
        riskCategory: riskCatGroup.value || undefined,
        sort: serverSort,
      };
    },
    [search, activeField, activeSection, activeEntity, activeRiskCat, sortKey, SECTION_GROUPS]
  );

  /** Fetch data from the server and update state. */
  const fetchFromServer = useCallback(
    async (overrides?: Parameters<typeof getServerParams>[0]) => {
      if (fallbackToLocal) return;

      setIsLoading(true);
      const params = getServerParams(overrides);

      const data = await fetchExploreData(params);
      if (data) {
        setServerItems(data.items);
        setServerTotal(data.total);
        setServerOffset(0);
        if (data.facets) setServerFacets(data.facets);
      } else {
        // Server failed — fall back to local mode
        setFallbackToLocal(true);
      }
      setIsLoading(false);
    },
    [fallbackToLocal, getServerParams]
  );

  /** Load more items from the server (append to existing). */
  const loadMore = useCallback(async () => {
    if (fallbackToLocal) {
      setVisibleCount((c) => c + 60);
      return;
    }

    const newOffset = serverOffset + PAGE_SIZE;
    setIsLoading(true);
    const params = getServerParams({ offset: newOffset });

    const data = await fetchExploreData({ ...params, offset: newOffset });
    if (data) {
      setServerItems((prev) => [...prev, ...data.items]);
      setServerOffset(newOffset);
    }
    setIsLoading(false);
  }, [fallbackToLocal, serverOffset, getServerParams]);

  // ---- URL param management ----

  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  // ---- Filter change handlers ----

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setVisibleCount(60);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      updateUrlParams({ tag: value || null });
    }, 300);

    // Debounced server fetch
    if (!fallbackToLocal) {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
      fetchDebounceRef.current = setTimeout(() => {
        fetchFromServer({ search: value });
      }, 300);
    }
  }, [updateUrlParams, fallbackToLocal, fetchFromServer]);

  function handleFieldChange(index: number) {
    setActiveField(index);
    setVisibleCount(60);
    const cluster = FIELD_GROUPS[index].cluster;
    updateUrlParams({ cluster: cluster || null });
    if (!fallbackToLocal) fetchFromServer({ activeField: index });
  }

  function handleSectionChange(index: number) {
    setActiveSection(index);
    setVisibleCount(60);
    const group = SECTION_GROUPS[index];
    updateUrlParams({ section: group.categories.length > 0 ? group.label.toLowerCase() : null });
    if (!fallbackToLocal) fetchFromServer({ activeSection: index });
  }

  function handleEntityChange(index: number) {
    setActiveEntity(index);
    setVisibleCount(60);
    if (!fallbackToLocal) fetchFromServer({ activeEntity: index });
  }

  function handleRiskCatChange(index: number) {
    setActiveRiskCat(index);
    setVisibleCount(60);
    const value = RISK_CATEGORY_GROUPS[index].value;
    updateUrlParams({ riskCategory: value });
    if (!fallbackToLocal) fetchFromServer({ activeRiskCat: index });
  }

  function handleViewChange(mode: ViewMode) {
    setViewMode(mode);
    updateUrlParams({ view: mode === "cards" ? null : mode });
  }

  function handleSortChange(key: SortKey) {
    setSortKey(key);
    setVisibleCount(60);
    updateUrlParams({ sort: key === "recommended" ? null : key });
    if (!fallbackToLocal) fetchFromServer({ sortKey: key });
  }

  // ---- Faceted counts (computed from server facets or client-side) ----

  const fieldCounts = useMemo(() => {
    if (!fallbackToLocal && serverFacets) {
      return FIELD_GROUPS.map((group) => {
        if (group.entityType) {
          return serverFacets.entityTypes[group.entityType] ?? 0;
        }
        if (!group.cluster) return serverTotal;
        return serverFacets.clusters[group.cluster] ?? 0;
      });
    }
    // Fallback: client-side counts
    const articleItems = fallbackItems.filter((item) => item.wordCount);
    const searchFiltered = search.trim() ? textFilter(articleItems, search) : articleItems;
    return FIELD_GROUPS.map((group) => {
      if (group.entityType) return searchFiltered.filter((item) => item.type === group.entityType).length;
      if (!group.cluster) return searchFiltered.length;
      return searchFiltered.filter((item) => item.clusters.includes(group.cluster!)).length;
    });
  }, [fallbackToLocal, serverFacets, serverTotal, fallbackItems, search]);

  const sectionCounts = useMemo(() => {
    if (!fallbackToLocal && serverFacets) {
      return SECTION_GROUPS.map((group) => {
        if (group.categories.length === 0) return serverTotal;
        return group.categories.reduce((sum, cat) => sum + (serverFacets.categories[cat] ?? 0), 0);
      });
    }
    // Fallback: client-side counts
    const articleItems = fallbackItems.filter((item) => item.wordCount);
    const searchFiltered = search.trim() ? textFilter(articleItems, search) : articleItems;
    const fieldGroup = FIELD_GROUPS[activeField];
    const fieldFiltered = fieldGroup.entityType
      ? searchFiltered.filter((item) => item.type === fieldGroup.entityType)
      : fieldGroup.cluster
        ? searchFiltered.filter((item) => item.clusters.includes(fieldGroup.cluster!))
        : searchFiltered;
    return SECTION_GROUPS.map((group) => {
      if (group.categories.length === 0) return fieldFiltered.length;
      return fieldFiltered.filter((item) => item.category && group.categories.includes(item.category)).length;
    });
  }, [fallbackToLocal, serverFacets, serverTotal, fallbackItems, search, activeField, SECTION_GROUPS]);

  const entityCounts = useMemo(() => {
    if (!fallbackToLocal && serverFacets) {
      return ENTITY_GROUPS.map((group) => {
        if (group.types.length === 0) return serverTotal;
        return group.types.reduce((sum, t) => sum + (serverFacets.entityTypes[t] ?? 0), 0);
      });
    }
    // Fallback: client-side counts
    const articleItems = fallbackItems.filter((item) => item.wordCount);
    const searchFiltered = search.trim() ? textFilter(articleItems, search) : articleItems;
    const fieldGroup = FIELD_GROUPS[activeField];
    const fieldFiltered = fieldGroup.entityType
      ? searchFiltered.filter((item) => item.type === fieldGroup.entityType)
      : fieldGroup.cluster
        ? searchFiltered.filter((item) => item.clusters.includes(fieldGroup.cluster!))
        : searchFiltered;
    const sectionGroup = SECTION_GROUPS[activeSection];
    const sectionFiltered = sectionGroup.categories.length === 0
      ? fieldFiltered
      : fieldFiltered.filter((item) => item.category && sectionGroup.categories.includes(item.category));
    return ENTITY_GROUPS.map((group) => {
      if (group.types.length === 0) return sectionFiltered.length;
      return sectionFiltered.filter((item) => group.types.includes(item.type)).length;
    });
  }, [fallbackToLocal, serverFacets, serverTotal, fallbackItems, search, activeField, activeSection, SECTION_GROUPS]);

  const showRiskCatFilter = activeEntity === 1;

  const riskCatCounts = useMemo(() => {
    if (!fallbackToLocal && serverFacets) {
      const totalRisks = Object.values(serverFacets.riskCategories).reduce((a, b) => a + b, 0);
      return RISK_CATEGORY_GROUPS.map((group) => {
        if (!group.value) return totalRisks;
        return serverFacets.riskCategories[group.value] ?? 0;
      });
    }
    // Fallback: client-side counts
    const articleItems = fallbackItems.filter((item) => item.wordCount);
    const searchFiltered = search.trim() ? textFilter(articleItems, search) : articleItems;
    const riskItems = searchFiltered.filter((item) => item.type === "risk");
    return RISK_CATEGORY_GROUPS.map((group) => {
      if (!group.value) return riskItems.length;
      return riskItems.filter((item) => item.riskCategory === group.value).length;
    });
  }, [fallbackToLocal, serverFacets, fallbackItems, search]);

  // ---- Enrich server results with KB counts from local data ----
  // Server /api/explore doesn't return kbFactCount/kbItemCount. Merge from allItems.
  const kbLookup = useMemo(() => {
    if (!allItems) return null;
    const map = new Map<string, { kbFactCount?: number; kbItemCount?: number }>();
    for (const item of allItems) {
      if (item.kbFactCount || item.kbItemCount) {
        map.set(item.id, { kbFactCount: item.kbFactCount, kbItemCount: item.kbItemCount });
      }
    }
    return map;
  }, [allItems]);

  const enrichedServerItems = useMemo(() => {
    if (fallbackToLocal || !kbLookup || kbLookup.size === 0) return serverItems;
    return serverItems.map((item) => {
      if (item.kbFactCount !== undefined || item.kbItemCount !== undefined) return item;
      const local = kbLookup.get(item.id);
      if (!local) return item;
      return { ...item, ...local };
    });
  }, [fallbackToLocal, serverItems, kbLookup]);

  // ---- Compute displayed items ----

  const displayedItems = useMemo(() => {
    if (!fallbackToLocal) {
      // In server mode, items are already filtered/sorted by the server
      // KB counts are enriched from local data above
      // Apply client-side "has data" filter since server doesn't know KB counts
      const items = enrichedServerItems;
      if (hasDataOnly) {
        return items.filter((item) => (item.kbFactCount ?? 0) > 0 || (item.kbItemCount ?? 0) > 0);
      }
      // If sorting by kbFacts, re-sort client-side since server uses "recommended" fallback
      if (sortKey === "kbFacts") {
        return [...items].sort((a, b) => {
          const aTotal = (a.kbFactCount ?? 0) + (a.kbItemCount ?? 0);
          const bTotal = (b.kbFactCount ?? 0) + (b.kbItemCount ?? 0);
          return bTotal - aTotal;
        });
      }
      return items;
    }

    // Fallback: full client-side filtering pipeline
    let items = fallbackItems.filter((item) => item.wordCount);

    // Search — filter and rank by title match quality
    const hasSearch = search.trim().length > 0;
    if (hasSearch) items = filterAndRankBySearch(items, search);

    // Field filter
    const fieldGroup = FIELD_GROUPS[activeField];
    if (fieldGroup.entityType) items = items.filter((item) => item.type === fieldGroup.entityType);
    else if (fieldGroup.cluster) items = items.filter((item) => item.clusters.includes(fieldGroup.cluster!));

    // Section filter
    const sectionGroup = SECTION_GROUPS[activeSection];
    if (sectionGroup.categories.length > 0) {
      items = items.filter((item) => item.category && sectionGroup.categories.includes(item.category));
    }

    // Entity type filter
    const entityGroup = ENTITY_GROUPS[activeEntity];
    if (entityGroup.types.length > 0) {
      items = items.filter((item) => entityGroup.types.includes(item.type));
    }

    // Risk category filter
    const riskCatGroup = RISK_CATEGORY_GROUPS[activeRiskCat];
    if (riskCatGroup.value) {
      items = items.filter((item) => item.riskCategory === riskCatGroup.value);
    }

    // "Has structured data" filter
    if (hasDataOnly) {
      items = items.filter((item) => (item.kbFactCount ?? 0) > 0 || (item.kbItemCount ?? 0) > 0);
    }

    // Sort — skip in table mode since TanStack handles its own column sorting.
    // When search is active with default sort, keep search-relevance order from filterAndRankBySearch.
    const useSearchRanking = hasSearch && sortKey === "recommended";
    if (viewMode !== "table" && !useSearchRanking) {
      items = [...items].sort((a, b) => {
        switch (sortKey) {
          case "title":
            return a.title.localeCompare(b.title);
          case "readerImportance":
            return (b.readerImportance || 0) - (a.readerImportance || 0);
          case "researchImportance":
            return (b.researchImportance || 0) - (a.researchImportance || 0);
          case "tacticalValue":
            return (b.tacticalValue || 0) - (a.tacticalValue || 0);
          case "quality":
            return (b.quality || 0) - (a.quality || 0);
          case "wordCount":
            return (b.wordCount || 0) - (a.wordCount || 0);
          case "recentlyEdited":
            return (b.lastUpdated || "").localeCompare(a.lastUpdated || "");
          case "recentlyCreated": {
            const aNum = parseInt(a.numericId?.replace(/^E/, "") || "0", 10);
            const bNum = parseInt(b.numericId?.replace(/^E/, "") || "0", 10);
            return bNum - aNum;
          }
          case "relevance": {
            const scoreA = (a.readerImportance || 0) * 2 + (a.quality || 0);
            const scoreB = (b.readerImportance || 0) * 2 + (b.quality || 0);
            return scoreB - scoreA;
          }
          case "kbFacts": {
            const aTotal = (a.kbFactCount ?? 0) + (a.kbItemCount ?? 0);
            const bTotal = (b.kbFactCount ?? 0) + (b.kbItemCount ?? 0);
            return bTotal - aTotal;
          }
          case "recommended":
          default: {
            return recommendedScore(b) - recommendedScore(a);
          }
        }
      });
    }

    return items;
  }, [fallbackToLocal, enrichedServerItems, fallbackItems, search, activeField, activeSection, activeEntity, activeRiskCat, hasDataOnly, sortKey, viewMode, SECTION_GROUPS]);

  const totalCount = (fallbackToLocal || hasDataOnly) ? displayedItems.length : serverTotal;
  const hasMore = fallbackToLocal
    ? displayedItems.length > visibleCount
    : serverItems.length < serverTotal;
  const remaining = fallbackToLocal
    ? displayedItems.length - visibleCount
    : serverTotal - serverItems.length;

  return (
    <div>
      {/* Search + filters — constrained width */}
      <div className="max-w-7xl mx-auto px-6">
        {/* Search */}
        <div className="mb-4">
          <input
            type="text"
            placeholder="Search entities..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full px-4 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Filter rows */}
        <div className="mb-4">
          <FilterRow
            label="Field"
            options={FIELD_GROUPS.map((g) => g.label)}
            active={activeField}
            onSelect={handleFieldChange}
            counts={fieldCounts}
          />
          <FilterRow
            label="Section"
            options={SECTION_GROUPS.map((g) => g.label)}
            active={activeSection}
            onSelect={handleSectionChange}
            counts={sectionCounts}
          />
          <FilterRow
            label="Entity"
            options={ENTITY_GROUPS.map((g) => g.label)}
            active={activeEntity}
            onSelect={handleEntityChange}
            counts={entityCounts}
          />
          {showRiskCatFilter && (
            <FilterRow
              label="Risk"
              options={RISK_CATEGORY_GROUPS.map((g) => g.label)}
              active={activeRiskCat}
              onSelect={handleRiskCatChange}
              counts={riskCatCounts}
            />
          )}
        </div>

        {/* Results header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {totalCount} items
              {isLoading && <span className="ml-2 opacity-60">Loading...</span>}
            </span>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hasDataOnly}
                onChange={(e) => {
                  setHasDataOnly(e.target.checked);
                  setVisibleCount(60);
                  updateUrlParams({ hasData: e.target.checked ? "1" : null });
                }}
                className="rounded border-border"
              />
              Has structured data
            </label>
          </div>
          <div className="flex items-center gap-3">
            {/* View toggle */}
            <div className="flex items-center border border-border rounded-md overflow-hidden">
              <button
                onClick={() => handleViewChange("cards")}
                className={`px-2.5 py-1.5 text-sm transition-colors ${
                  viewMode === "cards"
                    ? "bg-foreground text-background"
                    : "bg-background text-foreground hover:bg-muted"
                }`}
                title="Card view"
                aria-label="Card view"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
              </button>
              <button
                onClick={() => handleViewChange("table")}
                className={`px-2.5 py-1.5 text-sm transition-colors ${
                  viewMode === "table"
                    ? "bg-foreground text-background"
                    : "bg-background text-foreground hover:bg-muted"
                }`}
                title="Table view"
                aria-label="Table view"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18" />
                  <path d="M3 15h18" />
                  <path d="M9 3v18" />
                </svg>
              </button>
            </div>
            {/* Sort dropdown — only in card mode; table has its own column sorting */}
            {viewMode === "cards" && (
              <select
                value={sortKey}
                onChange={(e) => handleSortChange(e.target.value as SortKey)}
                className="text-sm px-3 py-1.5 border border-border rounded-md bg-background text-foreground"
              >
                <option value="recommended">Recommended</option>
                <option value="recentlyEdited">Recently Edited</option>
                <option value="recentlyCreated">Recently Created</option>
                <option value="quality">Quality</option>
                <option value="readerImportance">Reader Importance</option>
                <option value="researchImportance">Research Importance</option>
                <option value="tacticalValue">Tactical Value</option>
                <option value="relevance">Relevance</option>
                <option value="kbFacts">KB Facts</option>
                <option value="wordCount">Word Count</option>
                <option value="title">Title (A-Z)</option>
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Card grid — constrained width */}
      {viewMode === "cards" && (
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {(fallbackToLocal
              ? displayedItems.slice(0, visibleCount)
              : displayedItems
            ).map((item) => (
              <ContentCard key={item.id} item={item} />
            ))}
          </div>

          {hasMore && remaining > 0 && (
            <div className="flex justify-center mt-6">
              <button
                onClick={loadMore}
                disabled={isLoading}
                className="px-6 py-2.5 text-sm border border-border rounded-lg bg-background text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              >
                {isLoading ? "Loading..." : `Show more (${remaining} remaining)`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Table view — full page width */}
      {viewMode === "table" && (
        <div className="px-6">
          <ExploreTable
            items={fallbackToLocal ? displayedItems : enrichedServerItems}
            onSearchChange={handleSearchChange}
          />
          {!fallbackToLocal && hasMore && (
            <div className="flex justify-center mt-4 mb-6">
              <button
                onClick={loadMore}
                disabled={isLoading}
                className="px-6 py-2.5 text-sm border border-border rounded-lg bg-background text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              >
                {isLoading ? "Loading..." : `Load more for table (${remaining} remaining)`}
              </button>
            </div>
          )}
        </div>
      )}

      {displayedItems.length === 0 && !isLoading && (
        <div className="text-center py-12 text-muted-foreground">
          No entities found matching your criteria.
        </div>
      )}
    </div>
  );
}
