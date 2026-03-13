"use client";

import { useState } from "react";

const INITIAL_DISPLAY_COUNT = 10;

/**
 * A client-side wrapper that shows a limited number of children (table rows)
 * with an expand/collapse toggle button.
 */
export function ExpandableGrantsTable({
  totalCount,
  children,
}: {
  totalCount: number;
  children: React.ReactNode[];
}) {
  const [expanded, setExpanded] = useState(false);

  const visibleChildren = expanded
    ? children
    : children.slice(0, INITIAL_DISPLAY_COUNT);

  const hasMore = totalCount > INITIAL_DISPLAY_COUNT;

  return (
    <>
      {visibleChildren}
      {hasMore && (
        <tr>
          <td colSpan={4} className="py-2 text-center">
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="text-xs text-primary hover:underline cursor-pointer"
            >
              {expanded
                ? "Show fewer"
                : `Show all ${totalCount} grants`}
            </button>
          </td>
        </tr>
      )}
    </>
  );
}
