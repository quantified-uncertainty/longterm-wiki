import Link from "next/link";
import { getTypedEntities, isPolicy, type PolicyEntity } from "@/data";
import { STATUS_COLORS, normalizeStatus } from "@/app/legislation/legislation-constants";
import { deriveStatus } from "@/app/legislation/legislation-utils";

export interface PersonPolicyPosition {
  policyId: string;
  policyTitle: string;
  position: string;
  reason: string | undefined;
  statusKey: string | null;
}

/**
 * Find all policy entities where a person appears as a stakeholder.
 * Matches by entity ID or name (case-insensitive).
 */
export function getPersonPolicyPositions(
  personEntityId: string,
  personName: string,
): PersonPolicyPosition[] {
  const allEntities = getTypedEntities();
  const policies = allEntities.filter(isPolicy);

  const positions: PersonPolicyPosition[] = [];
  for (const policy of policies) {
    for (const stakeholder of policy.stakeholders) {
      if (
        stakeholder.entityId === personEntityId ||
        stakeholder.name.toLowerCase() === personName.toLowerCase()
      ) {
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
  positions: PersonPolicyPosition[];
}) {
  if (positions.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Policy Positions
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {positions.length} {positions.length === 1 ? "policy" : "policies"}
        </span>
      </h2>
      <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30">
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Policy
                </th>
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Position
                </th>
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Status
                </th>
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Reason
                </th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => (
                <tr
                  key={pos.policyId}
                  className="border-b border-border/30 last:border-b-0 hover:bg-muted/20 transition-colors"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/legislation/${pos.policyId}`}
                      className="text-primary hover:underline font-medium"
                    >
                      {pos.policyTitle}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${
                        POSITION_COLORS[pos.position] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {pos.position}
                    </span>
                  </td>
                  <td className="px-4 py-3">
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
                  <td className="px-4 py-3 text-muted-foreground text-xs max-w-xs">
                    {pos.reason ?? (
                      <span className="text-muted-foreground/40">&mdash;</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
