"use client";

export interface FilterChipItem {
  key: string;
  label: string;
  count?: number;
}

export interface FilterChipsProps {
  items: FilterChipItem[];
  selected: string;
  onSelect: (key: string) => void;
  allLabel?: string;
  allCount?: number;
}

/**
 * Shared filter chip bar for directory pages.
 *
 * Renders an "All" button followed by one button per item.
 * Clicking the currently-selected chip deselects it (resets to "all").
 */
export function FilterChips({
  items,
  selected,
  onSelect,
  allLabel = "All",
  allCount,
}: FilterChipsProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={() => onSelect("all")}
        aria-pressed={selected === "all"}
        className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
          selected === "all"
            ? "bg-primary/10 border-primary/30 text-primary font-semibold"
            : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
        }`}
      >
        {allLabel}
        {allCount != null && (
          <span className="ml-1 text-[10px] opacity-60">{allCount}</span>
        )}
      </button>
      {items.map((item) => (
        <button
          key={item.key}
          onClick={() => onSelect(selected === item.key ? "all" : item.key)}
          aria-pressed={selected === item.key}
          className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
            selected === item.key
              ? "bg-primary/10 border-primary/30 text-primary font-semibold"
              : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
          }`}
        >
          {item.label}
          {item.count != null && (
            <span className="ml-1 text-[10px] opacity-60">{item.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
