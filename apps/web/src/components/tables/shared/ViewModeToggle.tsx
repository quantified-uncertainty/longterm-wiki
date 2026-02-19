"use client";

import { cn } from "@/lib/utils";

export type ViewMode = "unified" | "grouped";

interface ViewModeToggleProps {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  unifiedLabel?: string;
  groupedLabel?: string;
}

/**
 * Toggle between unified table view and grouped by category view.
 * Uses shadcn Tabs visual styling (pill toggle).
 */
export function ViewModeToggle({
  viewMode,
  setViewMode,
  unifiedLabel = "Unified Table",
  groupedLabel = "Grouped by Category",
}: ViewModeToggleProps) {
  return (
    <div className="inline-flex h-8 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
      <button
        onClick={() => setViewMode("unified")}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-all",
          viewMode === "unified"
            ? "bg-background text-foreground shadow"
            : "hover:text-foreground"
        )}
      >
        {unifiedLabel}
      </button>
      <button
        onClick={() => setViewMode("grouped")}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-all",
          viewMode === "grouped"
            ? "bg-background text-foreground shadow"
            : "hover:text-foreground"
        )}
      >
        {groupedLabel}
      </button>
    </div>
  );
}
