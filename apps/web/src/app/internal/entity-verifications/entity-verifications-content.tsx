import { Suspense } from "react";
import { EntityVerificationsViewer } from "./entity-verifications-viewer";
import { FactBaseVerificationsContent } from "@/app/internal/factbase-verifications/factbase-verifications-content";
import { VerificationCoverageContent } from "@/app/internal/verification-coverage/verification-coverage-content";
import { VerificationTabs } from "./verification-tabs";

/**
 * Consolidated verification dashboard.
 *
 * Combines three previously separate dashboards into tabbed sections:
 * - Verdicts (E2200): all verification verdicts with expandable evidence
 * - FactBase (E1045): FactBase-specific verification stats and table
 * - Coverage (E2100): entity type coverage analysis and priority queue
 *
 * Each tab renders the original content component — no logic was duplicated.
 */
export function EntityVerificationsContent() {
  return (
    <VerificationTabs
      verdictsContent={
        <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading verdicts...</div>}>
          <EntityVerificationsViewer />
        </Suspense>
      }
      factbaseContent={
        <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading FactBase verifications...</div>}>
          <FactBaseVerificationsContent />
        </Suspense>
      }
      coverageContent={
        <Suspense fallback={<div className="text-sm text-muted-foreground py-8 text-center">Loading coverage data...</div>}>
          <VerificationCoverageContent />
        </Suspense>
      }
    />
  );
}
