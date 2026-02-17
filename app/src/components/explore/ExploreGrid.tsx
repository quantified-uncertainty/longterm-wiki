"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import type { ExploreItem } from "@/data";
import { ENTITY_GROUPS } from "@/data/entity-ontology";
import { searchWikiScores } from "@/lib/search";
import { ContentCard } from "./ContentCard";
import { ExploreTable } from "./ExploreTable";

type ViewMode = "cards" | "table";

// FIELD filter — based on page clusters
const FIELD_GROUPS: { label: string; cluster: string | null }[] = [
  { label: "All", cluster: null },
  { label: "AI Safety", cluster: "ai-safety" },
  { label: "Governance", cluster: "governance" },
  { label: "Epistemics", cluster: "epistemics" },
  { label: "Community", cluster: "community" },
  { label: "Cyber", cluster: "cyber" },
  { label: "Biorisks", cluster: "biorisks" },
];

// RISK CATEGORY filter
const RISK_CATEGORY_GROUPS: { label: string; value: string | null }[] = [
  { label: "All Risks", value: null },
  { label: "Accident", value: "accident" },
  { label: "Misuse", value: "misuse" },
  { label: "Structural", value: "structural" },
  { label: "Epistemic", value: "epistemic" },
];

type SortKey = "recommended" | "relevance" | "title" | "readerImportance" | "quality" | "wordCount" | "recentlyEdited";

/** Compute a blended "recommended" score that favors recent, high-quality content. */
function recommendedScore(item: ExploreItem): number {
  // Recency: exponential decay with ~120-day half-life (0-10 scale)
  let recency = 0;
  if (item.lastUpdated) {
    const daysAgo = (Date.now() - new Date(item.lastUpdated).getTime()) / 86_400_000;
    recency = 10 * Math.exp(-daysAgo / 120);
  }
  const quality = item.quality || 0;
  const importance = item.readerImportance || 0;
  // Small bonus for substantive content (log-scaled, capped)
  const wordBonus = item.wordCount ? Math.min(2, Math.log10(item.wordCount + 1) - 1.5) : 0;

  return recency * 2 + quality * 2 + importance * 0.5 + wordBonus;
}

/**
 * Resolve a URL param value (e.g. "organizations", "organization", "People")
 * to the matching ENTITY_GROUPS index. Returns 0 (All) if no match.
 */
function resolveEntityGroupIndex(param: string): number {
  const lower = param.toLowerCase();

  // Direct label match (e.g. "risks" -> "Risks", "people" -> "People")
  let idx = ENTITY_GROUPS.findIndex((g) => g.label.toLowerCase() === lower);
  if (idx >= 0) return idx;

  // Entity type match (e.g. "organization" found in group types)
  idx = ENTITY_GROUPS.findIndex((g) => g.types.includes(lower));
  if (idx >= 0) return idx;

  // Singularize path-based categories (e.g. "organizations" -> "organization")
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

/** Simple text-based filter used as a fallback before MiniSearch loads. */
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

export function ExploreGrid({ items }: { items: ExploreItem[] }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Read initial state from URL params
  const initialTag = searchParams.get("tag") || "";
  const initialEntity = searchParams.get("entity") || "";
  const initialRiskCat = searchParams.get("riskCategory") || null;
  const initialRiskCatIndex = initialRiskCat
    ? Math.max(0, RISK_CATEGORY_GROUPS.findIndex((g) => g.value === initialRiskCat))
    : 0;
  const initialEntityIndex = initialEntity ? resolveEntityGroupIndex(initialEntity) : 0;

  const initialView = (searchParams.get("view") as ViewMode) || "cards";

  const [viewMode, setViewMode] = useState<ViewMode>(initialView);
  const [search, setSearch] = useState(initialTag);
  const [activeField, setActiveField] = useState(0);
  const [activeEntity, setActiveEntity] = useState(
    initialRiskCat ? 1 : initialEntityIndex
  );
  const [activeRiskCat, setActiveRiskCat] = useState(initialRiskCatIndex);
  const [sortKey, setSortKey] = useState<SortKey>("recommended");
  const [visibleCount, setVisibleCount] = useState(60);

  // MiniSearch scores: id → relevance score (null = no active search or not yet loaded)
  const [searchScores, setSearchScores] = useState<Map<string, number> | null>(null);

  // Debounced URL update for search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Debounced MiniSearch query
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  // Run MiniSearch when search text changes
  useEffect(() => {
    const query = search.trim();
    if (!query) {
      setSearchScores(null);
      return;
    }

    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      let cancelled = false;
      searchWikiScores(query)
        .then((scores) => {
          if (!cancelled) setSearchScores(scores);
        })
        .catch(() => {
          // MiniSearch failed to load — keep null so fallback text filter is used
        });
      // Store cancel function for cleanup
      searchDebounceRef.current = null;
    }, 150);

    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [search]);

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

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setVisibleCount(60);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      updateUrlParams({ tag: value || null });
    }, 300);
  }, [updateUrlParams]);

  function handleFieldChange(index: number) {
    setActiveField(index);
    setVisibleCount(60);
  }

  function handleEntityChange(index: number) {
    setActiveEntity(index);
    setVisibleCount(60);
  }

  function handleRiskCatChange(index: number) {
    setActiveRiskCat(index);
    setVisibleCount(60);
    const value = RISK_CATEGORY_GROUPS[index].value;
    updateUrlParams({ riskCategory: value });
  }

  function handleViewChange(mode: ViewMode) {
    setViewMode(mode);
    updateUrlParams({ view: mode === "cards" ? null : mode });
  }

  // Filter out AI transition model subitems (internal model data, not articles)
  const articleItems = useMemo(
    () => items.filter((item) => !item.type.startsWith("ai-transition-model")),
    [items]
  );

  // Items after search filter (MiniSearch when available, text fallback otherwise)
  const searchFiltered = useMemo(() => {
    if (!search.trim()) return articleItems;

    if (searchScores && searchScores.size > 0) {
      return articleItems.filter((item) => searchScores.has(item.id));
    }

    // Fallback: simple text filter while MiniSearch is loading or unavailable
    return textFilter(articleItems, search);
  }, [articleItems, search, searchScores]);

  // Compute field filter counts (against search-filtered items)
  const fieldCounts = useMemo(() => {
    return FIELD_GROUPS.map((group) => {
      if (!group.cluster) return searchFiltered.length;
      return searchFiltered.filter((item) => item.clusters.includes(group.cluster!)).length;
    });
  }, [searchFiltered]);

  // Items after search + field filter
  const fieldFiltered = useMemo(() => {
    const group = FIELD_GROUPS[activeField];
    if (!group.cluster) return searchFiltered;
    return searchFiltered.filter((item) => item.clusters.includes(group.cluster!));
  }, [searchFiltered, activeField]);

  // Compute entity type counts (against search + field-filtered items)
  const entityCounts = useMemo(() => {
    return ENTITY_GROUPS.map((group) => {
      if (group.types.length === 0) return fieldFiltered.length;
      return fieldFiltered.filter((item) => group.types.includes(item.type)).length;
    });
  }, [fieldFiltered]);

  // Show risk category filter only when viewing Risks
  const showRiskCatFilter = activeEntity === 1;

  // Compute risk category counts (against search + field-filtered risk items)
  const riskCatCounts = useMemo(() => {
    const riskItems = fieldFiltered.filter((item) => item.type === "risk");
    return RISK_CATEGORY_GROUPS.map((group) => {
      if (!group.value) return riskItems.length;
      return riskItems.filter((item) => item.riskCategory === group.value).length;
    });
  }, [fieldFiltered]);

  const filtered = useMemo(() => {
    let result = fieldFiltered;

    // Entity type filter
    const group = ENTITY_GROUPS[activeEntity];
    if (group.types.length > 0) {
      result = result.filter((item) => group.types.includes(item.type));
    }

    // Risk category filter
    const riskCatGroup = RISK_CATEGORY_GROUPS[activeRiskCat];
    if (riskCatGroup.value) {
      result = result.filter((item) => item.riskCategory === riskCatGroup.value);
    }

    // Sort — skip in table mode since TanStack handles its own column sorting
    if (viewMode !== "table") {
      result = [...result].sort((a, b) => {
        switch (sortKey) {
          case "title":
            return a.title.localeCompare(b.title);
          case "readerImportance":
            return (b.readerImportance || 0) - (a.readerImportance || 0);
          case "quality":
            return (b.quality || 0) - (a.quality || 0);
          case "wordCount":
            return (b.wordCount || 0) - (a.wordCount || 0);
          case "recentlyEdited":
            return (b.lastUpdated || "").localeCompare(a.lastUpdated || "");
          case "relevance": {
            if (searchScores) {
              const scoreA = searchScores.get(a.id) || 0;
              const scoreB = searchScores.get(b.id) || 0;
              return scoreB - scoreA;
            }
            const scoreA = (a.readerImportance || 0) * 2 + (a.quality || 0);
            const scoreB = (b.readerImportance || 0) * 2 + (b.quality || 0);
            return scoreB - scoreA;
          }
          case "recommended":
          default: {
            if (searchScores) {
              const scoreA = searchScores.get(a.id) || 0;
              const scoreB = searchScores.get(b.id) || 0;
              return scoreB - scoreA;
            }
            return recommendedScore(b) - recommendedScore(a);
          }
        }
      });
    }

    return result;
  }, [fieldFiltered, activeEntity, activeRiskCat, searchScores, sortKey, viewMode]);

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
          <span className="text-sm text-muted-foreground">{filtered.length} items</span>
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
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="text-sm px-3 py-1.5 border border-border rounded-md bg-background text-foreground"
              >
                <option value="recommended">Recommended</option>
                <option value="recentlyEdited">Recently Edited</option>
                <option value="quality">Quality</option>
                <option value="readerImportance">Importance</option>
                <option value="relevance">Relevance</option>
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
            {filtered.slice(0, visibleCount).map((item) =>
              <ContentCard key={item.id} item={item} />
            )}
          </div>

          {filtered.length > visibleCount && (
            <div className="flex justify-center mt-6">
              <button
                onClick={() => setVisibleCount((c) => c + 60)}
                className="px-6 py-2.5 text-sm border border-border rounded-lg bg-background text-foreground hover:bg-muted transition-colors"
              >
                Show more ({filtered.length - visibleCount} remaining)
              </button>
            </div>
          )}
        </div>
      )}

      {/* Table view — full page width */}
      {viewMode === "table" && (
        <div className="px-6">
          <ExploreTable items={filtered} onSearchChange={handleSearchChange} />
        </div>
      )}

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No entities found matching your criteria.
        </div>
      )}
    </div>
  );
}
