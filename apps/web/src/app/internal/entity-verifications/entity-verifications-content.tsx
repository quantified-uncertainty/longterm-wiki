import { Suspense } from "react";
import { EntityVerificationsViewer } from "./entity-verifications-viewer";

/**
 * Server component rendered via MDX stub at /wiki/E1992.
 * The viewer handles all interactivity client-side, including entity search
 * and data fetching via the proxy API route.
 */
export function EntityVerificationsContent() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading...</div>}>
      <EntityVerificationsViewer />
    </Suspense>
  );
}
