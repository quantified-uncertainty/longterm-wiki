"use client";

export interface PaginationControlsProps {
  /** Zero-indexed current page */
  page: number;
  /** Total number of pages */
  pageCount: number;
  /** Total number of items (before pagination, after filtering) */
  totalItems: number;
  /** Number of items per page */
  pageSize: number;
  /** Called with the new zero-indexed page number */
  onPageChange: (page: number) => void;
}

/**
 * Shared pagination controls for directory tables.
 *
 * Shows "Showing X-Y of Z items" on the left, First/Prev/Next/Last buttons
 * and "Page X of Y" on the right. Renders nothing when there is only one page.
 */
export function PaginationControls({
  page,
  pageCount,
  totalItems,
  pageSize,
  onPageChange,
}: PaginationControlsProps) {
  if (pageCount <= 1) return null;

  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, totalItems);

  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span className="tabular-nums">
        Showing {start}&ndash;{end} of {totalItems} items
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => onPageChange(0)}
          className="px-2 py-1 rounded border border-border bg-card hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          First
        </button>
        <button
          type="button"
          disabled={page === 0}
          onClick={() => onPageChange(Math.max(0, page - 1))}
          className="px-2 py-1 rounded border border-border bg-card hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Prev
        </button>
        <span className="px-2 tabular-nums">
          Page {page + 1} of {pageCount}
        </span>
        <button
          type="button"
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
          className="px-2 py-1 rounded border border-border bg-card hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next
        </button>
        <button
          type="button"
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(pageCount - 1)}
          className="px-2 py-1 rounded border border-border bg-card hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Last
        </button>
      </div>
    </div>
  );
}
