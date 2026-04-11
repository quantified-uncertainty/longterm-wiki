/**
 * FactSourcingDot — Convenience wrapper that looks up FactBase sourcing
 * status for a fact by ID and renders a SourcingDot if found.
 * Returns null when no sourcing data exists.
 */

import { getFactBaseFactSourcing } from "@data/factbase";
import { SourcingDot } from "./SourcingDot";
import { factbaseVerdictToStatus } from "./sourcing-status";

export function FactSourcingDot({
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
  const sourcing = getFactBaseFactSourcing(factId);
  if (!sourcing) return null;
  return (
    <SourcingDot
      status={factbaseVerdictToStatus(sourcing)}
      originalVerdict={sourcing}
      sourceUrl={sourceUrl}
      size={size}
      className={className}
    />
  );
}
