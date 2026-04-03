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
  const hasPreviewContent = r.summary || r.abstract || r.keyPoints;
  if (!hasPreviewContent) return <>{children}</>;

  // Show summary if available, otherwise fall back to abstract
  const displayText = r.summary || r.abstract;

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

          {/* Summary or abstract */}
          {displayText && (
            <p className="text-muted-foreground leading-relaxed line-clamp-4">
              {displayText}
            </p>
          )}

          {/* Key points (max 3 in preview) */}
          {r.keyPoints && r.keyPoints.length > 0 && (
            <ul className="space-y-0.5 text-muted-foreground/80">
              {r.keyPoints.slice(0, 3).map((point, i) => (
                <li key={i} className="flex items-start gap-1.5 leading-relaxed">
                  <span className="text-muted-foreground/40 mt-px shrink-0">&bull;</span>
                  <span className="line-clamp-2">{point}</span>
                </li>
              ))}
              {r.keyPoints.length > 3 && (
                <li className="text-muted-foreground/40 pl-3">
                  +{r.keyPoints.length - 3} more
                </li>
              )}
            </ul>
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
