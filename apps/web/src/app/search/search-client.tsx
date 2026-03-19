"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { searchWiki, searchThings, type SearchResult, type ThingSearchResult } from "@lib/search";

// ── Type config ──────────────────────────────────────────────────────

const TYPE_META: Record<string, { label: string; short: string; icon: string }> = {
  page: { label: "Wiki Page", short: "Page", icon: "W" },
  grant: { label: "Grant", short: "Grant", icon: "G" },
  "funding-round": { label: "Funding Round", short: "Round", icon: "F" },
  "funding-program": { label: "Funding Program", short: "Program", icon: "P" },
  division: { label: "Division", short: "Div", icon: "D" },
  benchmark: { label: "Benchmark", short: "Bench", icon: "B" },
  resource: { label: "Resource", short: "Res", icon: "R" },
  "research-area": { label: "Research Area", short: "RA", icon: "A" },
};

// ── Filters ──────────────────────────────────────────────────────────

type FilterKey = "all" | "page" | "grant" | "funding-round" | "funding-program" | "division" | "benchmark" | "resource" | "research-area";

const FILTER_DEFS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "page", label: "Pages" },
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
}

function fromPage(r: SearchResult): UnifiedResult {
  return {
    key: `p:${r.id}`,
    title: r.title,
    context: r.type || null,
    type: "page",
    href: `/wiki/${r.wikiId}`,
    description: r.description || null,
    snippet: r.snippet,
    source: "page",
    score: r.score,
    quality: r.quality,
  };
}

function fromThing(r: ThingSearchResult): UnifiedResult {
  return {
    key: `t:${r.id}`,
    title: r.title,
    context: r.parentTitle || null,
    type: r.thingType,
    href: r.href,
    description: r.description || null,
    source: "thing",
    score: 0, // things don't expose score yet
    quality: null,
  };
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
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const searchSeqRef = useRef(0);
  const filterRef = useRef<FilterKey>(initialFilter);

  // Keep filterRef in sync with state so debounce callbacks read the latest value
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

    // Discard stale response if a newer search was started
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

    setResults([
      ...pageResults.map(fromPage),
      ...dedupedThings.map(fromThing),
    ]);
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
    if (filter !== "all") {
      items = items.filter((r) => r.type === filter);
    }

    if (sort === "alpha") {
      items = [...items].sort((a, b) => a.title.localeCompare(b.title));
    } else if (sort === "type") {
      items = [...items].sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));
    }
    // "relevance" keeps server order

    return items;
  }, [results, filter, sort]);

  // ── Type counts for filter badges ──────────────────────────────────

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of results) {
      counts[r.type] = (counts[r.type] ?? 0) + 1;
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

  // Scroll selected into view
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
          Wiki pages, grants, funding rounds, divisions, benchmarks, and more
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

          {/* Sort toggle */}
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
          className="divide-y divide-border/60"
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
  const meta = TYPE_META[r.type];
  const label = meta?.short ?? r.type;
  const icon = meta?.icon ?? r.type[0]?.toUpperCase() ?? "?";

  const content = (
    <div
      id={id}
      role="option"
      aria-selected={isSelected}
      onMouseEnter={onHover}
      className={`flex items-start gap-3.5 py-3.5 px-2 -mx-2 rounded-lg transition-colors ${
        isSelected ? "bg-muted/60" : "hover:bg-muted/30"
      }`}
    >
      {/* Type indicator */}
      <div
        className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-bold mt-0.5 transition-colors ${
          isSelected
            ? "bg-foreground/10 text-foreground"
            : "bg-muted/60 text-muted-foreground/60"
        }`}
        title={meta?.label ?? r.type}
      >
        {icon}
      </div>

      <div className="min-w-0 flex-1">
        {/* Title + type label */}
        <div className="flex items-baseline gap-2">
          <span className={`font-semibold text-[15px] leading-snug transition-colors ${
            isSelected ? "text-primary" : "text-foreground"
          }`}>
            <Highlight text={r.title} query={query} />
          </span>
          <span className="text-[10px] font-medium text-muted-foreground/40 uppercase tracking-wider shrink-0">
            {label}
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

/** Strip all HTML tags except <mark> and </mark> to prevent XSS from ts_headline output. */
function sanitizeSnippet(html: string): string {
  return html.replace(/<(?!\/?mark\b)[^>]*>/gi, "");
}

// ── Highlight ────────────────────────────────────────────────────────

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!escaped) return <>{text}</>;

  // Split with a capturing group puts matches at odd indices (1, 3, 5, ...)
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
