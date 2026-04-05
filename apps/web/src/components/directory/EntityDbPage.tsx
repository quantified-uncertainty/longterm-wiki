"use client";

import { Suspense } from "react";
import { EntityProfileViewer } from "@/app/internal/entity-profile/entity-profile-viewer";

/**
 * Shared component for /<directory>/<slug>/db pages.
 * Renders the EntityProfileViewer pre-loaded with the given entity slug.
 *
 * When `embedded` is true (used inside EntityDataPage), the search bar and
 * back link are hidden since the parent page already provides navigation.
 */
export function EntityDbPage({
  slug,
  backHref,
  backLabel,
  embedded,
}: {
  slug: string;
  backHref: string;
  backLabel: string;
  /** Hide search bar and back link when embedded inside EntityDataPage */
  embedded?: boolean;
}) {
  return (
    <Suspense
      fallback={
        <div className="text-sm text-muted-foreground py-8 text-center">
          Loading...
        </div>
      }
    >
      <EntityProfileViewer
        initialData={null}
        initialEntity={slug}
        backHref={embedded ? undefined : backHref}
        backLabel={embedded ? undefined : backLabel}
        hideSearch={embedded}
      />
    </Suspense>
  );
}
