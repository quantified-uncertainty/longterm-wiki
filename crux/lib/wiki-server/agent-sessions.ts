/**
 * Agent Sessions API — wiki-server client module
 *
 * Stores and retrieves agent checklist state in PostgreSQL,
 * replacing the previous pattern of committing .claude/wip-checklist.md to git.
 * Response types are inferred from the Hono route via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { AgentSessionsRoute } from '../../../apps/wiki-server/src/routes/agent-sessions.ts';
import type {
  CreateAgentSession,
  UpdateAgentSession,
} from '../../../apps/wiki-server/src/api-types.ts';
export { PR_OUTCOMES } from '../../../apps/wiki-server/src/api-types.ts';
export type { PrOutcome } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<AgentSessionsRoute>>;

/** Shape returned by GET /by-branch/:branch (200 success). */
export type AgentSessionEntry = InferResponseType<
  RpcClient['by-branch'][':branch']['$get'],
  200
>;

/** Shape returned by GET / (200 success). */
export type AgentSessionListResponse = InferResponseType<
  RpcClient['index']['$get'],
  200
>;

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
  return apiRequest<AgentSessionEntry>('POST', '/api/agent-sessions', session, undefined, 'project');
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
  return apiRequest<AgentSessionEntry>('PATCH', `/api/agent-sessions/${id}`, updates, undefined, 'project');
}

/**
 * List recent agent sessions.
 */
export async function listAgentSessions(
  limit = 50,
): Promise<ApiResult<AgentSessionListResponse>> {
  return apiRequest<AgentSessionListResponse>(
    'GET',
    `/api/agent-sessions?limit=${limit}`,
  );
}

/**
 * Mark stale active sessions as completed (no updates for timeoutHours).
 */
export async function sweepStaleSessions(
  timeoutHours = 2,
): Promise<ApiResult<{ swept: number; sessions: Array<{ id: number; branch: string }> }>> {
  return apiRequest('POST', '/api/agent-sessions/sweep', { timeoutHours }, undefined, 'project');
}
