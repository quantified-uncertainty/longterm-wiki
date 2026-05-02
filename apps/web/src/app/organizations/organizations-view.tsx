"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OrganizationsTable, type OrgRow, type OrgStatDef } from "./organizations-table";
import { OrganizationsGrouped, GROUPS } from "./organizations-grouped";
import { useDirectoryUrl } from "@/hooks/use-directory-url";
import { formatFacetTextContent } from "@/components/directory/filter-shared";

type ViewMode = "groups" | "table";

/** Window after a chip click during which a 2nd click on the same chip
 *  promotes from "scroll-to-section" to "expand as filtered table view". */
const CHIP_REPEAT_WINDOW_MS = 8000;

export function OrganizationsView({
  rows,
  stats,
  serverEnabled = false,
  orgTypeMap,
}: {
  rows: OrgRow[];
  stats?: OrgStatDef[];
  serverEnabled?: boolean;
  orgTypeMap?: Record<string, string>;
}) {
  const url = useDirectoryUrl({
    defaultSort: { field: "name", dir: "asc" },
    filters: ["type", "stat"],
  });
  const search = url.search;
  const typeFilter = url.filters.type ?? "all";

  // Initial view: ?type=<x> on cold load means user wants the filtered table.
  const initialView: ViewMode = typeFilter !== "all" ? "table" : "groups";
  const [view, setView] = useState<ViewMode>(initialView);

  const lastExplicitViewRef = useRef<ViewMode>(initialView);
  const [searchOpenedTable, setSearchOpenedTable] = useState(false);
  const prevSearchRef = useRef(search);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl+K focuses search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const wasEmpty = prevSearchRef.current.trim() === "";
    const isEmpty = search.trim() === "";

    if (!isEmpty && wasEmpty && view === "groups") {
      setSearchOpenedTable(true);
      setView("table");
    } else if (isEmpty && !wasEmpty && searchOpenedTable) {
      setView(lastExplicitViewRef.current);
      setSearchOpenedTable(false);
    }
    prevSearchRef.current = search;
  }, [search, view, searchOpenedTable]);

  // Counts per orgType (rolled up to the same buckets the grouped view uses).
  const typeCounts = useMemo(() => {
    const knownTypes = new Set(GROUPS.map((g) => g.orgType));
    const counts: Record<string, number> = { all: rows.length };
    for (const r of rows) {
      const t = r.orgType && knownTypes.has(r.orgType) ? r.orgType : "generic";
      counts[t] = (counts[t] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  const chipItems = useMemo(
    () =>
      GROUPS.filter((g) => (typeCounts[g.orgType] ?? 0) > 0).map((g) => ({
        key: g.orgType,
        label: g.chipLabel,
        count: typeCounts[g.orgType] ?? 0,
      })),
    [typeCounts],
  );

  // Last chip + timestamp — drives the "click again to expand as table" UX.
  const lastChipRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });

  const handleChipClick = useCallback(
    (key: string) => {
      if (view === "groups") {
        const now = Date.now();
        const isRepeat =
          lastChipRef.current.key === key &&
          now - lastChipRef.current.at < CHIP_REPEAT_WINDOW_MS;
        lastChipRef.current = { key, at: now };

        const sectionEl = document.getElementById(`group-${key}`);

        if (isRepeat) {
          // Second tap on same chip → escalate to filtered table view.
          url.setFilter("type", key);
          setView("table");
          lastExplicitViewRef.current = "table";
          return;
        }
        if (sectionEl) {
          sectionEl.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
      }
      url.setFilter("type", key);
    },
    [url, view],
  );

  const handleAllClick = useCallback(() => {
    url.setFilter("type", "all");
    if (view === "groups") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [url, view]);

  const handleViewAll = useCallback(
    (orgType: string) => {
      url.setFilter("type", orgType);
      setView("table");
      lastExplicitViewRef.current = "table";
    },
    [url],
  );

  const handleViewToggle = useCallback(
    (next: ViewMode) => {
      setView(next);
      lastExplicitViewRef.current = next;
      if (next === "groups" && typeFilter !== "all") {
        url.setFilter("type", "all");
      }
    },
    [url, typeFilter],
  );

  return (
    <div>
      {/* Sticky header: search + chips + view toggle stay reachable while
          scrolling through long sections. */}
      <div className="sticky top-0 z-30 -mx-6 px-6 pt-2 pb-3 mb-5 bg-background/85 backdrop-blur-md border-b border-border/40">
        <div role="search" className="flex flex-col lg:flex-row gap-3 mb-2.5">
          <div className="relative w-full lg:w-96">
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search name, type, people, funding programs, description..."
              aria-label="Search organizations"
              value={search}
              onChange={(e) => url.setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && search) {
                  e.preventDefault();
                  url.setSearch("");
                }
              }}
              className="px-3 py-2 pr-16 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full"
            />
            {search ? (
              <button
                type="button"
                onClick={() => {
                  url.setSearch("");
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-xs text-muted-foreground/70 hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                ✕
              </button>
            ) : (
              <kbd
                aria-hidden="true"
                className="absolute right-2 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground/60 border border-border/60 rounded bg-muted/40 pointer-events-none"
              >
                ⌘K
              </kbd>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <ChipButton
              label="All"
              count={typeCounts.all}
              selected={typeFilter === "all"}
              onClick={handleAllClick}
            />
            {chipItems.map((item) => (
              <ChipButton
                key={item.key}
                label={item.label}
                count={item.count}
                selected={typeFilter === item.key}
                onClick={() => handleChipClick(item.key)}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Organization view"
            className="inline-flex rounded-lg border border-border bg-card p-0.5 text-xs"
          >
            <ViewTab
              active={view === "groups"}
              onClick={() => handleViewToggle("groups")}
              controls="orgs-panel-groups"
              id="orgs-tab-groups"
            >
              By category
            </ViewTab>
            <ViewTab
              active={view === "table"}
              onClick={() => handleViewToggle("table")}
              controls="orgs-panel-table"
              id="orgs-tab-table"
            >
              Table view
            </ViewTab>
          </div>
          {view === "groups" && typeFilter === "all" && (
            <span className="text-[11px] text-muted-foreground/70 hidden md:inline">
              Tip: click a category chip again to see its full list
            </span>
          )}
        </div>
      </div>

      {view === "groups" ? (
        <div role="tabpanel" id="orgs-panel-groups" aria-labelledby="orgs-tab-groups">
          <OrganizationsGrouped rows={rows} onViewAll={handleViewAll} />
        </div>
      ) : (
        <div role="tabpanel" id="orgs-panel-table" aria-labelledby="orgs-tab-table">
          <OrganizationsTable
            rows={rows}
            stats={stats}
            serverEnabled={serverEnabled}
            orgTypeMap={orgTypeMap}
            hideHeader
          />
        </div>
      )}
    </div>
  );
}

// Local ChipButton for /organizations specifically: needs the "click again to
// scroll/escalate-to-table" UX (see handleChipClick) which the canonical
// FilterChips deliberately does not model. Visible label uses the same
// "Label (count)" format as FilterChips so textContent is "Funders (55)"
// and not "Funders55" (closes the QUA-918 bug class for this surface too).
function ChipButton({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onClick: () => void;
}) {
  // Screen-reader label reads "Funders, 55 organizations" — richer than the
  // canonical "Funders (55)" because this directory's chips count entities.
  const ariaLabel =
    count != null ? `${label}, ${count} organization${count === 1 ? "" : "s"}` : label;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={ariaLabel}
      data-testid="filter-chip"
      className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
        selected
          ? "bg-primary/10 border-primary/30 text-primary font-semibold"
          : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
      }`}
    >
      <span aria-hidden="true">{formatFacetTextContent(label, count)}</span>
    </button>
  );
}

function ViewTab({
  active,
  onClick,
  controls,
  id,
  children,
}: {
  active: boolean;
  onClick: () => void;
  controls: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      id={id}
      aria-selected={active}
      // Only the selected tab references its panel — the inactive panel isn't
      // in the DOM (we don't want to mount both views at once), so dangling
      // aria-controls on the inactive tab would point at a non-existent ID.
      aria-controls={active ? controls : undefined}
      tabIndex={active ? 0 : -1}
      type="button"
      onClick={onClick}
      className={`px-3 py-1 rounded-md transition-colors ${
        active
          ? "bg-primary/10 text-foreground font-medium"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
