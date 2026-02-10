"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { searchWiki, preloadSearchIndex, type SearchResult } from "@lib/search";
import { ENTITY_TYPES } from "@data/entity-ontology";

/**
 * Cmd+K search dialog with live MiniSearch results.
 */
export function SearchDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pendingQuery, setPendingQuery] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
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

  // Focus input and lock body scroll when dialog opens
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      preloadSearchIndex();
      document.body.style.overflow = "hidden";
    } else {
      setQuery("");
      setResults([]);
      setSelected(0);
      setPendingQuery(false);
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setSelected(0);
      setPendingQuery(false);
      return;
    }

    setPendingQuery(true);
    const timer = setTimeout(async () => {
      setLoading(true);
      setPendingQuery(false);
      try {
        const r = await searchWiki(query, 12);
        setResults(r);
        setSelected(0);
      } finally {
        setLoading(false);
      }
    }, 80);

    return () => clearTimeout(timer);
  }, [query]);

  const navigate = useCallback(
    (result: SearchResult) => {
      setOpen(false);
      router.push(`/wiki/${result.numericId}`);
    },
    [router]
  );

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[selected] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Keyboard navigation
  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && results[selected]) {
      e.preventDefault();
      navigate(results[selected]);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search wiki"
        className="relative w-full max-w-lg mx-4 bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
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
            placeholder="Search wiki..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-muted-foreground bg-muted rounded border border-border font-mono">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[50vh] overflow-y-auto">
          {(loading || pendingQuery) && results.length === 0 && (
            <div className="px-4 py-6 text-sm text-muted-foreground text-center">
              Searching...
            </div>
          )}

          {!loading && !pendingQuery && query.trim() && results.length === 0 && (
            <div className="px-4 py-6 text-sm text-muted-foreground text-center">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {results.length > 0 && (
            <ul ref={listRef} className="py-1" role="listbox">
              {results.map((r, i) => (
                <li key={r.id} role="option" aria-selected={i === selected}>
                  <button
                    className={`w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors ${
                      i === selected
                        ? "bg-muted"
                        : "hover:bg-muted/50"
                    }`}
                    onClick={() => navigate(r)}
                    onMouseEnter={() => setSelected(i)}
                  >
                    <TypeBadge type={r.type} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground truncate">
                        {r.title}
                      </div>
                      {r.description && (
                        <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                          {r.description}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!query.trim() && (
            <div className="px-4 py-6 text-sm text-muted-foreground text-center">
              Type to search across all wiki pages and entities
            </div>
          )}
        </div>

        {/* Footer */}
        {results.length > 0 && (
          <div className="flex items-center gap-4 px-4 py-2 border-t border-border text-[10px] text-muted-foreground">
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
        )}
      </div>
    </div>
  );
}

/**
 * Compact search trigger button for the header.
 */
export function SearchButton() {
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true })
        );
      }}
      onMouseEnter={preloadSearchIndex}
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
