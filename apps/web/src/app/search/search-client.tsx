"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { searchWiki, searchThings, type SearchResult, type ThingSearchResult } from "@lib/search";
import {
  FileText,
  Building2,
  User,
  Cpu,
  Scale,
  Package,
  Compass,
  Calendar,
  Gauge,
  Microscope,
  Banknote,
  TrendingUp,
  Wallet,
  GitBranch,
  BookOpen,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { CoverageDots } from "@/components/coverage/CoverageDots";

// ── Browse data (passed from server component) ──────────────────────

interface BrowseItem {
  id: string;
  wikiId: string;
  title: string;
  type: string;
  href: string;
  wordCount?: number | null;
  kbFactCount: number;
  kbItemCount: number;
}

export interface BrowseData {
  directories: { type: string; label: string; href: string; count: number }[];
  featured: (BrowseItem & { description: string | null; readerImportance: number | null })[];
  recent: (BrowseItem & { lastUpdated: string | null })[];
  totalPages: number;
}

// ── Type styling ─────────────────────────────────────────────────────
// Badge colors from entity-ontology.ts for cross-site consistency.

interface TypeStyle {
  label: string;
  short: string;
  icon: LucideIcon;
  badge: string;
  iconColor: string;
}

const TYPE_STYLES: Record<string, TypeStyle> = {
  wiki:             { label: "Wiki Article",   short: "Wiki",     icon: FileText,   badge: "bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-400",         iconColor: "text-slate-400 dark:text-slate-500" },
  organization:     { label: "Organization",   short: "Org",      icon: Building2,  badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",         iconColor: "text-amber-500 dark:text-amber-400" },
  person:           { label: "Person",         short: "Person",   icon: User,       badge: "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",                 iconColor: "text-sky-500 dark:text-sky-400" },
  "ai-model":       { label: "AI Model",       short: "Model",    icon: Cpu,        badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",             iconColor: "text-blue-500 dark:text-blue-400" },
  policy:           { label: "Legislation",    short: "Law",      icon: Scale,      badge: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",     iconColor: "text-purple-500 dark:text-purple-400" },
  project:          { label: "Project",        short: "Project",  icon: Package,    badge: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",             iconColor: "text-teal-500 dark:text-teal-400" },
  approach:         { label: "Approach",       short: "Approach", icon: Compass,    badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300", iconColor: "text-emerald-500 dark:text-emerald-400" },
  event:            { label: "Event",          short: "Event",    icon: Calendar,   badge: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",             iconColor: "text-rose-500 dark:text-rose-400" },
  benchmark:        { label: "Benchmark",      short: "Bench",    icon: Gauge,      badge: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",     iconColor: "text-indigo-500 dark:text-indigo-400" },
  "research-area":  { label: "Research Area",  short: "Research", icon: Microscope, badge: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",             iconColor: "text-cyan-500 dark:text-cyan-400" },
  grant:            { label: "Grant",          short: "Grant",    icon: Banknote,   badge: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",         iconColor: "text-green-500 dark:text-green-400" },
  "funding-round":  { label: "Funding Round",  short: "Funding",  icon: TrendingUp, badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300", iconColor: "text-emerald-500 dark:text-emerald-400" },
  "funding-program":{ label: "Funding Program",short: "Program",  icon: Wallet,     badge: "bg-lime-100 text-lime-800 dark:bg-lime-900/30 dark:text-lime-300",             iconColor: "text-lime-500 dark:text-lime-400" },
  division:         { label: "Division",       short: "Division", icon: GitBranch,  badge: "bg-stone-100 text-stone-700 dark:bg-stone-800/40 dark:text-stone-300",         iconColor: "text-stone-400 dark:text-stone-500" },
  resource:         { label: "Resource",       short: "Resource", icon: BookOpen,   badge: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",     iconColor: "text-orange-500 dark:text-orange-400" },
};

const FALLBACK_STYLE: TypeStyle = {
  label: "Item", short: "Item", icon: FileText,
  badge: "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400",
  iconColor: "text-gray-400 dark:text-gray-500",
};

// ── Directory route mapping ──────────────────────────────────────────

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

function pageHref(r: SearchResult): string {
  const prefix = DIRECTORY_ROUTES[r.type];
  if (prefix) return `${prefix}/${r.id}`;
  return `/wiki/${r.wikiId}`;
}

// ── Unified result ───────────────────────────────────────────────────

type ResultColumn = "entities" | "wiki" | "resources";

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
  column: ResultColumn;
}

function classifyColumn(type: string, source: "page" | "thing"): ResultColumn {
  if (DIRECTORY_ROUTES[type]) return "entities";
  if (type === "resource") return "resources";
  if (source === "thing") return "entities";
  return "wiki";
}

function fromPage(r: SearchResult): UnifiedResult[] {
  const isDirectory = !!DIRECTORY_ROUTES[r.type];
  const type = isDirectory ? r.type : "wiki";
  const context = isDirectory ? null : (r.type || null);
  const isInternal = r.type === "internal" || r.id.startsWith("internal/");
  const column = classifyColumn(type, "page");

  const results: UnifiedResult[] = [{
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
    column,
  }];

  if (isDirectory && r.wikiId) {
    results.push({
      key: `pw:${r.id}`,
      title: r.title,
      context: r.type || null,
      type: "wiki",
      href: `/wiki/${r.wikiId}`,
      description: r.description || null,
      snippet: r.snippet,
      source: "page",
      score: r.score * 0.8,
      quality: r.quality,
      readerImportance: r.readerImportance,
      isInternal,
      column: "wiki",
    });
  }

  return results;
}

function fromThing(r: ThingSearchResult): UnifiedResult {
  const type = r.thingType === "entity" && r.entityType && DIRECTORY_ROUTES[r.entityType]
    ? r.entityType
    : r.thingType;
  const column = classifyColumn(type, "thing");
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
    column,
  };
}

/**
 * Compute a blended relevance score.
 * - FTS score is the primary signal
 * - Title match boosts results whose title IS or closely matches the query
 * - Reader importance breaks ties among similarly-scored results
 */
function blendedScore(r: UnifiedResult, query: string): number {
  const q = query.trim().toLowerCase();
  const title = r.title.toLowerCase();
  const importance = (r.readerImportance ?? 0) / 60;

  let titleBoost = 0;
  if (title === q) {
    // Exact title match (e.g. "MIRI" → "MIRI")
    titleBoost = 500;
  } else if (title.startsWith(q + " ") || title.startsWith(q + ":")) {
    // Title starts with query
    titleBoost = 200;
  } else if (title.includes(`(${q})`) || title.includes(` ${q} `) || title.endsWith(` ${q}`)) {
    // Query appears as a distinct word/acronym in title
    titleBoost = 100;
  }

  return r.score + titleBoost + importance * 10;
}

/** Decode HTML entities from server-generated snippets. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    // Decode &amp; LAST so inputs like &amp;lt; round-trip to the literal
    // &lt; instead of being double-unescaped to <.
    .replace(/&amp;/g, "&");
}

// ── Component ────────────────────────────────────────────────────────

export function SearchPageClient({ browseData, coverageMap }: { browseData: BrowseData; coverageMap?: Record<string, number> }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<UnifiedResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [errored, setErrored] = useState(false);
  const [selected, setSelected] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchSeqRef = useRef(0);

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

    let pageResults: SearchResult[] = [];
    let thingResults: ThingSearchResult[] = [];
    try {
      [pageResults, thingResults] = await Promise.all([
        searchWiki(q, 40),
        searchThings(q, 60),
      ]);
    } catch {
      if (seq === searchSeqRef.current) {
        setErrored(true);
        setLoading(false);
      }
      return;
    }

    if (seq !== searchSeqRef.current) return;

    const pageWikiIds = new Set(pageResults.map((r) => r.wikiId).filter(Boolean));
    const dedupedThings = thingResults.filter((t) => {
      if (t.thingType === "entity" && t.wikiId && pageWikiIds.has(t.wikiId)) return false;
      if (!t.href) return false;
      return true;
    });

    const unified = [
      ...pageResults.flatMap(fromPage),
      ...dedupedThings.map(fromThing),
    ].filter((r) => !r.isInternal);

    unified.sort((a, b) => blendedScore(b, q) - blendedScore(a, q));

    setResults(unified);
    setLoading(false);
    setSelected(-1);
  }, []);

  useEffect(() => {
    if (initialQuery) void performSearch(initialQuery);
    inputRef.current?.focus();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── URL sync ───────────────────────────────────────────────────────

  const syncUrl = useCallback((q: string) => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q);
    const path = params.toString() ? `/search?${params}` : "/search";
    router.replace(path, { scroll: false });
  }, [router]);

  const handleInput = useCallback((value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      syncUrl(value);
      void performSearch(value);
    }, 200);
  }, [performSearch, syncUrl]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    syncUrl(query);
    void performSearch(query);
  }, [query, performSearch, syncUrl]);

  // ── Split into columns ─────────────────────────────────────────────

  const columns = useMemo(() => {
    const entities: UnifiedResult[] = [];
    const wiki: UnifiedResult[] = [];
    const resources: UnifiedResult[] = [];
    for (const r of results) {
      if (r.column === "entities") entities.push(r);
      else if (r.column === "wiki") wiki.push(r);
      else resources.push(r);
    }
    return { entities, wiki, resources };
  }, [results]);

  // Flat list for keyboard nav (entities → wiki → resources)
  const flatResults = useMemo(() => [
    ...columns.entities, ...columns.wiki, ...columns.resources,
  ], [columns]);

  const totalCount = results.length;
  const hasResults = totalCount > 0;
  const hasQuery = query.trim().length > 0;
  const showEmpty = searched && !loading && !hasResults;

  // Only render columns that have results
  const visibleColumns = useMemo(() => {
    const cols: { key: ResultColumn; title: string; icon: LucideIcon; items: UnifiedResult[]; showBadges: boolean }[] = [];
    if (columns.entities.length > 0) cols.push({ key: "entities", title: "Entities", icon: Building2, items: columns.entities, showBadges: true });
    if (columns.wiki.length > 0) cols.push({ key: "wiki", title: "Wiki", icon: FileText, items: columns.wiki, showBadges: false });
    if (columns.resources.length > 0) cols.push({ key: "resources", title: "Resources", icon: ExternalLink, items: columns.resources, showBadges: false });
    return cols;
  }, [columns]);

  // ── Keyboard nav ───────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, flatResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => {
        const next = Math.max(s - 1, -1);
        if (next === -1) inputRef.current?.focus();
        return next;
      });
    } else if (e.key === "Enter" && selected >= 0 && flatResults[selected]?.href) {
      e.preventDefault();
      const r = flatResults[selected];
      if (r.href!.startsWith("http")) {
        window.open(r.href!, "_blank");
      } else {
        router.push(r.href!);
      }
    }
  }, [selected, flatResults, router]);

  // Scroll selected into view
  useEffect(() => {
    if (selected < 0) return;
    const el = document.getElementById(`sr-${flatResults[selected]?.key}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected, flatResults]);

  return (
    <div className="max-w-7xl mx-auto px-6 pt-10 pb-16">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Search
        </h1>
      </div>

      {/* Search bar */}
      <form onSubmit={handleSubmit} role="search" className="relative mb-6 group max-w-2xl">
        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/40 group-focus-within:text-foreground/50 transition-colors">
          <SearchIcon size={16} />
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Search entities, articles, resources"
          placeholder="Search entities, articles, resources..."
          className="w-full pl-11 pr-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-transparent transition-all"
          autoComplete="off"
          spellCheck={false}
        />
        {loading && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2" role="status">
            <div className="h-4 w-4 border-2 border-muted-foreground/20 border-t-foreground/60 rounded-full animate-spin" />
            <span className="sr-only">Loading search results</span>
          </div>
        )}
      </form>

      {/* Browse state — shown when no query */}
      {!hasQuery && !searched && (
        <BrowseState data={browseData} />
      )}

      {/* Error / empty */}
      {showEmpty && (
        <div className="py-16 max-w-md">
          {errored ? (
            <>
              <p className="text-sm text-muted-foreground">Search unavailable</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Browse the{" "}
                <Link href="/wiki" className="underline hover:text-foreground">wiki</Link>,{" "}
                <Link href="/grants" className="underline hover:text-foreground">grants</Link>, or{" "}
                <Link href="/organizations" className="underline hover:text-foreground">organizations</Link>
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No results for &ldquo;<span className="font-medium text-foreground">{query}</span>&rdquo;
            </p>
          )}
        </div>
      )}

      {/* Result count */}
      {searched && !loading && hasResults && (
        <p className="text-xs text-muted-foreground/40 mb-4 tabular-nums" aria-live="polite">
          {totalCount} result{totalCount !== 1 ? "s" : ""}
        </p>
      )}

      {/* Results grid — responsive: stack on mobile, columns on desktop */}
      {hasResults && (
        <div className={`grid gap-8 grid-cols-1 ${
          visibleColumns.length === 1 ? "md:grid-cols-1" :
          visibleColumns.length === 2 ? "md:grid-cols-2" :
          "md:grid-cols-2 lg:grid-cols-3"
        }`}>
          {visibleColumns.map((col) => (
            <ResultColumnView
              key={col.key}
              title={col.title}
              icon={col.icon}
              items={col.items}
              query={query}
              showBadges={col.showBadges}
              selectedKey={selected >= 0 ? flatResults[selected]?.key : null}
              coverageMap={coverageMap}
            />
          ))}
        </div>
      )}

      {/* Keyboard hint */}
      {hasResults && (
        <div className="flex items-center gap-4 mt-6 text-[10px] text-muted-foreground/30">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-muted/40 rounded border border-border/40 font-mono">↑↓</kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-muted/40 rounded border border-border/40 font-mono">↵</kbd>
            Open
          </span>
        </div>
      )}
    </div>
  );
}

// ── Column ───────────────────────────────────────────────────────────

function ResultColumnView({
  title,
  icon: Icon,
  items,
  query,
  showBadges,
  selectedKey,
  coverageMap,
}: {
  title: string;
  icon: LucideIcon;
  items: UnifiedResult[];
  query: string;
  showBadges: boolean;
  selectedKey: string | null;
  coverageMap?: Record<string, number>;
}) {
  return (
    <div className="min-w-0">
      {/* Column header */}
      <div className="flex items-center gap-2 mb-2 pb-2 border-b border-border/60">
        <Icon size={13} className="text-muted-foreground/40 shrink-0" />
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          {title}
        </span>
        <span className="text-[11px] text-muted-foreground/30 tabular-nums">{items.length}</span>
      </div>

      {/* Results */}
      <div className="space-y-px">
        {items.map((r) => (
          <ResultRow
            key={r.key}
            result={r}
            query={query}
            showBadge={showBadges}
            isSelected={r.key === selectedKey}
            coverageScore={coverageMap?.[r.key.split(":")[1]] ?? null}
          />
        ))}
      </div>
    </div>
  );
}

// ── Result row ───────────────────────────────────────────────────────

function ResultRow({
  result: r,
  query,
  showBadge,
  isSelected,
  coverageScore,
}: {
  result: UnifiedResult;
  query: string;
  showBadge: boolean;
  isSelected: boolean;
  coverageScore: number | null;
}) {
  const style = TYPE_STYLES[r.type] ?? FALLBACK_STYLE;
  const Icon = style.icon;
  const isExternal = r.href?.startsWith("http");

  const content = (
    <div
      id={`sr-${r.key}`}
      className={`group flex items-start gap-2 py-2 px-2 -mx-1 rounded-md transition-colors ${
        isSelected ? "bg-muted/60" : "hover:bg-muted/30"
      }`}
    >
      {/* Type icon */}
      <Icon size={14} className={`shrink-0 mt-0.5 ${style.iconColor}`} />

      <div className="min-w-0 flex-1">
        {/* Title + optional badge */}
        <div className="flex items-baseline gap-1.5">
          <span className="font-medium text-[13px] text-foreground leading-tight truncate group-hover:text-primary transition-colors">
            <Highlight text={decodeEntities(r.title)} query={query} />
          </span>
          {showBadge && (
            <span className={`shrink-0 px-1.5 py-px text-[9px] font-semibold rounded ${style.badge}`}>
              {style.short}
            </span>
          )}
          {coverageScore != null && r.column === "entities" && (
            <CoverageDots score={coverageScore} className="shrink-0 ml-0.5" />
          )}
          {isExternal && (
            <ExternalLink size={10} className="shrink-0 text-muted-foreground/25 mt-px" />
          )}
        </div>

        {/* Context line */}
        {r.context && (
          <p className="text-[11px] text-muted-foreground/40 truncate leading-tight">
            {r.context}
          </p>
        )}

        {/* Description — 2 lines for entities, 1 line for others */}
        {(r.snippet || r.description) && (
          <>
            {r.snippet ? (
              <p
                className={`text-[12px] text-muted-foreground/70 leading-snug mt-0.5 ${showBadge ? "line-clamp-2" : "line-clamp-1"} [&_mark]:bg-yellow-200/60 [&_mark]:dark:bg-yellow-500/25 [&_mark]:rounded-sm`}
                dangerouslySetInnerHTML={{ __html: sanitizeSnippet(r.snippet) }}
              />
            ) : r.description ? (
              <p className={`text-[12px] text-muted-foreground/70 leading-snug mt-0.5 ${showBadge ? "line-clamp-2" : "line-clamp-1"}`}>
                <Highlight text={decodeEntities(r.description)} query={query} />
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );

  if (!r.href) return content;

  if (isExternal) {
    return (
      <a href={r.href} target="_blank" rel="noopener noreferrer" className="block">
        {content}
      </a>
    );
  }

  return <Link href={r.href} className="block">{content}</Link>;
}

// ── Browse state ─────────────────────────────────────────────────────

function BrowseState({ data }: { data: BrowseData }) {
  return (
    <div className="space-y-8">
      {/* Directory quick links */}
      <section>
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Browse by type
        </h2>
        <div className="flex flex-wrap gap-2">
          {data.directories.map((dir) => {
            const style = TYPE_STYLES[dir.type] ?? FALLBACK_STYLE;
            const Icon = style.icon;
            return (
              <Link
                key={dir.type}
                href={dir.href}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border/60 text-sm text-foreground hover:bg-muted/50 transition-colors"
              >
                <Icon size={13} className={style.iconColor} />
                <span>{dir.label}</span>
                <span className="text-xs text-muted-foreground/40 tabular-nums">{dir.count}</span>
              </Link>
            );
          })}
          <Link
            href="/grants"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border/60 text-sm text-foreground hover:bg-muted/50 transition-colors"
          >
            <Banknote size={13} className="text-green-500" />
            <span>Grants</span>
          </Link>
          <Link
            href="/wiki"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border/60 text-sm text-foreground hover:bg-muted/50 transition-colors"
          >
            <FileText size={13} className="text-slate-400" />
            <span>Wiki pages</span>
            <span className="text-xs text-muted-foreground/40 tabular-nums">{data.totalPages}</span>
          </Link>
          <Link
            href="/resources"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border/60 text-sm text-foreground hover:bg-muted/50 transition-colors"
          >
            <ExternalLink size={13} className="text-orange-500" />
            <span>Resources</span>
          </Link>
        </div>
      </section>

      {/* Two-column: Featured + Recent */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Featured entities */}
        <section>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Key entities
          </h2>
          <div className="space-y-px">
            {data.featured.map((item) => {
              const style = TYPE_STYLES[item.type] ?? FALLBACK_STYLE;
              const Icon = style.icon;
              return (
                <Link key={item.id} href={item.href} className="block">
                  <div className="flex items-start gap-2 py-2 px-2 -mx-1 rounded-md hover:bg-muted/30 transition-colors">
                    <Icon size={14} className={`shrink-0 mt-0.5 ${style.iconColor}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="font-medium text-[13px] text-foreground truncate">
                          {item.title}
                        </span>
                        <span className={`shrink-0 px-1.5 py-px text-[9px] font-semibold rounded ${style.badge}`}>
                          {style.short}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {item.description && (
                          <p className="text-[12px] text-muted-foreground/60 leading-snug line-clamp-1 flex-1 min-w-0">
                            {item.description}
                          </p>
                        )}
                        <DataBadges item={item} />
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

        {/* Recently updated */}
        <section>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Recently updated
          </h2>
          <div className="space-y-px">
            {data.recent.map((item) => {
              const style = TYPE_STYLES[item.type] ?? FALLBACK_STYLE;
              const Icon = style.icon;
              return (
                <Link key={`recent-${item.id}`} href={item.href} className="block">
                  <div className="flex items-start gap-2 py-2 px-2 -mx-1 rounded-md hover:bg-muted/30 transition-colors">
                    <Icon size={14} className={`shrink-0 mt-0.5 ${style.iconColor}`} />
                    <div className="min-w-0 flex-1">
                      <span className="font-medium text-[13px] text-foreground truncate block">
                        {item.title}
                      </span>
                      <div className="flex items-center gap-2 mt-0.5">
                        {item.lastUpdated && (
                          <span className="text-[11px] text-muted-foreground/40">
                            {formatRelativeDate(item.lastUpdated)}
                          </span>
                        )}
                        <DataBadges item={item} />
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

/** Compact data-richness indicators for browse items. */
function DataBadges({ item }: { item: BrowseItem }) {
  const parts: string[] = [];
  if (item.wordCount && item.wordCount > 0) {
    parts.push(item.wordCount >= 1000
      ? `${(item.wordCount / 1000).toFixed(1)}k words`
      : `${item.wordCount} words`);
  }
  if (item.kbFactCount > 0) {
    parts.push(`${item.kbFactCount} facts`);
  }
  if (item.kbItemCount > 0) {
    parts.push(`${item.kbItemCount} items`);
  }
  if (parts.length === 0) return null;
  return (
    <span className="shrink-0 text-[10px] text-muted-foreground/30 tabular-nums">
      {parts.join(" · ")}
    </span>
  );
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

// ── Utilities ────────────────────────────────────────────────────────

export function sanitizeSnippet(html: string): string {
  let out = html
    .replace(/<mark\b[^>]*>/gi, "<mark>")
    .replace(/<\/mark\s*>/gi, "</mark>");
  // Strip all non-<mark> tags to a fixed point: removing one tag can splice
  // fragments into a fresh tag, so a single pass can be bypassed.
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<(?!\/?mark>)[^>]*>/gi, "");
  } while (out !== prev);
  return out;
}

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
          <mark key={i} className="bg-yellow-200/60 dark:bg-yellow-500/25 rounded-sm text-inherit">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function SearchIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
