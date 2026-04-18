/**
 * Agent Sessions API — wiki-server client module
 *
 * Stores and retrieves agent checklist state in PostgreSQL,
 * replacing the previous pattern of committing .claude/wip-checklist.md to git.
 * Response types are inferred from the Hono route via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { AgentSessionsRoute } from '../../../apps/wiki-server/src/routes/operational/agent-sessions.ts';
import type {
  CreateAgentSession,
  UpdateAgentSession,
} from '../../../apps/wiki-server/src/api-types.ts';

// Re-export PR outcome types so CLI commands don't need to reach into wiki-server internals
export type { PrOutcome } from '../../../apps/wiki-server/src/api-types.ts';
export { PR_OUTCOMES } from '../../../apps/wiki-server/src/api-types.ts';

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

/** Shape returned by GET /by-entity (200 success). */
export type AgentSessionsByEntityResponse = InferResponseType<
  RpcClient['by-entity']['$get'],
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

/** Shape returned by GET /by-linear/:linearId (200 success). */
export type AgentSessionsByLinearResponse = InferResponseType<
  RpcClient['by-linear'][':linearId']['$get'],
  200
>;

/**
 * QUA-440: Query active sessions claiming a Linear ID. Used by the
 * `crux linear start` DB-first dedup pre-check. `freshMinutes` bounds the
 * `updated_at` window (default 30 min, matches the active_agents stale
 * timeout).
 */
export async function getAgentSessionsByLinearId(
  linearId: string,
  freshMinutes: number = 30,
): Promise<ApiResult<AgentSessionsByLinearResponse>> {
  return apiRequest<AgentSessionsByLinearResponse>(
    'GET',
    `/api/agent-sessions/by-linear/${encodeURIComponent(linearId)}?freshMinutes=${freshMinutes}`,
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
): Promise<ApiResult<AgentSessionListResponse>> {
  return apiRequest<AgentSessionListResponse>(
    'GET',
    `/api/agent-sessions?limit=${limit}`,
  );
}

/**
 * Get sessions that touched a specific entity (by stableId).
 */
export async function getSessionsByEntity(
  entityStableId: string,
): Promise<ApiResult<AgentSessionsByEntityResponse>> {
  return apiRequest<AgentSessionsByEntityResponse>(
    'GET',
    `/api/agent-sessions/by-entity?entity_id=${encodeURIComponent(entityStableId)}`,
  );
}

/**
 * Flip stale active sessions to status='stale' (no updates for timeoutHours).
 * 'completed' is reserved for graceful-exit sessions. See QUA-221.
 */
export async function sweepStaleSessions(
  timeoutHours = 2,
): Promise<ApiResult<{ swept: number; sessions: Array<{ id: number; branch: string }> }>> {
  return apiRequest('POST', '/api/agent-sessions/sweep', { timeoutHours });
}
