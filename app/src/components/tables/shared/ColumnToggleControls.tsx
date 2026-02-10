"use client";

import { cn } from "@/lib/utils";
import type { ColumnConfig, ColumnGroup } from "./useColumnVisibility";
import { columnGroupColors } from "./table-view-styles";

interface ColumnToggleControlsProps<T extends string> {
  columns: Record<T, ColumnConfig>;
  visibleColumns: Set<T>;
  toggleColumn: (key: T) => void;
  presets: Record<string, T[]>;
  applyPreset: (preset: string) => void;
  className?: string;
}

/**
 * Column toggle controls with preset buttons
 */
export function ColumnToggleControls<T extends string>({
  columns,
  visibleColumns,
  toggleColumn,
  presets,
  applyPreset,
  className,
}: ColumnToggleControlsProps<T>) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 px-2.5 py-2 bg-muted/20 rounded-md border border-border/50",
        className
      )}
    >
      <span className="text-xs font-medium text-muted-foreground mr-1">
        Columns:
      </span>

      {Object.entries(columns).map(([key, config]) => {
        const col = config as ColumnConfig;
        const isActive = visibleColumns.has(key as T);
        const groupColors = columnGroupColors[col.group] || columnGroupColors.overview;

        return (
          <button
            key={key}
            onClick={() => toggleColumn(key as T)}
            className={cn(
              "px-2 py-0.5 text-[10px] font-medium rounded border transition-colors",
              isActive ? groupColors.active : groupColors.inactive,
              "hover:opacity-90"
            )}
          >
            {col.label}
          </button>
        );
      })}

      <span className="text-[10px] text-muted-foreground/60 ml-2 mr-0.5">|</span>

      {Object.keys(presets).map((preset) => (
        <button
          key={preset}
          onClick={() => applyPreset(preset)}
          className={cn(
            "px-2 py-0.5 text-[10px] font-medium rounded border transition-colors",
            "border-indigo-400/60 text-indigo-600 hover:bg-indigo-50",
            "dark:border-indigo-500/60 dark:text-indigo-400 dark:hover:bg-indigo-950"
          )}
        >
          {formatPresetLabel(preset)}
        </button>
      ))}
    </div>
  );
}

function formatPresetLabel(preset: string): string {
  // Capitalize first letter and handle common presets
  const labels: Record<string, string> = {
    default: "Default",
    all: "All",
    safety: "Safety Focus",
    compact: "Compact",
  };
  return labels[preset] || preset.charAt(0).toUpperCase() + preset.slice(1);
}
