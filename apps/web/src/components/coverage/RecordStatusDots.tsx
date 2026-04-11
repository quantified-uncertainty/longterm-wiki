/**
 * RecordStatusDots — Combined coverage + sourcing indicator.
 *
 * Renders CoverageDots (pie chart) + SourcingDot (colored dot)
 * side by side. Used as the rightmost element in record tables and card layouts.
 */
import { CoverageDots } from "./CoverageDots";
import { SourcingDot } from "@/components/sourcing/SourcingDot";
import { recordVerdictToStatus } from "@/components/sourcing/sourcing-status";

interface RecordStatusDotsProps {
  /** Coverage score 1-4 (number of filled dots) */
  coverageScore: number;
  /** Source-check verdict string (null = not checked) */
  verdict: string | null | undefined;
  /** Link to sourcing detail page */
  sourcingHref?: string;
  /** Dot size for SourcingDot */
  size?: "sm" | "md";
  /** Additional CSS classes on the wrapper */
  className?: string;
}

export function RecordStatusDots({
  coverageScore,
  verdict,
  sourcingHref,
  size = "md",
  className = "",
}: RecordStatusDotsProps) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <CoverageDots score={coverageScore} />
      <SourcingDot
        status={recordVerdictToStatus(verdict)}
        originalVerdict={verdict}
        size={size}
        href={sourcingHref}
      />
    </span>
  );
}
