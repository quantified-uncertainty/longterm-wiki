"use client";

/**
 * Column factory for TransitionModelTableClient.
 *
 * Replaces three near-identical create*Columns functions with a single
 * configurable factory that takes tier-specific settings.
 */

import type { ColumnDef } from "@tanstack/react-table";
import { SortableHeader } from "@/components/ui/data-table";
import type { SubItemRow } from "./TransitionModelTableClient";
import {
  ParamLink,
  RatingCell,
  CombinedParentBadge,
  ExpandButton,
  ViewActionLink,
} from "./TransitionModelHelpers";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Map parent IDs to display categories. */
export const parentCategories: Record<string, "ai" | "society"> = {
  "misalignment-potential": "ai",
  "ai-capabilities": "ai",
  "ai-uses": "ai",
  "ai-ownership": "ai",
  "civ-competence": "society",
  "transition-turbulence": "society",
  "misuse-potential": "society",
};

// ============================================================================
// COLUMN FACTORY
// ============================================================================

interface ColumnConfig {
  tier: "cause" | "intermediate" | "effect";
  parentHeader: string;
  /** Render parent cell — if not provided, uses a simple colored badge. */
  parentCell?: (parent: string, parentId: string) => React.ReactNode;
  /** Whether to include rating columns (changeability, uncertainty, xrisk, trajectory). */
  includeRatings?: boolean;
  /** Hover color for the view action link. */
  actionHoverColor: string;
}

/** Create columns for a transition model table section. */
export function createColumns(
  expandedRows: Set<string>,
  toggleRow: (id: string) => void,
  config: ColumnConfig
): ColumnDef<SubItemRow>[] {
  const columns: ColumnDef<SubItemRow>[] = [
    // Expand button
    {
      id: "expand",
      header: () => <span className="w-6" />,
      cell: ({ row }) => (
        <ExpandButton
          isExpanded={expandedRows.has(row.original.subItem)}
          onClick={() => toggleRow(row.original.subItem)}
          hasDescription={!!row.original.description}
        />
      ),
      size: 40,
    },
    // Parameter name
    {
      accessorKey: "subItem",
      header: ({ column }) => (
        <SortableHeader column={column}>Parameter</SortableHeader>
      ),
      cell: ({ row }) => (
        <ParamLink
          href={row.original.href}
          tier={config.tier}
          isHighPriority={
            config.includeRatings !== false
              ? (row.original.ratings?.xriskImpact ?? 0) > 70
              : undefined
          }
        >
          {row.getValue("subItem")}
        </ParamLink>
      ),
    },
    // Parent column
    {
      accessorKey: "parent",
      header: ({ column }) => (
        <SortableHeader column={column}>{config.parentHeader}</SortableHeader>
      ),
      cell: ({ row }) => {
        if (config.parentCell) {
          return config.parentCell(row.getValue("parent"), row.original.parentId);
        }
        return row.getValue("parent");
      },
    },
  ];

  // Rating columns (optional — causes and intermediates have them, effects don't)
  if (config.includeRatings !== false) {
    columns.push(
      {
        id: "changeability",
        accessorFn: (row) => row.ratings?.changeability,
        header: ({ column }) => (
          <SortableHeader column={column}>Changeability</SortableHeader>
        ),
        cell: ({ row }) => (
          <RatingCell
            value={row.original.ratings?.changeability}
            colorType="green"
          />
        ),
      },
      {
        id: "uncertainty",
        accessorFn: (row) => row.ratings?.uncertainty,
        header: ({ column }) => (
          <SortableHeader column={column}>Uncertainty</SortableHeader>
        ),
        cell: ({ row }) => (
          <RatingCell
            value={row.original.ratings?.uncertainty}
            colorType="gray"
          />
        ),
      },
      {
        id: "xriskImpact",
        accessorFn: (row) => row.ratings?.xriskImpact,
        header: ({ column }) => (
          <SortableHeader column={column}>X-Risk</SortableHeader>
        ),
        cell: ({ row }) => (
          <RatingCell
            value={row.original.ratings?.xriskImpact}
            colorType="red"
          />
        ),
      },
      {
        id: "trajectoryImpact",
        accessorFn: (row) => row.ratings?.trajectoryImpact,
        header: ({ column }) => (
          <SortableHeader column={column}>Trajectory</SortableHeader>
        ),
        cell: ({ row }) => (
          <RatingCell
            value={row.original.ratings?.trajectoryImpact}
            colorType="blue"
          />
        ),
      }
    );
  }

  // Actions column
  columns.push({
    id: "actions",
    header: () => null,
    cell: ({ row }) => (
      <ViewActionLink href={row.original.href} hoverColor={config.actionHoverColor} />
    ),
    size: 70,
  });

  return columns;
}
