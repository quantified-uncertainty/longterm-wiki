import { Suspense } from "react";
import { EntitySourceChecksViewer } from "./entity-source-checks-viewer";
import { SourceCheckCoverageContent } from "@/app/internal/source-check-coverage/source-check-coverage-content";
import { SourceCheckTabs } from "./source-check-tabs";
import { ClaimsViewer } from "./claims-viewer";

/**
 * Consolidated source-check dashboard.
 *
 * Two tabs:
 * - Verdicts: all source-check verdicts with expandable evidence and record type filters
 * - Coverage: entity type coverage analysis and priority queue
 *
 * The FactBase tab was removed because the Verdicts tab already has record type
 * filter buttons that let users filter to FactBase-specific verdicts.
 */
export function EntitySourceChecksContent() {
  return (
    <SourceCheckTabs
      verdictsContent={
        <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading verdicts...</div>}>
          <EntitySourceChecksViewer />
        </Suspense>
      }
      coverageContent={
        <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading coverage data...</div>}>
          <SourceCheckCoverageContent />
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
