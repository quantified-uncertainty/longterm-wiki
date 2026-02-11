"use client";

import { cn } from "@/lib/utils";
import type { ColumnConfig } from "./useColumnVisibility";

interface ColumnToggleControlsProps<T extends string> {
  columns: Record<T, ColumnConfig>;
  visibleColumns: Set<T>;
  toggleColumn: (key: T) => void;
  presets: Record<string, T[]>;
  applyPreset: (preset: string) => void;
  className?: string;
}

/**
 * Column toggle controls with preset buttons.
 * Uses neutral styling — active columns are filled, inactive are outlined.
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
        "flex flex-wrap items-center gap-1 px-2 py-1.5 bg-muted/20 rounded-md border border-border/40",
        className
      )}
    >
      <span className="text-[10px] font-medium text-muted-foreground mr-0.5">
        Columns:
      </span>

      {Object.entries(columns).map(([key, config]) => {
        const col = config as ColumnConfig;
        const isActive = visibleColumns.has(key as T);

        return (
          <button
            key={key}
            onClick={() => toggleColumn(key as T)}
            className={cn(
              "px-2 py-0.5 text-[10px] font-medium rounded-full transition-colors",
              isActive
                ? "bg-muted text-foreground ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            {col.label}
          </button>
        );
      })}

      <span className="text-muted-foreground/30 mx-1">|</span>

      {Object.keys(presets).map((preset) => (
        <button
          key={preset}
          onClick={() => applyPreset(preset)}
          className="px-2 py-0.5 text-[10px] font-medium rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors underline underline-offset-2 decoration-muted-foreground/30"
        >
          {formatPresetLabel(preset)}
        </button>
      ))}
    </div>
  );
}

function formatPresetLabel(preset: string): string {
  const labels: Record<string, string> = {
    default: "Default",
    all: "All",
    safety: "Safety Focus",
    compact: "Compact",
  };
  return labels[preset] || preset.charAt(0).toUpperCase() + preset.slice(1);
}
