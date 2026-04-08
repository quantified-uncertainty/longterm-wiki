/**
 * RecordStatusDots — Combined coverage + source-check indicator.
 *
 * Renders CoverageDots (pie chart) + SourceCheckDot (colored dot)
 * side by side. Used as the rightmost element in record tables and card layouts.
 */
import { CoverageDots } from "./CoverageDots";
import { SourceCheckDot } from "@/components/source-check/SourceCheckDot";
import { recordVerdictToStatus } from "@/components/source-check/source-check-status";

interface RecordStatusDotsProps {
  /** Coverage score 1-4 (number of filled dots) */
  coverageScore: number;
  /** Source-check verdict string (null = not checked) */
  verdict: string | null | undefined;
  /** Link to source-check detail page */
  sourcingHref?: string;
  /** Dot size for SourceCheckDot */
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
      <SourceCheckDot
        status={recordVerdictToStatus(verdict)}
        originalVerdict={verdict}
        size={size}
        href={sourcingHref}
      />
    </span>
  );
}
