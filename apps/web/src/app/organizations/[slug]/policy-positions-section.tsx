import Link from "next/link";
import { SectionHeader } from "./org-shared";
import { getTypedEntities, isPolicy, type PolicyEntity } from "@/data";
import { STATUS_COLORS, normalizeStatus } from "@/app/legislation/legislation-constants";
import { deriveStatus } from "@/app/legislation/legislation-utils";

export interface OrgPolicyPosition {
  policyId: string;
  policyTitle: string;
  position: string;
  reason: string | undefined;
  statusKey: string | null;
}

/**
 * Find all policy entities where an organization appears as a stakeholder.
 */
export function getOrgPolicyPositions(orgEntityId: string, orgName: string): OrgPolicyPosition[] {
  const allEntities = getTypedEntities();
  const policies = allEntities.filter(isPolicy);

  const positions: OrgPolicyPosition[] = [];
  for (const policy of policies) {
    for (const stakeholder of policy.stakeholders) {
      // Match by entity ID or name
      if (stakeholder.entityId === orgEntityId || stakeholder.name.toLowerCase() === orgName.toLowerCase()) {
        positions.push({
          policyId: policy.id,
          policyTitle: policy.title,
          position: stakeholder.position,
          reason: stakeholder.reason,
          statusKey: normalizeStatus(deriveStatus(policy)),
        });
        break; // Don't double-count
      }
    }
  }

  return positions;
}

const POSITION_COLORS: Record<string, string> = {
  support: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  oppose: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  neutral: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  mixed: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
};

export function PolicyPositionsSection({
  positions,
}: {
  positions: OrgPolicyPosition[];
}) {
  if (positions.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Policy Positions" count={positions.length} />
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Policy</th>
              <th className="text-left py-2 px-3 font-medium">Position</th>
              <th className="text-left py-2 px-3 font-medium">Status</th>
              <th className="text-left py-2 px-3 font-medium">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {positions.map((pos) => (
              <tr key={pos.policyId} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <Link
                    href={`/legislation/${pos.policyId}`}
                    className="text-primary hover:underline font-medium"
                  >
                    {pos.policyTitle}
                  </Link>
                </td>
                <td className="py-2 px-3">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${
                      POSITION_COLORS[pos.position] ?? "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {pos.position}
                  </span>
                </td>
                <td className="py-2 px-3">
                  {pos.statusKey ? (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${
                        STATUS_COLORS[pos.statusKey] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {pos.statusKey}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>
                <td className="py-2 px-3 text-muted-foreground text-xs max-w-xs">
                  {pos.reason ?? <span className="text-muted-foreground/40">&mdash;</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
