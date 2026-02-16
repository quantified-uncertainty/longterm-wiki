"use client";

import { cn } from "@/lib/utils";
import { Search } from "lucide-react";

/**
 * Pill-style filter tabs with counts. Shared by interventions (category) and proposals (domain).
 */
export function FilterTabs({
  counts,
  active,
  onSelect,
  badgeStyles,
}: {
  counts: Record<string, number>;
  active: string | null;
  onSelect: (key: string | null) => void;
  /** Optional per-key Tailwind classes applied when the tab is active. */
  badgeStyles?: Record<string, string>;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-wrap gap-1.5 mb-4 not-prose">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "rounded-full px-3 py-1 text-xs font-medium transition-colors",
          active === null
            ? "bg-foreground text-background"
            : "bg-muted text-muted-foreground hover:bg-muted/80"
        )}
      >
        All ({total})
      </button>
      {Object.entries(counts)
        .sort(([, a], [, b]) => b - a)
        .map(([key, count]) => (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(active === key ? null : key)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              active === key
                ? badgeStyles?.[key] || "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            )}
          >
            {key} ({count})
          </button>
        ))}
    </div>
  );
}

/**
 * Search input with result count. Matches the DataTable legacy search bar styling.
 */
export function TableSearchBar({
  value,
  onChange,
  placeholder,
  resultCount,
  totalCount,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  resultCount: number;
  totalCount: number;
}) {
  return (
    <div className="flex items-center gap-4 pb-4 not-prose">
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
        />
      </div>
      <span className="text-sm text-muted-foreground whitespace-nowrap">
        {resultCount} of {totalCount} results
      </span>
    </div>
  );
}
