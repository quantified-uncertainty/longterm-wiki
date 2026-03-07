/**
 * Centralized GitHub label constants.
 *
 * All label names used across the codebase are defined here to prevent
 * drift and enable consistent renaming. Labels use a namespaced convention:
 *   stage:*   — PR lifecycle stages
 *   block:*   — merge blockers
 *   gate:*    — review gate overrides
 *   agent:*   — agent activity tracking
 */

export const LABELS = {
  // PR lifecycle stages
  STAGE_DRAFT: 'stage:draft',
  STAGE_CI_PENDING: 'stage:ci-pending',
  STAGE_CI_FAILING: 'stage:ci-failing',
  STAGE_NEEDS_REVIEW: 'stage:needs-review',
  STAGE_CHANGES_REQUESTED: 'stage:changes-requested',
  STAGE_APPROVED: 'stage:approved',
  STAGE_MERGING: 'stage:merging',

  // Merge blockers
  BLOCK_CONFLICT: 'block:conflict',
  BLOCK_CI_RED: 'block:ci-red',
  BLOCK_UNRESOLVED_THREADS: 'block:unresolved-threads',
  BLOCK_UNCHECKED_ITEMS: 'block:unchecked-items',
  BLOCK_SECURITY_REVIEW: 'block:security-review',
  BLOCK_RULES_REVIEW: 'block:rules-review',

  // Review gate overrides
  GATE_SECURITY_OK: 'gate:security-ok',
  GATE_RULES_OK: 'gate:rules-ok',

  // Agent activity
  AGENT_WORKING: 'agent:working',
  AGENT_FILED: 'agent:filed',
} as const;

export type LabelName = (typeof LABELS)[keyof typeof LABELS];

export const STAGE_LABELS = Object.values(LABELS).filter((l) =>
  l.startsWith('stage:'),
);
export const BLOCK_LABELS = Object.values(LABELS).filter((l) =>
  l.startsWith('block:'),
);

/** Colors and descriptions for label creation/ensure. */
export const LABEL_META: Record<string, { color: string; description: string }> = {
  [LABELS.AGENT_WORKING]: {
    color: '0075ca',
    description: 'Agent actively working on this',
  },
  [LABELS.AGENT_FILED]: {
    color: 'ededed',
    description: 'Issue filed by an agent',
  },
  [LABELS.STAGE_APPROVED]: {
    color: '0e8a16',
    description: 'PR approved and ready for auto-merge',
  },
  [LABELS.GATE_SECURITY_OK]: {
    color: 'bfdadc',
    description: 'Human has reviewed CodeRabbit security findings',
  },
  [LABELS.GATE_RULES_OK]: {
    color: 'bfdadc',
    description: 'Human has reviewed protected path changes',
  },
};
