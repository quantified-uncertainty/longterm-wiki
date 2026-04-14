"use client";

/**
 * Shared column definitions for the agent-activity tables (QUA-440).
 *
 * The Slot and Linear columns render identically across the Active Agents
 * and Agent Sessions tables — same styling, same empty state, same sort
 * order, same link target. Factoring them here prevents drift.
 *
 * Source of truth for the Linear workspace URL also lives here; a
 * coordinating helper in `crux/lib/linear/client.ts` has the same value
 * for CLI-side links, but apps/web doesn't import from crux.
 */

import type { ColumnDef } from "@tanstack/react-table";
import { SortableHeader } from "@/components/ui/data-table";

const LINEAR_WORKSPACE_SLUG = "quantifieduncertainty";

export function linearIssueUrl(id: string): string {
  return `https://linear.app/${LINEAR_WORKSPACE_SLUG}/issue/${id}`;
}

/** Rows in both tables expose these two fields (after QUA-440). */
interface SlotAndLinearRow {
  slotNumber: number | null;
  linearId: string | null;
}

export function slotColumn<T extends SlotAndLinearRow>(): ColumnDef<T> {
  return {
    accessorKey: "slotNumber",
    header: ({ column }) => <SortableHeader column={column}>Slot</SortableHeader>,
    cell: ({ row }) => {
      const slot = row.original.slotNumber;
      if (slot === null || slot === undefined) {
        return <span className="text-xs text-muted-foreground/50">—</span>;
      }
      return (
        <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold text-foreground/90">
          a{slot}
        </span>
      );
    },
    sortingFn: (a, b) => (a.original.slotNumber ?? -1) - (b.original.slotNumber ?? -1),
  };
}

export function linearColumn<T extends SlotAndLinearRow>(): ColumnDef<T> {
  return {
    accessorKey: "linearId",
    header: ({ column }) => <SortableHeader column={column}>Linear</SortableHeader>,
    cell: ({ row }) => {
      const id = row.original.linearId;
      if (!id) return <span className="text-xs text-muted-foreground/50">—</span>;
      return (
        <a
          href={linearIssueUrl(id)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono text-blue-600 hover:underline"
        >
          {id}
        </a>
      );
    },
  };
}
