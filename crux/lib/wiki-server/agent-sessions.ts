/**
 * Agent Sessions API — wiki-server client module
 *
 * Stores and retrieves agent checklist state in PostgreSQL,
 * replacing the previous pattern of committing .claude/wip-checklist.md to git.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type {
  CreateAgentSession,
  UpdateAgentSession,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSessionEntry {
  id: number;
  branch: string;
  task: string;
  sessionType: 'content' | 'infrastructure' | 'bugfix' | 'refactor' | 'commands';
  issueNumber: number | null;
  checklistMd: string;
  status: 'active' | 'completed';
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Create or update an agent session. If an active session already exists
 * for the given branch, it will be updated instead of creating a new one.
 */
export async function upsertAgentSession(
  session: CreateAgentSession,
): Promise<ApiResult<AgentSessionEntry>> {
  return apiRequest<AgentSessionEntry>('POST', '/api/agent-sessions', session);
}

/**
 * Get the latest agent session for a branch.
 * Returns null (via ApiResult) if no session exists.
 */
export async function getAgentSessionByBranch(
  branch: string,
): Promise<ApiResult<AgentSessionEntry>> {
  return apiRequest<AgentSessionEntry>(
    'GET',
    `/api/agent-sessions/by-branch/${encodeURIComponent(branch)}`,
  );
}

/**
 * Update an agent session's checklist or status.
 */
export async function updateAgentSession(
  id: number,
  updates: UpdateAgentSession,
): Promise<ApiResult<AgentSessionEntry>> {
  return apiRequest<AgentSessionEntry>('PATCH', `/api/agent-sessions/${id}`, updates);
}

/**
 * List recent agent sessions.
 */
export async function listAgentSessions(
  limit = 50,
): Promise<ApiResult<{ sessions: AgentSessionEntry[] }>> {
  return apiRequest<{ sessions: AgentSessionEntry[] }>(
    'GET',
    `/api/agent-sessions?limit=${limit}`,
  );
}
