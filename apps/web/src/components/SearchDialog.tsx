"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  searchWiki,
  searchThings,
  type SearchResult,
  type ThingSearchResult,
  type MatchInfo,
} from "@lib/search";
import { ENTITY_TYPES, ENTITY_GROUPS } from "@data/entity-ontology";
import { stripMdxEscapes } from "@lib/inline-markdown";
import { sanitizeRawLargeNumbers } from "@lib/format-compact";

// ---------------------------------------------------------------------------
// Directory route mapping — entity types with dedicated directory pages
// get directory URLs instead of /wiki/E<id>. Must stay in sync with
// ENTITY_TYPE_ROUTE in thing-sync.ts.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sort types
// ---------------------------------------------------------------------------

type SortKey = "relevance" | "quality" | "recent";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "relevance", label: "Relevance" },
  { key: "quality", label: "Quality" },
  { key: "recent", label: "Recent" },
];

// ---------------------------------------------------------------------------
// Subset of ENTITY_GROUPS for the compact search dialog chip row.
// We skip "Tables", "Diagrams", "Insights" to keep it compact — those
// are rare filter targets in the search context.
// ---------------------------------------------------------------------------

const SEARCH_FILTER_GROUPS = ENTITY_GROUPS.filter(
  (g) => !["Tables", "Diagrams", "Insights", "Internal"].includes(g.label)
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fetch more results to allow post-filtering to work. */
const UNFILTERED_LIMIT = 30;

/**
 * Cmd+K search dialog with live results (server-side PostgreSQL FTS
 * with prefix matching and typo tolerance), faceted entity-type filtering,
 * highlighted snippets, and sort toggle.
 */
export function SearchDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [allResults, setAllResults] = useState<SearchResult[]>([]);
  const [thingResults, setThingResults] = useState<ThingSearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pendingQuery, setPendingQuery] = useState(false);
  const [activeGroup, setActiveGroup] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("relevance");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const chipRowRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Open/close with Cmd+K / Ctrl+K
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Focus input and lock body scroll when dialog opens; reset state on close
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      document.body.style.overflow = "hidden";
    } else {
      setQuery("");
      setAllResults([]);
      setThingResults([]);
      setSelected(0);
      setPendingQuery(false);
      setActiveGroup(0);
      setSortKey("relevance");
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // Debounced search — fetch more results so post-filtering still has depth
  useEffect(() => {
    if (!query.trim()) {
      setAllResults([]);
      setThingResults([]);
      setSelected(0);
      setPendingQuery(false);
      return;
    }

    let cancelled = false;
    setPendingQuery(true);
    const timer = setTimeout(async () => {
      setLoading(true);
      setPendingQuery(false);
      try {
        const [wikiR, thingsR] = await Promise.all([
          searchWiki(query, UNFILTERED_LIMIT),
          searchThings(query, 10),
        ]);
        if (cancelled) return;
        // Filter out internal pages from search results
        const filteredWiki = wikiR.filter(
          (r) => r.type !== "internal" && !r.id.startsWith("internal/"),
        );
        setAllResults(filteredWiki);
        const pageWikiIds = new Set(wikiR.map((r) => r.wikiId).filter(Boolean));
        const deduped = thingsR.filter(
          (t) => t.href && !(t.thingType === "entity" && t.wikiId && pageWikiIds.has(t.wikiId)),
        );
        setThingResults(deduped);
        setSelected(0);
      } catch {
        if (!cancelled) {
          setAllResults([]);
          setThingResults([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  // ---- Phase 1: Entity type filtering ----

  const group = SEARCH_FILTER_GROUPS[activeGroup];
  const hasTypeFilter = group && group.types.length > 0;

  /** Count how many results match each entity group. */
  const groupCounts = useMemo(() => {
    return SEARCH_FILTER_GROUPS.map((g) => {
      if (g.types.length === 0) return allResults.length;
      return allResults.filter((r) => g.types.includes(r.type)).length;
    });
  }, [allResults]);

  /** Post-filter by selected entity group. */
  const filteredResults = useMemo(() => {
    if (!hasTypeFilter) return allResults;
    return allResults.filter((r) => group.types.includes(r.type));
  }, [allResults, group, hasTypeFilter]);

  // ---- Phase 3: Sort toggle ----

  const results = useMemo(() => {
    if (sortKey === "relevance") return filteredResults;
    const sorted = [...filteredResults];
    if (sortKey === "quality") {
      sorted.sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
    }
    // "recent" — not available in SearchDoc, fall back to importance as proxy
    // (actual lastUpdated would need index schema change; importance is a
    // reasonable heuristic for now since important pages tend to be maintained)
    if (sortKey === "recent") {
      sorted.sort((a, b) => (b.readerImportance ?? 0) - (a.readerImportance ?? 0));
    }
    return sorted;
  }, [filteredResults, sortKey]);

  // ---- Navigation ----

  const navigate = useCallback(
    (result: SearchResult) => {
      setOpen(false);
      router.push(pageHref(result));
    },
    [router],
  );

  const navigateThing = useCallback(
    (result: ThingSearchResult) => {
      if (!result.href) return;
      setOpen(false);
      if (result.href.startsWith("http")) {
        window.open(result.href, "_blank");
      } else {
        router.push(result.href);
      }
    },
    [router],
  );

  /** Only show things when no entity-type filter is active (filter = "All"). */
  const visibleThings = hasTypeFilter ? [] : thingResults;

  /** Total navigable items (wiki + things) for keyboard nav. */
  const totalItems = results.length + visibleThings.length;

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.querySelector('[aria-selected="true"]') as HTMLElement | null;
    item?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Reset selection when filtered results change
  useEffect(() => {
    setSelected(0);
  }, [activeGroup, sortKey]);

  // Keyboard navigation
  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, totalItems - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selected < results.length && results[selected]) {
        navigate(results[selected]);
      } else {
        const thingIdx = selected - results.length;
        const thing = visibleThings[thingIdx];
        if (thing?.href) navigateThing(thing);
      }
    }
  }

  // Focus trap: cycle focus within the dialog on Tab / Shift+Tab
  const dialogRef = useRef<HTMLDivElement>(null);
  const handleDialogKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
      'input, button, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  if (!open) return null;

  const showChips = allResults.length > 0;
  const showResults = results.length > 0 || visibleThings.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search wiki"
        className="relative w-full max-w-lg mx-4 bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <SearchIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            aria-label="Search"
            placeholder="Search pages, grants, funding..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-muted-foreground bg-muted rounded border border-border font-mono">
            ESC
          </kbd>
        </div>

        {/* Phase 1: Filter chips */}
        {showChips && (
          <div
            ref={chipRowRef}
            className="flex items-center gap-1.5 px-4 py-2 border-b border-border overflow-x-auto scrollbar-none"
            role="tablist"
            aria-label="Filter by type"
          >
            {SEARCH_FILTER_GROUPS.map((g, i) => {
              const count = groupCounts[i];
              const isActive = i === activeGroup;
              return (
                <button
                  key={g.label}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setActiveGroup(i)}
                  className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md whitespace-nowrap transition-colors ${
                    isActive
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground hover:bg-muted/80"
                  } ${count === 0 && !isActive ? "opacity-40" : ""}`}
                >
                  {g.label}
                  <span
                    className={`text-[10px] ${
                      isActive
                        ? "text-background/70"
                        : "text-muted-foreground/60"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Results */}
        <div className="max-h-[50vh] overflow-y-auto">
          {(loading || pendingQuery) && allResults.length === 0 && (
            <div className="px-4 py-6 text-sm text-muted-foreground text-center">
              Searching...
            </div>
          )}

          {!loading &&
            !pendingQuery &&
            query.trim() &&
            allResults.length === 0 &&
            visibleThings.length === 0 && (
              <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                No results for &ldquo;{query}&rdquo;
              </div>
            )}

          {/* Filtered results exist but current filter yields nothing */}
          {!loading &&
            !pendingQuery &&
            allResults.length > 0 &&
            results.length === 0 && (
              <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                No {group?.label.toLowerCase()} matching &ldquo;{query}&rdquo;
              </div>
            )}

          {showResults && (
            <ul ref={listRef} className="py-1" role="listbox">
              {results.map((r, i) => (
                <li key={r.id} role="option" aria-selected={i === selected}>
                  <button
                    className={`w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors ${
                      i === selected ? "bg-muted" : "hover:bg-muted/50"
                    }`}
                    onClick={() => navigate(r)}
                    onMouseEnter={() => setSelected(i)}
                  >
                    <TypeBadge type={r.type} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground truncate">
                        {r.title}
                      </div>
                      {/* Phase 2: Highlighted snippet */}
                      <HighlightedSnippet result={r} />
                    </div>
                  </button>
                </li>
              ))}
              {visibleThings.length > 0 && results.length > 0 && (
                <li className="px-4 py-1.5 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
                  Data Records
                </li>
              )}
              {visibleThings.map((t, i) => {
                const idx = results.length + i;
                return (
                  <li key={`thing-${t.id}`} role="option" aria-selected={idx === selected}>
                    <button
                      className={`w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors ${
                        idx === selected ? "bg-muted" : "hover:bg-muted/50"
                      }`}
                      onClick={() => navigateThing(t)}
                      onMouseEnter={() => setSelected(idx)}
                    >
                      <ThingBadge thingType={t.thingType} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground truncate">
                          {t.title}
                        </div>
                        {t.parentTitle && (
                          <div className="text-[11px] text-muted-foreground/70 truncate">
                            {t.parentTitle}
                          </div>
                        )}
                        {t.description && (
                          <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                            {sanitizeRawLargeNumbers(t.description)}
                          </div>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {!query.trim() && (
            <div className="px-4 py-6 text-sm text-muted-foreground text-center">
              Type to search across pages, grants, funding rounds, and more
            </div>
          )}
        </div>

        {/* Footer with keyboard shortcuts and sort toggle */}
        {showResults && (
          <div className="flex items-center justify-between px-4 py-2 border-t border-border text-[10px] text-muted-foreground">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-muted rounded border border-border font-mono">
                  ↑↓
                </kbd>
                Navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-muted rounded border border-border font-mono">
                  ↵
                </kbd>
                Open
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-muted rounded border border-border font-mono">
                  ESC
                </kbd>
                Close
              </span>
            </div>
            {/* Phase 3: Sort toggle */}
            <div className="flex items-center gap-1">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setSortKey(opt.key)}
                  className={`px-1.5 py-0.5 rounded transition-colors ${
                    sortKey === opt.key
                      ? "bg-muted font-semibold text-foreground"
                      : "hover:bg-muted/50"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 2: Highlighted snippet component
// ---------------------------------------------------------------------------

/**
 * Sanitize a server-generated snippet: strip all HTML except bare <mark>
 * and </mark> (no attributes). Tags are stripped to a fixed point because
 * removing one tag can splice fragments into a fresh tag, so a single pass
 * can be bypassed.
 */
export function sanitizeSnippet(snippet: string): string {
  let safe = snippet
    .replace(/<mark\b[^>]*>/gi, "<mark>")
    .replace(/<\/mark\s*>/gi, "</mark>");
  let prevSafe: string;
  do {
    prevSafe = safe;
    safe = safe.replace(/<(?!\/?mark>)[^>]*>/gi, "");
  } while (safe !== prevSafe);
  return safe;
}

/**
 * Renders a description snippet with highlighted matching terms.
 * Prefers server-generated ts_headline() snippets (HTML with <mark> tags)
 * when available, falling back to client-side term highlighting.
 */
function HighlightedSnippet({ result }: { result: SearchResult }) {
  const { description: rawDescription, match, terms, snippet } = result;
  const description = rawDescription
    ? sanitizeRawLargeNumbers(stripMdxEscapes(rawDescription))
    : rawDescription;

  // Prefer server-generated snippet with <mark> tags from ts_headline()
  if (snippet && snippet.includes("<mark>")) {
    const safe = sanitizeSnippet(snippet);
    return (
      <div
        className="text-xs text-muted-foreground line-clamp-2 mt-0.5 [&_mark]:bg-yellow-200/70 dark:[&_mark]:bg-yellow-500/30 [&_mark]:text-foreground [&_mark]:rounded-sm [&_mark]:px-0.5"
        dangerouslySetInnerHTML={{ __html: safe }}
      />
    );
  }

  if (!description) return null;

  // Collect terms that matched in the description field
  const descTerms = getDescriptionTerms(match, terms);

  // If no terms matched in description (match was in title/tags/etc),
  // show plain description truncated to 2 lines
  if (descTerms.length === 0) {
    return (
      <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
        {description}
      </div>
    );
  }

  // Build highlighted fragments
  const fragments = highlightText(description, descTerms);

  return (
    <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
      {fragments.map((frag, i) =>
        frag.highlight ? (
          <mark
            key={i}
            className="bg-yellow-200/70 dark:bg-yellow-500/30 text-foreground rounded-sm px-0.5"
          >
            {frag.text}
          </mark>
        ) : (
          <span key={i}>{frag.text}</span>
        ),
      )}
    </div>
  );
}

/** Extract the query terms that matched in the description or summary field. */
function getDescriptionTerms(
  match: MatchInfo | undefined,
  terms: string[],
): string[] {
  if (!match) return [];
  const descTerms: string[] = [];
  for (const [term, fields] of Object.entries(match)) {
    if (fields.includes("description") || fields.includes("summary")) {
      descTerms.push(term);
    }
  }
  return descTerms;
}

interface TextFragment {
  text: string;
  highlight: boolean;
}

/**
 * Split text into fragments, highlighting substrings that match
 * any of the given terms (case-insensitive substring matching).
 * Used as a fallback when server-side ts_headline snippets are unavailable.
 */
function highlightText(text: string, terms: string[]): TextFragment[] {
  if (terms.length === 0) return [{ text, highlight: false }];

  // Build a regex that matches any of the terms as word-prefix substrings
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");

  const fragments: TextFragment[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > lastIndex) {
      fragments.push({ text: text.slice(lastIndex, m.index), highlight: false });
    }
    fragments.push({ text: m[0], highlight: true });
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    fragments.push({ text: text.slice(lastIndex), highlight: false });
  }

  return fragments.length > 0 ? fragments : [{ text, highlight: false }];
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

/**
 * Compact search trigger button for the header.
 */
export function SearchButton() {
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true }),
        );
      }}
      className="flex items-center gap-2 px-2.5 py-1.5 text-sm text-muted-foreground bg-muted/50 border border-border rounded-md hover:bg-muted transition-colors cursor-pointer"
      title="Search (Cmd+K)"
    >
      <SearchIcon className="w-3.5 h-3.5" />
      <span className="hidden sm:inline text-xs">Search</span>
      <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1 py-0.5 text-[10px] bg-background rounded border border-border font-mono ml-1">
        ⌘K
      </kbd>
    </button>
  );
}

// Simple inline SVG icons to avoid importing lucide-react in the client bundle just for search

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function TypeBadge({ type }: { type: string }) {
  const def = ENTITY_TYPES[type];
  const label = def?.label ?? type;
  const color = def?.badgeColor ?? "bg-gray-100 text-gray-800";

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded flex-shrink-0 mt-0.5 ${color}`}
    >
      {label}
    </span>
  );
}

const THING_TYPE_BADGES: Record<string, { label: string; color: string }> = {
  grant: { label: "Grant", color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
  "funding-round": { label: "Round", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
  "funding-program": { label: "Program", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300" },
  division: { label: "Division", color: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300" },
  benchmark: { label: "Benchmark", color: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" },
  resource: { label: "Resource", color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300" },
  "research-area": { label: "Research", color: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300" },
};

function ThingBadge({ thingType }: { thingType: string }) {
  const cfg = THING_TYPE_BADGES[thingType] ?? { label: thingType, color: "bg-gray-100 text-gray-600" };
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded flex-shrink-0 mt-0.5 ${cfg.color}`}
    >
      {cfg.label}
    </span>
  );
}
