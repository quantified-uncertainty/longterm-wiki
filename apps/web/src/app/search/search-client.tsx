"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { searchWiki, searchThings, type SearchResult, type ThingSearchResult } from "@lib/search";

// ── Thing type display config ────────────────────────────────────────

const THING_TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  entity: { label: "Entity", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
  grant: { label: "Grant", color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
  "funding-round": { label: "Funding Round", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
  "funding-program": { label: "Funding Program", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300" },
  division: { label: "Division", color: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300" },
  benchmark: { label: "Benchmark", color: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" },
  resource: { label: "Resource", color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300" },
  "research-area": { label: "Research Area", color: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300" },
};

function ThingTypeBadge({ thingType }: { thingType: string }) {
  const config = THING_TYPE_CONFIG[thingType] ?? { label: thingType, color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300" };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${config.color}`}>
      {config.label}
    </span>
  );
}

// ── Filter tabs ──────────────────────────────────────────────────────

type FilterTab = "all" | "pages" | "grants" | "funding-round" | "division" | "benchmark" | "resource";

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pages", label: "Pages" },
  { key: "grants", label: "Grants" },
  { key: "funding-round", label: "Funding" },
  { key: "division", label: "Divisions" },
  { key: "benchmark", label: "Benchmarks" },
  { key: "resource", label: "Resources" },
];

// ── Unified result type ──────────────────────────────────────────────

interface UnifiedResult {
  key: string;
  title: string;
  subtitle: string | null;
  badge: string;
  href: string | null;
  description: string | null;
  snippet?: string;
  source: "page" | "thing";
}

function pageResultToUnified(r: SearchResult): UnifiedResult {
  return {
    key: `page-${r.id}`,
    title: r.title,
    subtitle: r.type || null,
    badge: "page",
    href: `/wiki/${r.wikiId}`,
    description: r.description || null,
    snippet: r.snippet,
    source: "page",
  };
}

function thingResultToUnified(r: ThingSearchResult): UnifiedResult {
  return {
    key: `thing-${r.id}`,
    title: r.title,
    subtitle: r.parentTitle || null,
    badge: r.thingType,
    href: r.href,
    description: r.description || null,
    source: "thing",
  };
}

// ── Main component ───────────────────────────────────────────────────

export function SearchPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<UnifiedResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [searched, setSearched] = useState(false);
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

    // Deduplicate: if a thing is also a wiki page (matching wikiId), prefer the page result
    const pageWikiIds = new Set(pageResults.map((r) => r.wikiId).filter(Boolean));
    const dedupedThings = thingResults.filter((t) => {
      // Skip entities that already appear as pages
      if (t.thingType === "entity" && t.wikiId && pageWikiIds.has(t.wikiId)) return false;
      // Skip things without href (join-table records)
      if (!t.href) return false;
      return true;
    });

    const unified: UnifiedResult[] = [
      ...pageResults.map(pageResultToUnified),
      ...dedupedThings.map(thingResultToUnified),
    ];

    setResults(unified);
    setLoading(false);
  }, []);

  // Search on initial load if ?q= is present
  useEffect(() => {
    if (initialQuery) {
      performSearch(initialQuery);
    }
    // Focus input on mount
    inputRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search + URL update
  const handleInputChange = useCallback((value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (value.trim()) {
        router.replace(`/search?q=${encodeURIComponent(value)}`, { scroll: false });
      } else {
        router.replace("/search", { scroll: false });
      }
      performSearch(value);
    }, 250);
  }, [performSearch, router]);

  // Filter results
  const filtered = activeFilter === "all"
    ? results
    : activeFilter === "pages"
      ? results.filter((r) => r.source === "page")
      : results.filter((r) => r.source === "thing" && r.badge === activeFilter);

  // Count per filter
  const counts: Record<FilterTab, number> = {
    all: results.length,
    pages: results.filter((r) => r.source === "page").length,
    grants: results.filter((r) => r.badge === "grant").length,
    "funding-round": results.filter((r) => r.badge === "funding-round").length,
    division: results.filter((r) => r.badge === "division").length,
    benchmark: results.filter((r) => r.badge === "benchmark").length,
    resource: results.filter((r) => r.badge === "resource").length,
  };

  return (
    <div>
      {/* Search input */}
      <div className="relative mb-4">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          placeholder="Search pages, grants, funding rounds, benchmarks..."
          className="w-full px-4 py-3 rounded-xl border border-border bg-background text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
          autoComplete="off"
          spellCheck={false}
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Filter tabs */}
      {searched && results.length > 0 && (
        <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1">
          {FILTER_TABS.map((tab) => {
            const c = counts[tab.key];
            if (tab.key !== "all" && c === 0) return null;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveFilter(tab.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  activeFilter === tab.key
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted"
                }`}
              >
                {tab.label}
                {c > 0 && <span className="ml-1 opacity-70">{c}</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Results */}
      {searched && !loading && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No results found for &ldquo;{query}&rdquo;
        </p>
      )}

      <div className="space-y-1">
        {filtered.map((r) => (
          <SearchResultRow key={r.key} result={r} query={query} />
        ))}
      </div>
    </div>
  );
}

// ── Result row ───────────────────────────────────────────────────────

function SearchResultRow({ result: r, query }: { result: UnifiedResult; query: string }) {
  const inner = (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/40 transition-colors group">
      <div className="shrink-0 mt-0.5">
        <ThingTypeBadge thingType={r.badge} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm text-foreground group-hover:text-primary transition-colors">
          <HighlightText text={r.title} query={query} />
        </div>
        {r.subtitle && (
          <div className="text-[11px] text-muted-foreground/70 mt-0.5">
            <HighlightText text={r.subtitle} query={query} />
          </div>
        )}
        {r.snippet ? (
          <p
            className="text-xs text-muted-foreground mt-0.5 line-clamp-2 [&_mark]:bg-yellow-200/60 [&_mark]:dark:bg-yellow-500/30 [&_mark]:rounded-sm"
            dangerouslySetInnerHTML={{ __html: r.snippet }}
          />
        ) : r.description ? (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            <HighlightText text={r.description} query={query} />
          </p>
        ) : null}
      </div>
    </div>
  );

  if (r.href) {
    // External URLs (resources) open in new tab
    if (r.href.startsWith("http")) {
      return (
        <a href={r.href} target="_blank" rel="noopener noreferrer">
          {inner}
        </a>
      );
    }
    return <Link href={r.href}>{inner}</Link>;
  }

  return inner;
}

// ── Text highlighting ────────────────────────────────────────────────

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!pattern) return <>{text}</>;

  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-yellow-200/60 dark:bg-yellow-500/30 rounded-sm">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
