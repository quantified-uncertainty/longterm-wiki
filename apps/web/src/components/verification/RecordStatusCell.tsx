/**
 * RecordStatusCell — Unified status indicator column for record tables.
 *
 * Combines two indicators in a narrow rightmost column:
 * - Source-check dot (verification verdict)
 * - Coverage dots (data completeness, 1-4 scale)
 *
 * Usage in HTML tables:
 *   <th> header: add an empty <th> with sr-only "Status" text
 *   <td> cell:   <RecordStatusCell verdict={...} coverageScore={3} />
 *
 * Usage in card/flex layouts:
 *   <RecordStatusCell as="inline" verdict={...} />
 */

import { RecordVerificationDot } from "./RecordVerificationDot";

// ── CoverageDots (shared, also used by organizations-table) ──────────

export function CoverageDots({
  score,
  max = 4,
  ariaLabel,
}: {
  score: number;
  max?: number;
  ariaLabel?: string;
}) {
  return (
    <span
      className="inline-flex gap-0.5"
      role="img"
      aria-label={ariaLabel ?? `Data completeness: ${score}/${max}`}
    >
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            i < score ? "bg-primary/70" : "bg-muted-foreground/20"
          }`}
        />
      ))}
    </span>
  );
}

// ── RecordStatusCell ─────────────────────────────────────────────────

interface RecordStatusCellProps {
  /** Source-check verdict (null = not checked) */
  verdict: string | null | undefined;
  /** Link to source-check detail page */
  sourceCheckHref?: string;
  /** Coverage score 1-4 (omit to hide coverage dots) */
  coverageScore?: number;
  /** Render as <td> (for tables) or <span> (for card/flex layouts) */
  as?: "td" | "inline";
}

export function RecordStatusCell({
  verdict,
  sourceCheckHref,
  coverageScore,
  as = "td",
}: RecordStatusCellProps) {
  const content = (
    <span className={`inline-flex items-center gap-2 ${as === "inline" ? "ml-auto" : ""}`}>
      {coverageScore != null && (
        <CoverageDots score={coverageScore} />
      )}
      <RecordVerificationDot
        verdict={verdict}
        href={sourceCheckHref}
        size="sm"
      />
    </span>
  );

  if (as === "td") {
    return (
      <td className="py-1.5 px-2 text-right">
        {content}
      </td>
    );
  }

  return content;
}

// ── Table header helper ──────────────────────────────────────────────

/** Empty <th> for the status column — use as the last header cell. */
export function RecordStatusHeader({ className = "" }: { className?: string }) {
  return (
    <th scope="col" className={`py-2 px-2 w-16 ${className}`}>
      <span className="sr-only">Status</span>
    </th>
  );
}
