"use client";

import { Suspense } from "react";
import { EntityProfileViewer } from "@/app/internal/entity-profile/entity-profile-viewer";

/**
 * Shared component for /<directory>/<slug>/db pages.
 * Renders the EntityProfileViewer pre-loaded with the given entity slug.
 */
export function EntityDbPage({ slug, backHref, backLabel }: {
  slug: string;
  backHref: string;
  backLabel: string;
}) {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading...</div>}>
      <EntityProfileViewer
        initialData={null}
        initialEntity={slug}
        backHref={backHref}
        backLabel={backLabel}
      />
    </Suspense>
  );
}
