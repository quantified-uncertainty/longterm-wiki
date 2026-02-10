"use client";

import { cn } from "@/lib/utils";

export type ViewMode = "unified" | "grouped";

interface ViewModeToggleProps {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  unifiedLabel?: string;
  groupedLabel?: string;
  className?: string;
}

/**
 * Toggle between unified table view and grouped by category view
 */
export function ViewModeToggle({
  viewMode,
  setViewMode,
  unifiedLabel = "Unified Table",
  groupedLabel = "Grouped by Category",
  className,
}: ViewModeToggleProps) {
  return (
    <div className={cn("flex gap-2", className)}>
      <button
        onClick={() => setViewMode("unified")}
        className={cn(
          "px-3 py-1.5 text-sm rounded-md border transition-colors",
          viewMode === "unified"
            ? "bg-primary text-primary-foreground border-primary"
            : "bg-background text-muted-foreground border-border hover:bg-muted"
        )}
      >
        {unifiedLabel}
      </button>
      <button
        onClick={() => setViewMode("grouped")}
        className={cn(
          "px-3 py-1.5 text-sm rounded-md border transition-colors",
          viewMode === "grouped"
            ? "bg-primary text-primary-foreground border-primary"
            : "bg-background text-muted-foreground border-border hover:bg-muted"
        )}
      >
        {groupedLabel}
      </button>
    </div>
  );
}
