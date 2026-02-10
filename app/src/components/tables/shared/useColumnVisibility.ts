import { useState, useCallback, useMemo } from "react";

export type ColumnGroup = "overview" | "safety" | "landscape" | "assessment" | "level" | "evidence" | "relations";

export interface ColumnConfig {
  key: string;
  label: string;
  group: ColumnGroup;
  default: boolean;
}

export interface UseColumnVisibilityOptions<T extends string> {
  columns: Record<T, ColumnConfig>;
  presets: Record<string, T[]>;
}

export interface UseColumnVisibilityReturn<T extends string> {
  visibleColumns: Set<T>;
  toggleColumn: (key: T) => void;
  applyPreset: (preset: string) => void;
  isVisible: (key: T) => boolean;
  visibleCount: number;
}

/**
 * Hook for managing column visibility state with presets
 */
export function useColumnVisibility<T extends string>(
  options: UseColumnVisibilityOptions<T>
): UseColumnVisibilityReturn<T> {
  const { columns, presets } = options;

  // Calculate default visible columns
  const defaultVisible = useMemo(() => {
    return new Set(
      Object.entries(columns)
        .filter(([_, config]) => (config as ColumnConfig).default)
        .map(([key]) => key as T)
    );
  }, [columns]);

  const [visibleColumns, setVisibleColumns] = useState<Set<T>>(defaultVisible);

  const toggleColumn = useCallback((key: T) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const applyPreset = useCallback(
    (preset: string) => {
      if (presets[preset]) {
        setVisibleColumns(new Set(presets[preset]));
      }
    },
    [presets]
  );

  const isVisible = useCallback(
    (key: T) => visibleColumns.has(key),
    [visibleColumns]
  );

  const visibleCount = visibleColumns.size;

  return {
    visibleColumns,
    toggleColumn,
    applyPreset,
    isVisible,
    visibleCount,
  };
}
