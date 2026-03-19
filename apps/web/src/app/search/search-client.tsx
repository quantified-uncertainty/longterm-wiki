"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { searchWiki, searchThings, type SearchResult, type ThingSearchResult } from "@lib/search";

// ── Type config ──────────────────────────────────────────────────────

const THING_TYPES: Record<string, { label: string; shortLabel: string; icon: string }> = {
  page: { label: "Wiki Page", shortLabel: "Page", icon: "P" },
  grant: { label: "Grant", shortLabel: "Grant", icon: "G" },
  "funding-round": { label: "Funding Round", shortLabel: "Round", icon: "F" },
  "funding-program": { label: "Funding Program", shortLabel: "Program", icon: "P" },
  division: { label: "Division", shortLabel: "Div", icon: "D" },
  benchmark: { label: "Benchmark", shortLabel: "Bench", icon: "B" },
  resource: { label: "Resource", shortLabel: "Res", icon: "R" },
  "research-area": { label: "Research Area", shortLabel: "RA", icon: "R" },
};

// ── Filter config ────────────────────────────────────────────────────

type FilterKey = "all" | "pages" | "data";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All results" },
  { key: "pages", label: "Wiki pages" },
  { key: "data", label: "Data records" },
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
  };
}

// ── Component ────────────────────────────────────────────────────────

export function SearchPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<UnifiedResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const performSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }

    setLoading(true);
    setSearched(true);

    const [pageResults, thingResults] = await Promise.all([
      searchWiki(q, 30),
      searchThings(q, 50),
    ]);

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
  }, []);

  useEffect(() => {
    if (initialQuery) performSearch(initialQuery);
    inputRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleInput = useCallback((value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const path = value.trim() ? `/search?q=${encodeURIComponent(value)}` : "/search";
      router.replace(path, { scroll: false });
      performSearch(value);
    }, 250);
  }, [performSearch, router]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const path = query.trim() ? `/search?q=${encodeURIComponent(query)}` : "/search";
    router.replace(path, { scroll: false });
    performSearch(query);
  }, [query, performSearch, router]);

  const filtered = useMemo(() => {
    if (filter === "all") return results;
    if (filter === "pages") return results.filter((r) => r.source === "page");
    return results.filter((r) => r.source === "thing");
  }, [results, filter]);

  const pageCt = results.filter((r) => r.source === "page").length;
  const dataCt = results.filter((r) => r.source === "thing").length;

  const showEmpty = searched && !loading && filtered.length === 0;
  const hasQuery = query.trim().length > 0;

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
      <form onSubmit={handleSubmit} className="relative mb-6 group">
        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/40 group-focus-within:text-foreground/50 transition-colors">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          placeholder="Search everything..."
          className="w-full pl-12 pr-4 py-3.5 rounded-xl border border-border bg-card text-foreground text-[15px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-transparent transition-all shadow-sm"
          autoComplete="off"
          spellCheck={false}
        />
        {loading && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 border-2 border-muted-foreground/20 border-t-foreground/60 rounded-full animate-spin" />
          </div>
        )}
      </form>

      {/* Filter + count bar */}
      {searched && results.length > 0 && (
        <div className="flex items-center justify-between mb-5">
          <div className="flex gap-1">
            {FILTERS.map((f) => {
              const ct = f.key === "all" ? results.length : f.key === "pages" ? pageCt : dataCt;
              if (f.key !== "all" && ct === 0) return null;
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                    filter === f.key
                      ? "bg-foreground text-background shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  }`}
                >
                  {f.label}
                  <span className={`ml-1.5 tabular-nums ${filter === f.key ? "opacity-70" : "opacity-50"}`}>
                    {ct}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!hasQuery && !searched && (
        <div className="text-center py-16">
          <div className="text-muted-foreground/20 mb-4">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </div>
          <p className="text-sm text-muted-foreground/50">
            Search across the entire knowledge base
          </p>
        </div>
      )}

      {showEmpty && (
        <div className="text-center py-16">
          <p className="text-sm text-muted-foreground">
            No results for &ldquo;<span className="font-medium text-foreground">{query}</span>&rdquo;
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Try broader terms or check spelling
          </p>
        </div>
      )}

      {/* Results */}
      {filtered.length > 0 && (
        <div className="divide-y divide-border/60">
          {filtered.map((r) => (
            <ResultRow key={r.key} result={r} query={query} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Result row ───────────────────────────────────────────────────────

function ResultRow({ result: r, query }: { result: UnifiedResult; query: string }) {
  const typeInfo = THING_TYPES[r.type];
  const label = typeInfo?.shortLabel ?? r.type;
  const icon = typeInfo?.icon ?? r.type[0]?.toUpperCase() ?? "?";

  const content = (
    <div className="flex items-start gap-3.5 py-3.5 group">
      {/* Type indicator */}
      <div
        className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-bold mt-0.5 bg-muted/60 text-muted-foreground/70 group-hover:bg-muted group-hover:text-foreground transition-colors"
        title={typeInfo?.label ?? r.type}
      >
        {icon}
      </div>

      <div className="min-w-0 flex-1">
        {/* Title row */}
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-[15px] text-foreground group-hover:text-primary transition-colors leading-snug">
            <Highlight text={r.title} query={query} />
          </span>
          <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider shrink-0">
            {label}
          </span>
        </div>

        {/* Context / parent */}
        {r.context && (
          <div className="text-xs text-muted-foreground/60 mt-0.5">
            <Highlight text={r.context} query={query} />
          </div>
        )}

        {/* Snippet or description */}
        {r.snippet ? (
          <p
            className="text-[13px] text-muted-foreground leading-relaxed mt-1 line-clamp-2 [&_mark]:bg-yellow-200/50 [&_mark]:dark:bg-yellow-500/20 [&_mark]:rounded-sm"
            dangerouslySetInnerHTML={{ __html: r.snippet }}
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
        regex.test(part) ? (
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
