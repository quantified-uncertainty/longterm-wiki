"use client";

import {
  filterVisibleFacets,
  formatFacetTextContent,
  type FilterFacet,
} from "@components/directory/filter-shared";

export type FilterDropdownItem = FilterFacet;

export interface DirectoryFilterDropdownProps {
  items: FilterDropdownItem[];
  selected: string;
  onSelect: (key: string) => void;
  /** Label for the "All" reset option. Default: "All". */
  allLabel?: string;
  /** Total count shown next to "All". Used as the tautology threshold too. */
  allCount?: number;
  /** Required for accessibility — names the filter (e.g., "Filter by funder"). */
  ariaLabel: string;
  /** Inline label rendered before the select (e.g., "Funder:"). */
  prefix?: string;
  /** Drop facets whose count equals `allCount` (tautology). Default: false. */
  hideTautologyFacets?: boolean;
  /**
   * If only one option (other than "All") would render, hide the whole
   * dropdown — a one-option filter is no filter. Default: false.
   */
  hideWhenTrivial?: boolean;
  className?: string;
}

/**
 * Shared dropdown filter for directory pages (QUA-1009).
 *
 * Pairs with `FilterChips`. Use this when a filter has more than ~8 facets,
 * or when vertical space is at premium. Wraps a native `<select>` styled
 * to match the chip pattern.
 *
 * Option labels use `formatFacetTextContent` to ensure "Label (count)" with a
 * real space separator (closes QUA-918 by construction).
 */
export function DirectoryFilterDropdown({
  items,
  selected,
  onSelect,
  allLabel = "All",
  allCount,
  ariaLabel,
  prefix,
  hideTautologyFacets = false,
  hideWhenTrivial = false,
  className,
}: DirectoryFilterDropdownProps) {
  const visible = filterVisibleFacets(items, {
    total: allCount,
    hideTautologyFacets,
  });

  if (hideWhenTrivial && visible.length <= 1) return null;

  return (
    <div
      data-testid="filter-dropdown"
      className={`flex items-center gap-1.5 ${className ?? ""}`}
    >
      {prefix && (
        <span className="text-xs text-muted-foreground/70">{prefix}</span>
      )}
      <select
        aria-label={ariaLabel}
        value={selected}
        onChange={(e) => onSelect(e.target.value)}
        className="text-xs px-2.5 py-1.5 rounded-lg border border-border/60 bg-card hover:bg-muted/50 text-muted-foreground transition-all focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
      >
        <option value="all">{formatFacetTextContent(allLabel, allCount)}</option>
        {visible.map((item) => (
          <option key={item.key} value={item.key}>
            {formatFacetTextContent(item.label, item.count)}
          </option>
        ))}
      </select>
    </div>
  );
}
