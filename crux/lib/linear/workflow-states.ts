/**
 * Linear workflow-state IDs for the Quantifieduncertainty (QUA) team.
 *
 * These IDs are team-scoped and stable as long as the workflow states
 * aren't renamed or deleted in Linear. If the team restructures states,
 * run `crux linear states refresh` to re-fetch them.
 *
 * Verified from Linear API on 2026-04-10 for team
 * `12392162-e1e0-4fce-95ad-a8a5d6800321`.
 */

import { linearGraphQL } from './client.ts';

export const QUA_TEAM_ID = '12392162-e1e0-4fce-95ad-a8a5d6800321';

/** Canonical workflow-state names used across the agent pipeline. */
export type WorkflowStateName =
  | 'Backlog'
  | 'Todo'
  | 'In Progress'
  | 'In Review'
  | 'Done'
  | 'Canceled'
  | 'Duplicate';

/**
 * Known workflow-state IDs for the QUA team.
 *
 * Keep in sync with `WorkflowStateName`. These are referenced by name from
 * skills so the IDs never leak into bash — the type catches typos.
 */
export const QUA_WORKFLOW_STATES: Record<WorkflowStateName, string> = {
  Backlog: '1c823bc3-04f6-4da6-b427-c8c998eb18af',
  Todo: '652fb991-4ab1-45a7-bf47-7d335eddc341',
  'In Progress': '1cafee7f-1921-49d4-b603-df2bf517b296',
  'In Review': 'c5624b71-8565-446b-917f-df7b5e2a3711',
  Done: '58ff8def-1f49-4900-af99-84544c20b5f8',
  Canceled: '4ee037f7-12ea-43cb-bd1a-967b8c76e256',
  Duplicate: 'a8d4a298-2688-4236-83ce-e3c98effd033',
};

export function getWorkflowStateId(name: WorkflowStateName): string {
  const id = QUA_WORKFLOW_STATES[name];
  if (!id) {
    throw new Error(
      `Unknown Linear workflow state: "${name}". ` +
      `Known: ${Object.keys(QUA_WORKFLOW_STATES).join(', ')}`
    );
  }
  return id;
}

/**
 * Linear state `type` values that represent an active (non-terminal) ticket.
 * Allowlist so unknown/future state types fail safe as "not open" — better to
 * re-file a ticket than to accidentally comment on something terminal-looking.
 *
 * Callers across the codebase (wellness dedup, audit auto-close, etc.) must
 * agree on what "open" means or their decisions diverge on edge cases.
 */
export const OPEN_STATE_TYPES = new Set(['triage', 'backlog', 'unstarted', 'started']);

export function isOpenStateType(type: string): boolean {
  return OPEN_STATE_TYPES.has(type);
}

export interface RemoteWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
}

/**
 * Fetch the current workflow states for the QUA team from Linear.
 *
 * Used by `crux linear states refresh` to regenerate this file's constants
 * if Linear is reconfigured. This is read-only; the caller writes the
 * updated file.
 */
export async function fetchRemoteWorkflowStates(
  teamId: string = QUA_TEAM_ID,
): Promise<RemoteWorkflowState[]> {
  const data = await linearGraphQL<{
    team: { states: { nodes: RemoteWorkflowState[] } };
  }>(
    `query TeamStates($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name type position } }
      }
    }`,
    { teamId },
  );
  return data.team.states.nodes;
}
