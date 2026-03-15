/**
 * Related Organizations section for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { formatKBDate } from "@/components/wiki/factbase/format";
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
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">Organization</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Relationship</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {displayed.map((org, idx) => (
              <tr key={`${org.id}-${idx}`} className="hover:bg-muted/20 transition-colors">
                <td className="py-1.5 px-3">
                  {org.slug ? (
                    <Link
                      href={`/organizations/${org.slug}`}
                      className="font-medium text-foreground hover:text-primary transition-colors"
                    >
                      {org.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{org.name}</span>
                  )}
                </td>
                <td className="py-1.5 px-3 text-muted-foreground">{org.relationship}</td>
                <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap text-xs">
                  {org.date ? formatKBDate(org.date) : ""}
                </td>
              </tr>
            ))}
            {overflow > 0 && (
              <tr>
                <td colSpan={3} className="py-2 px-3 text-center text-xs text-muted-foreground">
                  +{overflow} more
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
