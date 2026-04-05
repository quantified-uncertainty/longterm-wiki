/**
 * Related Organizations section for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { formatKBDate } from "@/components/wiki/factbase/format";
import { SectionHeader } from "./org-shared";
import type { RelatedOrg } from "./org-data";
import { getRecordVerdict } from "@data/tablebase";
import { getSourceCheckHref } from "@/app/source-checks/source-checks-shared";
import { SourceCheckDot } from "@/components/verification/SourceCheckDot";
import { recordVerdictToStatus } from "@/components/verification/source-check-status";

const MAX_RELATED = 15;

export function RelatedOrganizationsSection({
  orgs,
  parentOrgId,
}: {
  orgs: RelatedOrg[];
  parentOrgId: string;
}) {
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
              <th scope="col" className="py-2 px-1 w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {displayed.map((org, idx) => {
              const recordId = `${parentOrgId}:${org.id}`;
              const verdict = getRecordVerdict("entity-relationship", recordId)?.verdict;
              return (
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
                  <td className="py-1.5 px-1">
                    <SourceCheckDot
                      status={recordVerdictToStatus(verdict)}
                      originalVerdict={verdict}
                      size="md"
                      href={verdict ? getSourceCheckHref("entity-relationship", recordId) : undefined}
                    />
                  </td>
                </tr>
              );
            })}
            {overflow > 0 && (
              <tr>
                <td colSpan={4} className="py-2 px-3 text-center text-xs text-muted-foreground">
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
