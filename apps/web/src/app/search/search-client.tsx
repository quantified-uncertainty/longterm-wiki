"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { searchWiki, searchThings, type SearchResult, type ThingSearchResult } from "@lib/search";

// ── Type styling ─────────────────────────────────────────────────────
// Colors drawn from entity-ontology.ts badge palette for consistency.

interface TypeStyle {
  label: string;
  short: string;
  /** Tailwind classes for the colored badge */
  badge: string;
  /** Tailwind classes for the left accent border */
  accent: string;
}

const TYPE_STYLES: Record<string, TypeStyle> = {
  // Wiki articles (non-directory entity types)
  wiki: {
    label: "Wiki Article",
    short: "Wiki",
    badge: "bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-400",
    accent: "border-l-slate-300 dark:border-l-slate-600",
  },
  // Directory entity types
  organization: {
    label: "Organization",
    short: "Org",
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    accent: "border-l-amber-400 dark:border-l-amber-500",
  },
  person: {
    label: "Person",
    short: "Person",
    badge: "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
    accent: "border-l-sky-400 dark:border-l-sky-500",
  },
  "ai-model": {
    label: "AI Model",
    short: "Model",
    badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    accent: "border-l-blue-400 dark:border-l-blue-500",
  },
  policy: {
    label: "Legislation",
    short: "Law",
    badge: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    accent: "border-l-purple-400 dark:border-l-purple-500",
  },
  project: {
    label: "Project",
    short: "Project",
    badge: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
    accent: "border-l-teal-400 dark:border-l-teal-500",
  },
  approach: {
    label: "Approach",
    short: "Approach",
    badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    accent: "border-l-emerald-400 dark:border-l-emerald-500",
  },
  event: {
    label: "Event",
    short: "Event",
    badge: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
    accent: "border-l-rose-400 dark:border-l-rose-500",
  },
  benchmark: {
    label: "Benchmark",
    short: "Bench",
    badge: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
    accent: "border-l-indigo-400 dark:border-l-indigo-500",
  },
  "research-area": {
    label: "Research Area",
    short: "Research",
    badge: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
    accent: "border-l-cyan-400 dark:border-l-cyan-500",
  },
  // Things (data records)
  grant: {
    label: "Grant",
    short: "Grant",
    badge: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    accent: "border-l-green-300 dark:border-l-green-600",
  },
  "funding-round": {
    label: "Funding Round",
    short: "Funding",
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    accent: "border-l-emerald-300 dark:border-l-emerald-600",
  },
  "funding-program": {
    label: "Funding Program",
    short: "Program",
    badge: "bg-lime-100 text-lime-800 dark:bg-lime-900/30 dark:text-lime-300",
    accent: "border-l-lime-300 dark:border-l-lime-600",
  },
  division: {
    label: "Division",
    short: "Division",
    badge: "bg-stone-100 text-stone-700 dark:bg-stone-800/40 dark:text-stone-300",
    accent: "border-l-stone-300 dark:border-l-stone-600",
  },
  resource: {
    label: "Resource",
    short: "Resource",
    badge: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
    accent: "border-l-orange-300 dark:border-l-orange-600",
  },
};

const FALLBACK_STYLE: TypeStyle = {
  label: "Item",
  short: "Item",
  badge: "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400",
  accent: "border-l-gray-300 dark:border-l-gray-600",
};

// ── Filters ──────────────────────────────────────────────────────────

type FilterKey = "all" | "wiki" | "grant" | "funding-round" | "funding-program" | "division" | "benchmark" | "resource" | "research-area";

const FILTER_DEFS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "wiki", label: "Wiki" },
  { key: "grant", label: "Grants" },
  { key: "funding-round", label: "Funding" },
  { key: "benchmark", label: "Benchmarks" },
  { key: "division", label: "Divisions" },
  { key: "resource", label: "Resources" },
  { key: "research-area", label: "Research" },
  { key: "funding-program", label: "Programs" },
];

// ── Sort ─────────────────────────────────────────────────────────────

type SortKey = "relevance" | "alpha" | "type";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "relevance", label: "Relevance" },
  { key: "alpha", label: "A\u2013Z" },
  { key: "type", label: "By type" },
];

// ── Directory route mapping ───────────────────────────────────────────
// Entity types with dedicated directory pages get directory URLs instead
// of /wiki/E<id>. Must stay in sync with ENTITY_TYPE_ROUTE in thing-sync.ts.

const DIRECTORY_ROUTES: Record<string, string> = {
  organization: "/organizations",
  person: "/people",
  "ai-model": "/ai-models",
  benchmark: "/benchmarks",
  policy: "/legislation",
  project: "/projects",
  approach: "/approaches",
  event: "/events",
  "research-area": "/research-areas",
};

/** Compute the best href for a page search result. */
function pageHref(r: SearchResult): string {
  const prefix = DIRECTORY_ROUTES[r.type];
  if (prefix) return `${prefix}/${r.id}`;
  return `/wiki/${r.wikiId}`;
}

// ── Unified result ───────────────────────────────────────────────────

interface UnifiedResult {
  key: string;
  title: string;
  context: string | null;
  type: string;
  href: string | null;
  description: string | null;
  snippet?: string;
  source: "page" | "thing";
  score: number;
  quality: number | null;
  readerImportance: number | null;
  isInternal: boolean;
}

function fromPage(r: SearchResult): UnifiedResult {
  const isDirectory = !!DIRECTORY_ROUTES[r.type];
  const type = isDirectory ? r.type : "wiki";
  const context = isDirectory ? null : (r.type || null);
  const isInternal = r.type === "internal" || r.id.startsWith("internal/");
  return {
    key: `p:${r.id}`,
    title: r.title,
    context,
    type,
    href: pageHref(r),
    description: r.description || null,
    snippet: r.snippet,
    source: "page",
    score: r.score,
    quality: r.quality,
    readerImportance: r.readerImportance,
    isInternal,
  };
}

function fromThing(r: ThingSearchResult): UnifiedResult {
  const type = r.thingType === "entity" && r.entityType && DIRECTORY_ROUTES[r.entityType]
    ? r.entityType
    : r.thingType;
  return {
    key: `t:${r.id}`,
    title: r.title,
    context: r.parentTitle || null,
    type,
    href: r.href,
    description: r.description || null,
    source: "thing",
    score: 0,
    quality: null,
    readerImportance: null,
    isInternal: false,
  };
}

/**
 * Compute a blended relevance score that factors in reader importance.
 * FTS score is the primary signal, but reader importance breaks ties
 * and boosts genuinely important results above similarly-scored ones.
 */
function blendedScore(r: UnifiedResult): number {
  // Normalize importance to 0-1 range (max observed is ~55)
  const importance = (r.readerImportance ?? 0) / 60;
  // FTS score already ranges from ~0.01 to ~1000+
  // Add a fraction of importance to break ties among similar scores
  return r.score + importance * 10;
}

// ── Component ────────────────────────────────────────────────────────

export function SearchPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  const initialFilter = (searchParams.get("filter") ?? "all") as FilterKey;

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<UnifiedResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [errored, setErrored] = useState(false);
  const [filter, setFilter] = useState<FilterKey>(initialFilter);
  const [sort, setSort] = useState<SortKey>("relevance");
  const [selected, setSelected] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchSeqRef = useRef(0);
  const filterRef = useRef<FilterKey>(initialFilter);

  filterRef.current = filter;

  // ── Search ─────────────────────────────────────────────────────────

  const performSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      setErrored(false);
      return;
    }

    const seq = ++searchSeqRef.current;
    setLoading(true);
    setSearched(true);
    setErrored(false);

    const [pageResults, thingResults] = await Promise.all([
      searchWiki(q, 40),
      searchThings(q, 60),
    ]);

    if (seq !== searchSeqRef.current) return;

    if (pageResults.length === 0 && thingResults.length === 0 && q.trim().length > 2) {
      setErrored(true);
    }

    const pageWikiIds = new Set(pageResults.map((r) => r.wikiId).filter(Boolean));
    const dedupedThings = thingResults.filter((t) => {
      if (t.thingType === "entity" && t.wikiId && pageWikiIds.has(t.wikiId)) return false;
      if (!t.href) return false;
      return true;
    });

    // Build unified results, filter out internal pages, then sort by blended score
    const unified = [
      ...pageResults.map(fromPage),
      ...dedupedThings.map(fromThing),
    ].filter((r) => !r.isInternal);

    // Re-sort by blended score (FTS rank + importance)
    unified.sort((a, b) => blendedScore(b) - blendedScore(a));

    setResults(unified);
    setLoading(false);
    setSelected(-1);
  }, []);

  useEffect(() => {
    if (initialQuery) performSearch(initialQuery);
    inputRef.current?.focus();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── URL sync ───────────────────────────────────────────────────────

  const syncUrl = useCallback((q: string, f: FilterKey) => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q);
    if (f !== "all") params.set("filter", f);
    const path = params.toString() ? `/search?${params}` : "/search";
    router.replace(path, { scroll: false });
  }, [router]);

  const handleInput = useCallback((value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      syncUrl(value, filterRef.current);
      performSearch(value);
    }, 200);
  }, [performSearch, syncUrl]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    syncUrl(query, filter);
    performSearch(query);
  }, [query, filter, performSearch, syncUrl]);

  const handleFilterChange = useCallback((f: FilterKey) => {
    setFilter(f);
    setSelected(-1);
    if (searched) syncUrl(query, f);
  }, [searched, query, syncUrl]);

  // ── Filter + sort ──────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let items = results;
    if (filter === "wiki") {
      items = items.filter((r) => r.source === "page");
    } else if (filter !== "all") {
      items = items.filter((r) => r.type === filter);
    }

    if (sort === "alpha") {
      items = [...items].sort((a, b) => a.title.localeCompare(b.title));
    } else if (sort === "type") {
      items = [...items].sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));
    }

    return items;
  }, [results, filter, sort]);

  // ── Type counts for filter badges ──────────────────────────────────

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of results) {
      counts[r.type] = (counts[r.type] ?? 0) + 1;
      // Count all page-sourced results under "wiki" filter, but avoid
      // double-counting results that already have type === "wiki"
      if (r.source === "page" && r.type !== "wiki") {
        counts["wiki"] = (counts["wiki"] ?? 0) + 1;
      }
    }
    return counts;
  }, [results]);

  // ── Keyboard nav ───────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => {
        const next = Math.max(s - 1, -1);
        if (next === -1) inputRef.current?.focus();
        return next;
      });
    } else if (e.key === "Enter" && selected >= 0 && filtered[selected]?.href) {
      e.preventDefault();
      const r = filtered[selected];
      if (r.href!.startsWith("http")) {
        window.open(r.href!, "_blank");
      } else {
        router.push(r.href!);
      }
    }
  }, [selected, filtered, router]);

  useEffect(() => {
    if (selected < 0 || !listRef.current) return;
    const el = listRef.current.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // ── Render ─────────────────────────────────────────────────────────

  const hasQuery = query.trim().length > 0;
  const showEmpty = searched && !loading && filtered.length === 0;

  return (
    <div className="max-w-3xl mx-auto px-6 pt-10 pb-16">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground">
          Search
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Wiki pages, organizations, people, grants, and more
        </p>
      </div>

      {/* Search bar */}
      <form onSubmit={handleSubmit} className="relative mb-5 group">
        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/40 group-focus-within:text-foreground/50 transition-colors">
          <SearchIcon size={18} />
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search everything..."
          className="w-full pl-12 pr-4 py-3.5 rounded-xl border border-border bg-card text-foreground text-[15px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-transparent transition-all shadow-sm"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={filtered.length > 0}
          aria-controls="search-results"
          aria-activedescendant={selected >= 0 ? `result-${selected}` : undefined}
        />
        {loading && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 border-2 border-muted-foreground/20 border-t-foreground/60 rounded-full animate-spin" />
          </div>
        )}
      </form>

      {/* Filter chips + sort */}
      {searched && results.length > 0 && (
        <div className="flex items-center justify-between gap-3 mb-5">
          <div className="flex gap-1 overflow-x-auto scrollbar-none pb-0.5" role="tablist" aria-label="Filter by type">
            {FILTER_DEFS.map((f) => {
              const ct = f.key === "all" ? results.length : (typeCounts[f.key] ?? 0);
              if (f.key !== "all" && ct === 0) return null;
              return (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={filter === f.key}
                  onClick={() => handleFilterChange(f.key)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-all ${
                    filter === f.key
                      ? "bg-foreground text-background shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  }`}
                >
                  {f.label}
                  <span className={`ml-1 tabular-nums ${filter === f.key ? "opacity-70" : "opacity-40"}`}>
                    {ct}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                onClick={() => { setSort(opt.key); setSelected(-1); }}
                className={`px-2 py-1 text-[11px] font-medium rounded transition-colors ${
                  sort === opt.key
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground/50 hover:text-muted-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Result count */}
      {searched && !loading && filtered.length > 0 && (
        <div className="text-[11px] text-muted-foreground/50 mb-3 tabular-nums">
          {filtered.length === results.length
            ? `${results.length} result${results.length !== 1 ? "s" : ""}`
            : `${filtered.length} of ${results.length} results`}
        </div>
      )}

      {/* Pre-search empty state */}
      {!hasQuery && !searched && (
        <div className="text-center py-16">
          <div className="text-muted-foreground/20 mb-4">
            <SearchIcon size={48} className="mx-auto" />
          </div>
          <p className="text-sm text-muted-foreground/50">
            Search across the entire knowledge base
          </p>
          <p className="text-xs text-muted-foreground/30 mt-2">
            Try &ldquo;Anthropic&rdquo;, &ldquo;MIRI grant&rdquo;, or &ldquo;MMLU&rdquo;
          </p>
        </div>
      )}

      {/* No results / error */}
      {showEmpty && (
        <div className="text-center py-16">
          {errored ? (
            <>
              <p className="text-sm text-muted-foreground">
                Search may be temporarily unavailable
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Try again in a moment, or browse the{" "}
                <Link href="/wiki" className="text-primary hover:underline">wiki</Link>,{" "}
                <Link href="/grants" className="text-primary hover:underline">grants</Link>, or{" "}
                <Link href="/organizations" className="text-primary hover:underline">organizations</Link>
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                No results for &ldquo;<span className="font-medium text-foreground">{query}</span>&rdquo;
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Try broader terms or check spelling
              </p>
            </>
          )}
        </div>
      )}

      {/* Results list */}
      {filtered.length > 0 && (
        <div
          ref={listRef}
          id="search-results"
          role="listbox"
          aria-label="Search results"
          className="space-y-1"
          onKeyDown={handleKeyDown}
        >
          {filtered.map((r, i) => (
            <ResultRow
              key={r.key}
              id={`result-${i}`}
              result={r}
              query={query}
              isSelected={i === selected}
              onHover={() => setSelected(i)}
            />
          ))}
        </div>
      )}

      {/* Keyboard hint */}
      {filtered.length > 0 && (
        <div className="flex items-center gap-4 mt-4 text-[10px] text-muted-foreground/40">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-muted/50 rounded border border-border/50 font-mono">↑↓</kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-muted/50 rounded border border-border/50 font-mono">↵</kbd>
            Open
          </span>
        </div>
      )}
    </div>
  );
}

// ── Result row ───────────────────────────────────────────────────────

function ResultRow({
  result: r,
  query,
  isSelected,
  onHover,
  id,
}: {
  result: UnifiedResult;
  query: string;
  isSelected: boolean;
  onHover: () => void;
  id: string;
}) {
  const style = TYPE_STYLES[r.type] ?? FALLBACK_STYLE;

  const content = (
    <div
      id={id}
      role="option"
      aria-selected={isSelected}
      onMouseEnter={onHover}
      className={`border-l-[3px] rounded-r-lg py-3 pl-4 pr-3 transition-colors ${style.accent} ${
        isSelected ? "bg-muted/60" : "hover:bg-muted/30"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* Title + type badge */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-semibold text-[15px] leading-snug transition-colors ${
              isSelected ? "text-primary" : "text-foreground"
            }`}>
              <Highlight text={r.title} query={query} />
            </span>
            <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded ${style.badge}`}>
              {style.short}
            </span>
          </div>

          {/* Context / parent */}
          {r.context && (
            <div className="text-xs text-muted-foreground/55 mt-0.5">
              <Highlight text={r.context} query={query} />
            </div>
          )}

          {/* Snippet or description */}
          {r.snippet ? (
            <p
              className="text-[13px] text-muted-foreground leading-relaxed mt-1 line-clamp-2 [&_mark]:bg-yellow-200/50 [&_mark]:dark:bg-yellow-500/20 [&_mark]:rounded-sm"
              dangerouslySetInnerHTML={{ __html: sanitizeSnippet(r.snippet) }}
            />
          ) : r.description ? (
            <p className="text-[13px] text-muted-foreground leading-relaxed mt-1 line-clamp-2">
              <Highlight text={r.description} query={query} />
            </p>
          ) : null}
        </div>

        {/* External link indicator */}
        {r.href?.startsWith("http") && (
          <span className="shrink-0 mt-1 text-muted-foreground/30" title="Opens in new tab">
            <ExternalIcon />
          </span>
        )}
      </div>
    </div>
  );

  if (!r.href) return content;

  if (r.href.startsWith("http")) {
    return (
      <a href={r.href} target="_blank" rel="noopener noreferrer" className="block">
        {content}
      </a>
    );
  }

  return <Link href={r.href} className="block">{content}</Link>;
}

// ── Sanitize ─────────────────────────────────────────────────────────

function sanitizeSnippet(html: string): string {
  return html.replace(/<(?!\/?mark\b)[^>]*>/gi, "");
}

// ── Highlight ────────────────────────────────────────────────────────

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!escaped) return <>{text}</>;

  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-yellow-200/50 dark:bg-yellow-500/20 rounded-sm text-inherit">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

// ── Icons ────────────────────────────────────────────────────────────

function SearchIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
