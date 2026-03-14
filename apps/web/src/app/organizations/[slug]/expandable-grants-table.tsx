"use client";

import { useState } from "react";

const INITIAL_DISPLAY_COUNT = 10;
const PAGE_SIZE = 50;

/**
 * A client-side wrapper that shows a limited number of children (table rows)
 * with progressive "show more" loading.
 *
 * `totalCount` is the full number of grants (may exceed rendered children).
 * `renderedCount` is how many children were actually server-rendered (capped
 * to keep RSC payload manageable for orgs with thousands of grants).
 */
export function ExpandableGrantsTable({
  totalCount,
  renderedCount,
  children,
}: {
  totalCount: number;
  renderedCount: number;
  children: React.ReactNode[];
}) {
  const [displayCount, setDisplayCount] = useState(INITIAL_DISPLAY_COUNT);

  const visibleChildren = children.slice(0, displayCount);
  const canShowMore = displayCount < renderedCount;
  const remaining = renderedCount - displayCount;
  const truncated = totalCount > renderedCount;

  return (
    <>
      {visibleChildren}
      {(canShowMore || displayCount > INITIAL_DISPLAY_COUNT || truncated) && (
        <tr>
          <td colSpan={4} className="py-2 text-center">
            <div className="flex items-center justify-center gap-3">
              {canShowMore && (
                <button
                  type="button"
                  onClick={() =>
                    setDisplayCount((prev) =>
                      Math.min(prev + PAGE_SIZE, renderedCount),
                    )
                  }
                  className="text-xs text-primary hover:underline cursor-pointer"
                >
                  Show {Math.min(PAGE_SIZE, remaining)} more
                </button>
              )}
              {displayCount > INITIAL_DISPLAY_COUNT && (
                <button
                  type="button"
                  onClick={() => setDisplayCount(INITIAL_DISPLAY_COUNT)}
                  className="text-xs text-muted-foreground hover:underline cursor-pointer"
                >
                  Collapse
                </button>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              Showing {Math.min(displayCount, renderedCount)} of {totalCount}
              {truncated && !canShowMore
                ? ` (top ${renderedCount} by amount)`
                : ""}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
