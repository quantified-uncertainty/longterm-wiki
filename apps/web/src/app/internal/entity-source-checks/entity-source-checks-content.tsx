import { Suspense } from "react";
import { EntitySourceChecksViewer } from "./entity-source-checks-viewer";
import { FactBaseSourceChecksContent } from "@/app/internal/factbase-source-checks/factbase-source-checks-content";
import { SourceCheckCoverageContent } from "@/app/internal/source-check-coverage/source-check-coverage-content";
import { SourceCheckTabs } from "./source-check-tabs";

/**
 * Consolidated source-check dashboard.
 *
 * Combines three previously separate dashboards into tabbed sections:
 * - Verdicts (E2200): all source-check verdicts with expandable evidence
 * - FactBase (E1045): FactBase-specific source-check stats and table
 * - Coverage (E2100): entity type coverage analysis and priority queue
 *
 * Each tab renders the original content component — no logic was duplicated.
 */
export function EntitySourceChecksContent() {
  return (
    <SourceCheckTabs
      verdictsContent={
        <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading verdicts...</div>}>
          <EntitySourceChecksViewer />
        </Suspense>
      }
      factbaseContent={
        <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading FactBase source checks...</div>}>
          <FactBaseSourceChecksContent />
        </Suspense>
      }
      coverageContent={
        <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading coverage data...</div>}>
          <SourceCheckCoverageContent />
        </Suspense>
      }
    />
  );
}
