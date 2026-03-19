"use client";

import { useState, type ReactNode } from "react";
import type { OrgResourceRow } from "@/app/organizations/[slug]/org-data";

/**
 * Hover preview wrapper for a resource.
 * Shows summary, abstract, and key metadata in a tooltip-like popover.
 * Wraps its children (typically the title link).
 */
export function ResourcePreview({
  resource: r,
  children,
}: {
  resource: OrgResourceRow;
  children: ReactNode;
}) {
  const [show, setShow] = useState(false);

  // Only show preview if there's meaningful content to display
  const hasPreviewContent = r.summary;
  if (!hasPreviewContent) return <>{children}</>;

  return (
    <div
      className="relative inline"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div className="absolute z-50 left-0 top-full mt-1 w-80 max-w-[90vw] p-3 bg-popover border border-border rounded-lg shadow-lg text-xs space-y-2 pointer-events-none">
          {/* Source + date */}
          <div className="flex items-center gap-2 text-muted-foreground/70">
            {r.publicationName && <span className="italic">{r.publicationName}</span>}
            {!r.publicationName && r.domain && <span>{r.domain}</span>}
            {r.publishedDate && <span className="tabular-nums">{r.publishedDate.slice(0, 10)}</span>}
          </div>

          {/* Summary */}
          {r.summary && (
            <p className="text-muted-foreground leading-relaxed line-clamp-4">
              {r.summary}
            </p>
          )}

          {/* Authors */}
          {r.authors.length > 0 && (
            <div className="text-[11px] text-muted-foreground/60">
              By {r.authors.slice(0, 5).map((a) => a.name).join(", ")}
              {r.authors.length > 5 && ` +${r.authors.length - 5}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
