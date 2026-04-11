import { Suspense } from "react";
import { EntitySourcingViewer } from "./entity-sourcing-viewer";
import { SourcingCoverageContent } from "@/app/internal/sourcing-coverage/sourcing-coverage-content";
import { SourcingTabs } from "./sourcing-tabs";
import { ClaimsViewer } from "./claims-viewer";

/**
 * Consolidated sourcing dashboard.
 *
 * Two tabs:
 * - Verdicts: all sourcing verdicts with expandable evidence and record type filters
 * - Coverage: entity type coverage analysis and priority queue
 *
 * The FactBase tab was removed because the Verdicts tab already has record type
 * filter buttons that let users filter to FactBase-specific verdicts.
 */
export function EntitySourcingContent() {
  return (
    <SourcingTabs
      verdictsContent={
        <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading verdicts...</div>}>
          <EntitySourcingViewer />
        </Suspense>
      }
      coverageContent={
        <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading coverage data...</div>}>
          <SourcingCoverageContent />
        </Suspense>
      }
      claimsContent={
        <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading claims...</div>}>
          <ClaimsViewer />
        </Suspense>
      }
    />
  );
}
