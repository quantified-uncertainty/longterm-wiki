import Link from "next/link";
import type { FrameworkRow, FrameworkVersionRow, DiffRow } from "@/app/frontier-safety-frameworks/frameworks-data";
import { frameworkSlug } from "@/app/frontier-safety-frameworks/frameworks-data";
import { isVerdictPublished, REVIEW_VERDICT_LABELS } from "@/app/frontier-safety-frameworks/risk-domain-constants";

export interface TimelineEntry {
  version: FrameworkVersionRow;
  framework: FrameworkRow;
  /** Diff *into* this version (`to_version_id = version.id`). */
  inboundDiff: DiffRow | null;
}

export interface TimelineViewProps {
  entries: TimelineEntry[];
}

function diffBadge(diff: DiffRow | null) {
  if (!diff) return null;
  if (isVerdictPublished(diff.reviewVerdict)) {
    if (diff.reviewVerdict === "confirmed_weakening") {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-50 text-red-800 border border-red-300 dark:bg-red-950/40 dark:text-red-200 dark:border-red-700">
          Weakening
        </span>
      );
    }
    if (diff.reviewVerdict === "confirmed_strengthening") {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-700">
          Strengthening
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-900 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-700">
        Nuanced
      </span>
    );
  }
  // Unreviewed (or other non-published verdict): neutral pill, NEVER directional.
  // This satisfies the QUA-709 acceptance criterion that unreviewed diffs
  // never display the word "weakened" / "strengthened".
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground border border-border/50">
      Pending review
    </span>
  );
}

export function TimelineView({ entries }: TimelineViewProps) {
  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground">
        No published framework versions yet.
      </div>
    );
  }

  return (
    <ol className="relative border-l-2 border-border/50 pl-5 space-y-6">
      {entries.map(({ version, framework, inboundDiff }) => {
        const slug = frameworkSlug(framework);
        const dateStr = version.publishedDate ?? version.discoveredDate;
        return (
          <li key={version.id} className="relative">
            <span className="absolute -left-[1.7rem] top-1.5 h-3 w-3 rounded-full border-2 border-border bg-background" />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-1">
              <span className="text-xs tabular-nums text-muted-foreground">
                {dateStr}
              </span>
              <Link
                href={`/frontier-safety-frameworks/${slug}`}
                className="font-medium text-foreground hover:text-primary"
              >
                {framework.shortName ?? framework.name}
              </Link>
              <span className="text-xs text-muted-foreground">
                {version.versionLabel}
              </span>
              {version.isDraft && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-900 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-200">
                  Draft
                </span>
              )}
              {diffBadge(inboundDiff)}
              {inboundDiff && (
                <span
                  className="text-[11px] text-muted-foreground/70"
                  title={REVIEW_VERDICT_LABELS[inboundDiff.reviewVerdict] ?? inboundDiff.reviewVerdict}
                >
                  ({inboundDiff.neutralChangesCount ?? 0} changes)
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {framework.org.displayName}
            </div>
            {version.summary && (
              <p className="text-sm text-foreground/80 mt-1.5 max-w-3xl leading-relaxed">
                {version.summary}
              </p>
            )}
            {inboundDiff && isVerdictPublished(inboundDiff.reviewVerdict) && (
              <p className="text-xs text-muted-foreground mt-1.5 max-w-3xl">
                <span className="font-medium text-foreground/70">
                  What changed:
                </span>{" "}
                {inboundDiff.changeSummary}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
