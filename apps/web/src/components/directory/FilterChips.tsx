"use client";

import {
  filterVisibleFacets,
  formatFacetTextContent,
  type FilterFacet,
} from "./filter-shared";

export type FilterChipItem = FilterFacet;

export interface FilterChipsProps {
  items: FilterChipItem[];
  selected: string;
  onSelect: (key: string) => void;
  /** Label for the "All" reset chip. Default: "All". */
  allLabel?: string;
  /** Total count shown next to "All". Used as the tautology threshold too. */
  allCount?: number;
  /** Inline label rendered before the chip row (e.g., "Status:"). */
  prefix?: string;
  /**
   * Drop facets whose count equals `allCount` (tautology — match every row).
   * Default: false. Closes the QUA-919 tautology arm at the component layer.
   */
  hideTautologyFacets?: boolean;
  /**
   * If only one chip would be visible after filtering, render nothing.
   * Default: false. A "filter" with one option is no filter.
   */
  hideWhenTrivial?: boolean;
  className?: string;
}

/**
 * Shared filter chip bar for directory pages (QUA-1009).
 *
 * Renders an "All" button followed by one button per item.
 * Clicking the currently-selected chip deselects it (resets to "all").
 *
 * Label format: "Label (count)" with a real text-node space, so screen
 * readers and Playwright `textContent` see the separator. Bespoke chip rows
 * across the codebase used `{label}<span>{count}</span>` with only CSS
 * margin and produced concatenated `Label18` text — that bug class is
 * eliminated by construction here.
 */
export function FilterChips({
  items,
  selected,
  onSelect,
  allLabel = "All",
  allCount,
  prefix,
  hideTautologyFacets = false,
  hideWhenTrivial = false,
  className,
}: FilterChipsProps) {
  const visible = filterVisibleFacets(items, {
    total: allCount,
    hideTautologyFacets,
  });

  if (hideWhenTrivial && visible.length <= 1) return null;

  return (
    <div
      data-testid="filter-chips"
      className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`}
    >
      {prefix && (
        <span className="text-xs text-muted-foreground/70 mr-0.5 self-center">
          {prefix}
        </span>
      )}
      <FilterChipButton
        label={allLabel}
        count={allCount}
        active={selected === "all"}
        onClick={() => onSelect("all")}
      />
      {visible.map((item) => (
        <FilterChipButton
          key={item.key}
          label={item.label}
          count={item.count}
          active={selected === item.key}
          onClick={() => onSelect(selected === item.key ? "all" : item.key)}
          className="capitalize"
        />
      ))}
    </div>
  );
}

interface FilterChipButtonProps {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  className?: string;
}

function FilterChipButton({
  label,
  count,
  active,
  onClick,
  className,
}: FilterChipButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={formatFacetTextContent(label, count)}
      data-testid="filter-chip"
      className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
        active
          ? "bg-primary/10 border-primary/30 text-primary font-semibold"
          : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
      } ${className ?? ""}`}
    >
      {label}
      {count != null && (
        <>
          {" "}
          <span className="text-[10px] opacity-60 font-normal">({count})</span>
        </>
      )}
    </button>
  );
}
