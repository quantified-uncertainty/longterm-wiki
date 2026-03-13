/**
 * Related Organizations section for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { formatKBDate } from "@/components/wiki/kb/format";
import { SectionHeader } from "./org-shared";
import type { RelatedOrg } from "./org-data";

const MAX_RELATED = 15;

export function RelatedOrganizationsSection({ orgs }: { orgs: RelatedOrg[] }) {
  if (orgs.length === 0) return null;

  const displayed = orgs.slice(0, MAX_RELATED);
  const overflow = orgs.length - displayed.length;

  return (
    <section>
      <SectionHeader title="Related Organizations" count={orgs.length} />
      <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
        {displayed.map((org, idx) => (
          <div key={`${org.id}-${idx}`} className="px-4 py-3">
            <div className="flex items-center gap-2">
              {org.slug ? (
                <Link
                  href={`/organizations/${org.slug}`}
                  className="font-semibold text-sm text-primary hover:underline"
                >
                  {org.name}
                </Link>
              ) : (
                <span className="font-semibold text-sm">{org.name}</span>
              )}
              <span className="text-[11px] text-muted-foreground/70 px-1.5 py-0.5 rounded-full bg-muted">
                {org.relationship}
              </span>
            </div>
            {org.date && (
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {formatKBDate(org.date)}
              </div>
            )}
          </div>
        ))}
        {overflow > 0 && (
          <div className="px-4 py-2.5 text-center text-xs text-muted-foreground">
            +{overflow} more
          </div>
        )}
      </div>
    </section>
  );
}
