import { Suspense } from "react";
import { EntityProfileViewer } from "./entity-profile-viewer";

// ── Content Component ──────────────────────────────────────────────────────

/**
 * Server component rendered via MDX stub at /wiki/E1929.
 * The EntityProfileViewer handles all interactivity client-side,
 * including entity search and data fetching via the proxy API route.
 *
 * Wrapped in Suspense because EntityProfileViewer uses useSearchParams()
 * which requires a Suspense boundary for SSG/SSR.
 */
export function EntityProfileContent() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading...</div>}>
      <EntityProfileViewer
        initialData={null}
        initialEntity=""
      />
    </Suspense>
  );
}
