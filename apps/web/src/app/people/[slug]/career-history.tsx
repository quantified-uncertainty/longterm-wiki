import Link from "next/link";
import { resolveEntityRef, formatDateRange } from "@/lib/directory-utils";
import { getKBEntitySlug } from "@/data/kb";
import { getRecordVerdict } from "@data/database";
import { CurrentBadge, FounderBadge } from "@/components/directory";
import { VerificationBadge } from "@/components/directory/VerificationBadge";
import type { CareerHistoryEntry } from "../people-utils";

export function CareerHistory({
  careerHistory,
}: {
  careerHistory: CareerHistoryEntry[];
}) {
  if (careerHistory.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Career History
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {careerHistory.length}
        </span>
      </h2>
      <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
        {careerHistory.map((entry) => {
          const orgRef = resolveEntityRef(entry.organization);
          const orgSlug = orgRef ? getKBEntitySlug(orgRef.id) : undefined;
          const isCurrent = !entry.endDate;
          const isFounder = /founder/i.test(entry.title);
          const verdict = getRecordVerdict("personnel", String(entry.key));

          return (
            <div key={entry.key} className="px-5 py-3.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm">{entry.title}</span>
                {isFounder && <FounderBadge />}
                {isCurrent && <CurrentBadge />}
                <VerificationBadge verdict={verdict} />
              </div>
              <div className="text-sm text-muted-foreground mt-0.5">
                {orgSlug ? (
                  <Link
                    href={`/organizations/${orgSlug}`}
                    className="hover:text-primary transition-colors"
                  >
                    {orgRef?.name ?? entry.organization}
                  </Link>
                ) : (
                  <span>{orgRef?.name ?? entry.organization}</span>
                )}
              </div>
              <div className="text-xs text-muted-foreground/60 mt-1">
                {formatDateRange(entry.startDate, entry.endDate)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
