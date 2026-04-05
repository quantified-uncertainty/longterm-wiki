/**
 * OfficeHistory — shows a politician's office history as a vertical timeline.
 *
 * Server component that accepts pre-fetched office data as props.
 * Current offices are highlighted; former offices are dimmed.
 *
 * Usage:
 *   import { OfficeHistory, fetchPoliticalOffices } from "@/components/political";
 *   const offices = await fetchPoliticalOffices(entityId);
 *   <OfficeHistory offices={offices} />
 */

import { cn } from "@/lib/utils";
import { safeHref } from "@/lib/format-compact";
import { SourceCheckDot } from "@/components/verification/SourceCheckDot";
import type { PoliticalOffice } from "./types";

// ── Status styling ───────────────────────────────────────────────────

const STATUS_STYLES: Record<
  string,
  { badge: string; dot: string; label: string }
> = {
  incumbent: {
    badge:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    dot: "bg-emerald-500",
    label: "Current",
  },
  candidate: {
    badge:
      "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    dot: "bg-blue-500",
    label: "Candidate",
  },
  former: {
    badge:
      "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400",
    dot: "bg-gray-400",
    label: "Former",
  },
};

function getStatusStyle(status: string) {
  return (
    STATUS_STYLES[status] ?? {
      badge:
        "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400",
      dot: "bg-gray-400",
      label: titleCase(status),
    }
  );
}

// ── Party styling ────────────────────────────────────────────────────

const PARTY_STYLES: Record<string, string> = {
  democratic:
    "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  republican:
    "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  independent:
    "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
};

function partyBadgeClass(party: string | null): string | null {
  if (!party) return null;
  return (
    PARTY_STYLES[party.toLowerCase()] ??
    "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400"
  );
}

// ── Label formatting ─────────────────────────────────────────────────

const OFFICE_TYPE_LABELS: Record<string, string> = {
  senator: "Senator",
  representative: "Representative",
  governor: "Governor",
  state_senator: "State Senator",
  state_representative: "State Representative",
  attorney_general: "Attorney General",
};

function officeTypeLabel(officeType: string): string {
  return OFFICE_TYPE_LABELS[officeType] ?? titleCase(officeType);
}

function titleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatJurisdiction(jurisdiction: string, district: string | null): string {
  const base = titleCase(jurisdiction);
  if (district) return `${base}, ${district}`;
  return base;
}

function formatTermDates(
  termStart: string | null,
  termEnd: string | null,
  status: string
): string {
  if (!termStart) return "";
  const start = termStart;
  if (termEnd) {
    return `${start} \u2013 ${termEnd}`;
  }
  if (status === "incumbent") {
    return `${start} \u2013 present`;
  }
  // No end date and not incumbent — just show the start date
  return start;
}

// ── Sort offices ─────────────────────────────────────────────────────

function sortOffices(offices: PoliticalOffice[]): PoliticalOffice[] {
  const statusOrder: Record<string, number> = {
    incumbent: 0,
    candidate: 1,
    former: 2,
  };

  return [...offices].sort((a, b) => {
    // Current offices first
    const aOrder = statusOrder[a.status] ?? 3;
    const bOrder = statusOrder[b.status] ?? 3;
    if (aOrder !== bOrder) return aOrder - bOrder;

    // Then by term start date descending (most recent first)
    const aStart = a.termStart ?? "";
    const bStart = b.termStart ?? "";
    return bStart.localeCompare(aStart);
  });
}

// ── Component ────────────────────────────────────────────────────────

export interface OfficeHistoryProps {
  offices: PoliticalOffice[];
}

export function OfficeHistory({ offices }: OfficeHistoryProps) {
  if (offices.length === 0) return null;

  const sorted = sortOffices(offices);

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Office History
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {offices.length}{" "}
          {offices.length === 1 ? "position" : "positions"}
        </span>
      </h2>
      <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
        {/* Timeline */}
        <div className="relative">
          {sorted.map((office, i) => {
            const isLast = i === sorted.length - 1;
            const isCurrent = office.status === "incumbent";
            const style = getStatusStyle(office.status);

            return (
              <div
                key={office.id}
                className={cn(
                  "relative flex gap-4 px-4 py-3",
                  !isLast && "border-b border-border/30",
                  !isCurrent && "opacity-60"
                )}
              >
                {/* Timeline dot and line */}
                <div className="flex flex-col items-center pt-1.5 shrink-0">
                  <div
                    className={cn("w-2.5 h-2.5 rounded-full", style.dot)}
                  />
                  {!isLast && (
                    <div className="w-px flex-1 bg-border/60 mt-1" />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">
                      {officeTypeLabel(office.officeType)}
                    </span>
                    <SourceCheckDot status="not_run" size="md" />
                    <span
                      className={cn(
                        "inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold",
                        style.badge
                      )}
                    >
                      {style.label}
                    </span>
                    {office.party && (
                      <span
                        className={cn(
                          "inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold",
                          partyBadgeClass(office.party)
                        )}
                      >
                        {titleCase(office.party)}
                      </span>
                    )}
                  </div>

                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatJurisdiction(office.jurisdiction, office.district)}
                  </div>

                  {(office.termStart || office.termEnd) && (
                    <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                      {formatTermDates(
                        office.termStart,
                        office.termEnd,
                        office.status
                      )}
                    </div>
                  )}

                  {office.notes && (
                    <p className="mt-1 text-xs text-muted-foreground/80">
                      {office.notes}
                    </p>
                  )}

                  {office.sourceUrl && (
                    <a
                      href={safeHref(office.sourceUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-1 text-xs text-primary hover:underline"
                    >
                      Source
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
