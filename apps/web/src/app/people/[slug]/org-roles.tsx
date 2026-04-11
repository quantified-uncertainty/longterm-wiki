import Link from "next/link";
import { formatDateRange, fieldStr } from "@/lib/directory-utils";
import { getKBEntitySlug } from "@/data/factbase";
import { getRecordVerdict } from "@/data/tablebase";
import { CurrentBadge, FounderBadge } from "@/components/directory";
import { getSourcingHref } from "@/app/sourcing/sourcing-shared";
import { RecordStatusDots } from "@/components/coverage/RecordStatusDots";
import { computeGenericCoverage } from "@/components/coverage/coverage-score";

export interface OrgRole {
  org: { id: string; name: string; type: string };
  record: { key: string; fields: Record<string, unknown> };
}

export function OrgRoles({ orgRoles }: { orgRoles: OrgRole[] }) {
  if (orgRoles.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Organization Roles
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {orgRoles.length}
        </span>
      </h2>
      <div className="border border-border/60 rounded-xl bg-card">
        {orgRoles.map(({ org, record }) => {
          const title = fieldStr(record.fields, "title");
          const start = fieldStr(record.fields, "start");
          const end = fieldStr(record.fields, "end");
          const isFounder = !!record.fields.is_founder;
          const orgSlug = getKBEntitySlug(org.id);

          const verdict = getRecordVerdict("personnel", String(record.key));

          return (
            <div
              key={`${org.id}-${record.key}`}
              className="px-4 py-3 border-b border-border/40 last:border-b-0 relative"
            >
              <div className="absolute top-3 right-4">
                <RecordStatusDots
                  coverageScore={computeGenericCoverage({
                    filledFieldCount: (title ? 1 : 0) + (start ? 1 : 0) + (end ? 1 : 0),
                  })}
                  verdict={verdict?.verdict}
                  sourcingHref={verdict?.verdict ? getSourcingHref("personnel", String(record.key)) : undefined}
                />
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {orgSlug ? (
                  <Link
                    href={`/organizations/${orgSlug}`}
                    className="font-semibold text-sm hover:text-primary transition-colors"
                  >
                    {org.name}
                  </Link>
                ) : (
                  <span className="font-semibold text-sm">{org.name}</span>
                )}
                {isFounder && <FounderBadge />}
                {!end && <CurrentBadge />}
              </div>
              {title && (
                <div className="text-xs text-muted-foreground mt-0.5">
                  {title}
                </div>
              )}
              <div className="text-[10px] text-muted-foreground/50 mt-1">
                {formatDateRange(start, end)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
