/**
 * RecordStatusDots — Combined coverage + source-check indicator.
 *
 * Renders CoverageDots (data completeness) + SourceCheckDot (verification status)
 * side by side. Used as the rightmost element in record tables and card layouts.
 */
import { CoverageDots } from "./CoverageDots";
import { SourceCheckDot } from "@/components/verification/SourceCheckDot";
import { recordVerdictToStatus } from "@/components/verification/source-check-status";

interface RecordStatusDotsProps {
  /** Coverage score 1-4 (number of filled dots) */
  coverageScore: number;
  /** Source-check verdict string (null = not checked) */
  verdict: string | null | undefined;
  /** Link to source-check detail page */
  sourceCheckHref?: string;
  /** Dot size for SourceCheckDot */
  size?: "sm" | "md";
  /** Additional CSS classes on the wrapper */
  className?: string;
}

export function RecordStatusDots({
  coverageScore,
  verdict,
  sourceCheckHref,
  size = "md",
  className = "",
}: RecordStatusDotsProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <CoverageDots score={coverageScore} />
      <span className="w-px h-2.5 bg-border/60 shrink-0" aria-hidden="true" />
      <SourceCheckDot
        status={recordVerdictToStatus(verdict)}
        originalVerdict={verdict}
        size={size}
        href={sourceCheckHref}
      />
    </span>
  );
}
