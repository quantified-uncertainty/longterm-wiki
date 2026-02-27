"use client";

import Link from "next/link";
import { FileText } from "lucide-react";
import type { PageReferenceRow } from "@wiki-server/api-response-types";

export type PageReference = PageReferenceRow;

export function ClaimPageReferences({
  references,
}: {
  references: PageReference[];
}) {
  if (!references || references.length === 0) {
    return <p className="text-sm text-muted-foreground">No page references found.</p>;
  }

  return (
    <div className="space-y-1">
      {references.map((ref) => (
        <div key={ref.id} className="flex items-center gap-2 text-sm">
          <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Link
            href={`/docs/${ref.pageId}`}
            className="text-blue-600 hover:underline truncate"
          >
            {ref.pageId}
          </Link>
          {ref.footnote != null && (
            <span className="text-muted-foreground text-xs">[{ref.footnote}]</span>
          )}
          {ref.section && (
            <span className="text-muted-foreground text-xs truncate">
              &sect; {ref.section}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
