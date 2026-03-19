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

// ── Type styling ─────────────────────────────────────────────────────

interface TypeStyle {
  label: string;
  short: string;
  icon: LucideIcon;
  badge: string;
  accent: string;
}

const TYPE_STYLES: Record<string, TypeStyle> = {
  wiki:             { label: "Wiki Article",   short: "Wiki",     icon: FileText,   badge: "bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-400",         accent: "border-l-slate-300 dark:border-l-slate-600" },
  organization:     { label: "Organization",   short: "Org",      icon: Building2,  badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",         accent: "border-l-amber-400 dark:border-l-amber-500" },
  person:           { label: "Person",         short: "Person",   icon: User,       badge: "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",                 accent: "border-l-sky-400 dark:border-l-sky-500" },
  "ai-model":       { label: "AI Model",       short: "Model",    icon: Cpu,        badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",             accent: "border-l-blue-400 dark:border-l-blue-500" },
  policy:           { label: "Legislation",    short: "Law",      icon: Scale,      badge: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",     accent: "border-l-purple-400 dark:border-l-purple-500" },
  project:          { label: "Project",        short: "Project",  icon: Package,    badge: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",             accent: "border-l-teal-400 dark:border-l-teal-500" },
  approach:         { label: "Approach",       short: "Approach", icon: Compass,    badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300", accent: "border-l-emerald-400 dark:border-l-emerald-500" },
  event:            { label: "Event",          short: "Event",    icon: Calendar,   badge: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",             accent: "border-l-rose-400 dark:border-l-rose-500" },
  benchmark:        { label: "Benchmark",      short: "Bench",    icon: Gauge,      badge: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",     accent: "border-l-indigo-400 dark:border-l-indigo-500" },
  "research-area":  { label: "Research Area",  short: "Research", icon: Microscope, badge: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",             accent: "border-l-cyan-400 dark:border-l-cyan-500" },
  grant:            { label: "Grant",          short: "Grant",    icon: Banknote,   badge: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",         accent: "border-l-green-300 dark:border-l-green-600" },
  "funding-round":  { label: "Funding Round",  short: "Funding",  icon: TrendingUp, badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300", accent: "border-l-emerald-300 dark:border-l-emerald-600" },
  "funding-program":{ label: "Funding Program",short: "Program",  icon: Wallet,     badge: "bg-lime-100 text-lime-800 dark:bg-lime-900/30 dark:text-lime-300",             accent: "border-l-lime-300 dark:border-l-lime-600" },
  division:         { label: "Division",       short: "Division", icon: GitBranch,  badge: "bg-stone-100 text-stone-700 dark:bg-stone-800/40 dark:text-stone-300",         accent: "border-l-stone-300 dark:border-l-stone-600" },
  resource:         { label: "Resource",       short: "Resource", icon: BookOpen,   badge: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",     accent: "border-l-orange-300 dark:border-l-orange-600" },
};

const FALLBACK_STYLE: TypeStyle = {
  label: "Item", short: "Item", icon: FileText,
  badge: "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400",
  accent: "border-l-gray-300 dark:border-l-gray-600",
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

/** Classify a result into one of three columns. */
function classifyColumn(type: string, source: "page" | "thing"): ResultColumn {
  // Directory entity types → Entities column
  if (DIRECTORY_ROUTES[type]) return "entities";
  // Resource things → Resources column
  if (type === "resource") return "resources";
  // Data record things (grants, funding, etc.) → Entities column
  if (source === "thing") return "entities";
  // Everything else (wiki articles) → Wiki column
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

  // For directory entities that also have wiki pages, add a second
  // result linking to the wiki article
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
      score: r.score * 0.8, // Slightly lower rank than the directory entry
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

function blendedScore(r: UnifiedResult): number {
  const importance = (r.readerImportance ?? 0) / 60;
  return r.score + importance * 10;
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
  const [errored, setErrored] = useState(false);
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

    const unified = [
      ...pageResults.flatMap(fromPage),
      ...dedupedThings.map(fromThing),
    ].filter((r) => !r.isInternal);

    unified.sort((a, b) => blendedScore(b) - blendedScore(a));

    setResults(unified);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (initialQuery) performSearch(initialQuery);
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
      performSearch(value);
    }, 200);
  }, [performSearch, syncUrl]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    syncUrl(query);
    performSearch(query);
  }, [query, performSearch, syncUrl]);

  // ── Split results into three columns ───────────────────────────────

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

  const totalCount = results.length;
  const hasResults = totalCount > 0;

  // ── Render ─────────────────────────────────────────────────────────

  const hasQuery = query.trim().length > 0;
  const showEmpty = searched && !loading && !hasResults;

  return (
    <div className="max-w-7xl mx-auto px-6 pt-10 pb-16">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground">
          Search
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Entities, wiki articles, grants, resources, and more
        </p>
      </div>

      {/* Search bar */}
      <form onSubmit={handleSubmit} className="relative mb-8 group max-w-2xl">
        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/40 group-focus-within:text-foreground/50 transition-colors">
          <SearchIcon size={18} />
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

      {/* Pre-search empty state */}
      {!hasQuery && !searched && (
        <div className="text-center py-16 max-w-2xl">
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
        <div className="text-center py-16 max-w-2xl">
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

      {/* Result count */}
      {searched && !loading && hasResults && (
        <div className="text-[11px] text-muted-foreground/50 mb-4 tabular-nums">
          {totalCount} result{totalCount !== 1 ? "s" : ""}
        </div>
      )}

      {/* Three-column layout */}
      {hasResults && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <ResultColumn
            title="Entities"
            subtitle="Organizations, people, policies"
            icon={Building2}
            items={columns.entities}
            query={query}
            emptyText="No entity matches"
          />
          <ResultColumn
            title="Wiki"
            subtitle="Articles and analysis"
            icon={FileText}
            items={columns.wiki}
            query={query}
            emptyText="No wiki matches"
          />
          <ResultColumn
            title="Resources"
            subtitle="External links and references"
            icon={ExternalLink}
            items={columns.resources}
            query={query}
            emptyText="No resource matches"
          />
        </div>
      )}
    </div>
  );
}

// ── Column component ─────────────────────────────────────────────────

function ResultColumn({
  title,
  subtitle,
  icon: Icon,
  items,
  query,
  emptyText,
}: {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  items: UnifiedResult[];
  query: string;
  emptyText: string;
}) {
  return (
    <div className="min-w-0">
      {/* Column header */}
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border">
        <Icon size={14} className="text-muted-foreground/50 shrink-0" />
        <div>
          <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            {title}
            {items.length > 0 && (
              <span className="ml-1.5 text-muted-foreground/40 font-normal">{items.length}</span>
            )}
          </h2>
          <p className="text-[10px] text-muted-foreground/40">{subtitle}</p>
        </div>
      </div>

      {/* Results */}
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground/30 py-4 text-center">{emptyText}</p>
      ) : (
        <div className="space-y-0.5">
          {items.map((r) => (
            <ResultRow key={r.key} result={r} query={query} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Result row ───────────────────────────────────────────────────────

function ResultRow({
  result: r,
  query,
}: {
  result: UnifiedResult;
  query: string;
}) {
  const style = TYPE_STYLES[r.type] ?? FALLBACK_STYLE;
  const Icon = style.icon;

  const content = (
    <div className={`border-l-[3px] rounded-r-md py-2 pl-3 pr-2 transition-colors hover:bg-muted/40 ${style.accent}`}>
      {/* Title row with icon */}
      <div className="flex items-center gap-1.5">
        <Icon size={13} className="shrink-0 opacity-50" />
        <span className="font-medium text-sm text-foreground leading-snug truncate">
          <Highlight text={r.title} query={query} />
        </span>
        <span className={`shrink-0 inline-flex items-center px-1.5 py-0 text-[9px] font-semibold rounded ${style.badge}`}>
          {style.short}
        </span>
      </div>

      {/* Context */}
      {r.context && (
        <div className="text-[11px] text-muted-foreground/45 mt-0.5 pl-[19px] truncate">
          {r.context}
        </div>
      )}

      {/* Description — compact, single line */}
      {(r.snippet || r.description) && (
        <div className="pl-[19px] mt-0.5">
          {r.snippet ? (
            <p
              className="text-[11px] text-muted-foreground/60 leading-snug line-clamp-1 [&_mark]:bg-yellow-200/50 [&_mark]:dark:bg-yellow-500/20 [&_mark]:rounded-sm"
              dangerouslySetInnerHTML={{ __html: sanitizeSnippet(r.snippet) }}
            />
          ) : r.description ? (
            <p className="text-[11px] text-muted-foreground/60 leading-snug line-clamp-1">
              <Highlight text={r.description} query={query} />
            </p>
          ) : null}
        </div>
      )}
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

// ── Utilities ────────────────────────────────────────────────────────

function sanitizeSnippet(html: string): string {
  return html.replace(/<(?!\/?mark\b)[^>]*>/gi, "");
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
          <mark key={i} className="bg-yellow-200/50 dark:bg-yellow-500/20 rounded-sm text-inherit">{part}</mark>
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
