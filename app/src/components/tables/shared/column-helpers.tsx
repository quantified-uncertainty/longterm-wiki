"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { ChevronRight } from "lucide-react";
import { SortableHeader } from "@/components/ui/sortable-header";
import { cn } from "@/lib/utils";
import { getLevelSortValue } from "./table-view-styles";
import { LevelBadge, CellNote, ProsCons } from "./cell-components";

/**
 * Column factory functions that replace 15-line boilerplate with 1-line calls.
 */

/**
 * Create a chevron expand/collapse toggle column.
 * Works with TanStack Table's built-in expand state (`getExpandedRowModel()`).
 */
export function expandToggleColumn<TData>(): ColumnDef<TData> {
  return {
    id: "expand",
    size: 32,
    header: () => null,
    cell: ({ row }) => (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          row.toggleExpanded();
        }}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label={row.getIsExpanded() ? "Collapse" : "Expand"}
      >
        <ChevronRight
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            row.getIsExpanded() && "rotate-90"
          )}
        />
      </button>
    ),
  };
}

/**
 * Create a column for a `{ level, note }` field.
 * Replaces the repeated pattern of accessorFn + SortableHeader + LevelBadge + CellNote + sortingFn.
 */
export function levelNoteColumn<TData>({
  id,
  accessor,
  label,
  tooltip,
  badgeCategory,
  noteStyle = "inline",
  sortValue,
  formatLevel,
}: {
  id: string;
  accessor: (row: TData) => { level: string; note?: string };
  label: string;
  tooltip?: string;
  badgeCategory?: string;
  noteStyle?: "inline" | "tooltip";
  sortValue?: (row: TData) => number;
  formatLevel?: (level: string) => string;
}): ColumnDef<TData> {
  return {
    id,
    accessorFn: (row) => accessor(row).level,
    header: ({ column }) => (
      <SortableHeader column={column} title={tooltip}>
        {label}
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const data = accessor(row.original);
      if (noteStyle === "tooltip") {
        return (
          <div className="group relative" title={data.note || undefined}>
            <LevelBadge level={data.level} category={badgeCategory} formatLevel={formatLevel} />
          </div>
        );
      }
      return (
        <div>
          <LevelBadge level={data.level} category={badgeCategory} formatLevel={formatLevel} />
          <CellNote note={data.note} />
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const a = sortValue ? sortValue(rowA.original) : getLevelSortValue(accessor(rowA.original).level);
      const b = sortValue ? sortValue(rowB.original) : getLevelSortValue(accessor(rowB.original).level);
      return a - b;
    },
  };
}

/**
 * Create a column for a plain string level field (e.g., accessorKey: "severity").
 * For fields where the level is a direct string property, not a `{ level, note }` object.
 */
export function simpleLevelColumn<TData>({
  id,
  accessorKey,
  label,
  tooltip,
  badgeCategory,
  noteAccessor,
  noteStyle = "inline",
  sortValue,
  formatLevel,
}: {
  id: string;
  accessorKey: string;
  label: string;
  tooltip?: string;
  badgeCategory?: string;
  noteAccessor?: (row: TData) => string | undefined;
  noteStyle?: "inline" | "tooltip";
  sortValue?: (row: TData) => number;
  formatLevel?: (level: string) => string;
}): ColumnDef<TData> {
  return {
    id,
    accessorKey,
    header: ({ column }) => (
      <SortableHeader column={column} title={tooltip}>
        {label}
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const level = (row.original as Record<string, string>)[accessorKey];
      const note = noteAccessor ? noteAccessor(row.original) : undefined;
      if (noteStyle === "tooltip" && note) {
        return (
          <div title={note}>
            <LevelBadge level={level} category={badgeCategory} formatLevel={formatLevel} />
          </div>
        );
      }
      return (
        <div>
          <LevelBadge level={level} category={badgeCategory} formatLevel={formatLevel} />
          {noteStyle === "inline" && <CellNote note={note} />}
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const a = sortValue
        ? sortValue(rowA.original)
        : getLevelSortValue((rowA.original as Record<string, string>)[accessorKey]);
      const b = sortValue
        ? sortValue(rowB.original)
        : getLevelSortValue((rowB.original as Record<string, string>)[accessorKey]);
      return a - b;
    },
  };
}

/**
 * Generate a pros/cons column pair.
 */
export function prosConsColumns<TData>({
  prosId,
  consId,
  prosField,
  consField,
  prosLabel = "Safety Pros",
  consLabel = "Safety Cons",
}: {
  prosId: string;
  consId: string;
  prosField: (row: TData) => string[];
  consField: (row: TData) => string[];
  prosLabel?: string;
  consLabel?: string;
}): ColumnDef<TData>[] {
  return [
    {
      id: prosId,
      accessorFn: prosField,
      header: () => <span className="text-xs">{prosLabel}</span>,
      cell: ({ row }) => <ProsCons items={prosField(row.original)} type="pro" />,
      enableSorting: false,
    },
    {
      id: consId,
      accessorFn: consField,
      header: () => <span className="text-xs">{consLabel}</span>,
      cell: ({ row }) => <ProsCons items={consField(row.original)} type="con" />,
      enableSorting: false,
    },
  ];
}
