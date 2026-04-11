import Link from "next/link";
import { getTypedEntities, isPolicy, type PolicyEntity } from "@/data";
import { STATUS_COLORS, normalizeStatus } from "@/app/legislation/legislation-constants";
import { deriveStatus } from "@/app/legislation/legislation-utils";
import { getPolicyStakeholderId, getRecordVerdict } from "@data/tablebase";
import { getSourcingHref } from "@/app/sourcing/sourcing-shared";
import { RecordStatusDots } from "@/components/coverage/RecordStatusDots";
import { computeGenericCoverage } from "@/components/coverage/coverage-score";

export interface PersonPolicyPosition {
  policyId: string;
  policyTitle: string;
  policyStableId: string | undefined;
  stakeholderName: string;
  position: string;
  reason: string | undefined;
  statusKey: string | null;
}

/**
 * Find all policy entities where a person appears as a stakeholder or key politician.
 * Matches by entity ID or name (case-insensitive).
 */
export function getPersonPolicyPositions(
  personEntityId: string,
  personName: string,
): PersonPolicyPosition[] {
  const allEntities = getTypedEntities();
  const policies = allEntities.filter(isPolicy);
  const nameLower = personName.toLowerCase();

  const positions: PersonPolicyPosition[] = [];
  for (const policy of policies) {
    let found = false;

    // Check stakeholders first (has position + reason)
    for (const stakeholder of policy.stakeholders) {
      if (
        stakeholder.entityId === personEntityId ||
        stakeholder.name.toLowerCase() === nameLower
      ) {
        positions.push({
          policyId: policy.id,
          policyTitle: policy.title,
          policyStableId: policy.stableId,
          stakeholderName: stakeholder.name,
          position: stakeholder.position,
          reason: stakeholder.reason,
          statusKey: normalizeStatus(deriveStatus(policy)),
        });
        found = true;
        break;
      }
    }

    // Also check keyPoliticians (has role but no position/reason)
    if (!found) {
      for (const politician of policy.keyPoliticians) {
        if (
          politician.entityId === personEntityId ||
          politician.name.toLowerCase() === nameLower
        ) {
          positions.push({
            policyId: policy.id,
            policyTitle: policy.title,
            policyStableId: policy.stableId,
            stakeholderName: politician.name,
            position: "key role",
            reason: politician.role,
            statusKey: normalizeStatus(deriveStatus(policy)),
          });
          found = true;
          break;
        }
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
  "key role": "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
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
                <th scope="col" className="py-2 px-2 w-16" />
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => {
                const stakeholderId = pos.policyStableId
                  ? getPolicyStakeholderId(pos.policyStableId, pos.stakeholderName)
                  : null;
                const verdict = stakeholderId
                  ? getRecordVerdict("policy-stakeholder", stakeholderId)?.verdict
                  : undefined;
                return (
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
                  <td className="py-1.5 px-2 text-right">
                    <RecordStatusDots
                      coverageScore={computeGenericCoverage({
                        description: pos.reason,
                        filledFieldCount: (pos.position ? 1 : 0) + (pos.policyStableId ? 1 : 0),
                      })}
                      verdict={verdict}
                      sourcingHref={stakeholderId ? getSourcingHref("policy-stakeholder", stakeholderId) : undefined}
                    />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
