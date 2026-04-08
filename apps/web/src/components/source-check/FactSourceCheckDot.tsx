/**
 * FactSourceCheckDot — Convenience wrapper that looks up FactBase source-check
 * status for a fact by ID and renders a SourceCheckDot if found.
 * Returns null when no source-check data exists.
 */

import { getFactBaseFactSourceCheck } from "@data/factbase";
import { SourceCheckDot } from "./SourceCheckDot";
import { factbaseVerdictToStatus } from "./source-check-status";

export function FactSourceCheckDot({
  factId,
  sourceUrl,
  size = "sm",
  className,
}: {
  factId: string;
  sourceUrl?: string | null;
  size?: "sm" | "md";
  className?: string;
}) {
  const sourceCheck = getFactBaseFactSourceCheck(factId);
  if (!sourceCheck) return null;
  return (
    <SourceCheckDot
      status={factbaseVerdictToStatus(sourceCheck)}
      originalVerdict={sourceCheck}
      sourceUrl={sourceUrl}
      size={size}
      className={className}
    />
  );
}
