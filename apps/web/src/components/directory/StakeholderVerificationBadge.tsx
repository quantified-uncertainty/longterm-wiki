/**
 * Verification badge for policy stakeholder positions.
 *
 * Looks up the PG stakeholder ID from the build-time mapping,
 * then delegates to the standard VerificationBadge component.
 */
import { getPolicyStakeholderId, getRecordVerdict } from "@data/tablebase";
import { VerificationBadge } from "./VerificationBadge";

interface StakeholderVerificationBadgeProps {
  /** The policy entity's stableId (10-char alphanumeric) */
  policyEntityStableId: string;
  /** The stakeholder display name (must match PG stakeholderDisplayName exactly) */
  stakeholderName: string;
}

export function StakeholderVerificationBadge({
  policyEntityStableId,
  stakeholderName,
}: StakeholderVerificationBadgeProps) {
  const stakeholderId = getPolicyStakeholderId(
    policyEntityStableId,
    stakeholderName,
  );
  if (!stakeholderId) return null;

  const verdict = getRecordVerdict("policy-stakeholder", stakeholderId);
  return <VerificationBadge verdict={verdict} />;
}
