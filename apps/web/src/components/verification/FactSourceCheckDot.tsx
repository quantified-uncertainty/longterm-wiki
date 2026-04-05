/**
 * FactSourceCheckDot — Convenience wrapper that looks up FactBase verification
 * status for a fact by ID and renders a SourceCheckDot if found.
 * Returns null when no verification data exists.
 */

import { getFactBaseFactVerification } from "@data/factbase";
import { SourceCheckDot } from "./SourceCheckDot";
import { factbaseVerdictToStatus } from "./source-check-status";

export function FactSourceCheckDot({
  factId,
  size = "sm",
  className,
}: {
  factId: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const verification = getFactBaseFactVerification(factId);
  if (!verification) return null;
  return (
    <SourceCheckDot
      status={factbaseVerdictToStatus(verification)}
      originalVerdict={verification}
      size={size}
      className={className}
    />
  );
}
