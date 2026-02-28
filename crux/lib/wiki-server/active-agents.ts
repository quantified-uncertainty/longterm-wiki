/**
 * Active Agents API — wiki-server client module
 *
 * Tracks currently-running Claude Code agents for live coordination.
 * Agents register on start, push status updates, and pull the list
 * of other active agents to detect conflicts.
 *
 * Response types are inferred from the Hono route via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ActiveAgentsRoute } from '../../../apps/wiki-server/src/routes/active-agents.ts';
import type {
  RegisterAgent,
  UpdateAgent,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<ActiveAgentsRoute>>;

/** Shape returned by GET / (200 success). */
export type ActiveAgentListResponse = InferResponseType<
  RpcClient['index']['$get'],
  200
>;

/** A single agent row. */
export type ActiveAgentEntry = ActiveAgentListResponse['agents'][number];

/** Conflict warnings. */
export type ActiveAgentConflict = ActiveAgentListResponse['conflicts'][number];

/** Shape returned by POST / (201 created or 200 updated). */
export type RegisterAgentResponse = InferResponseType<
  RpcClient['index']['$post'],
  201
>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Register a new agent or re-register an existing one.
 * If a record with the same sessionId already exists, it is updated.
 */
export async function registerAgent(
  agent: RegisterAgent,
): Promise<ApiResult<RegisterAgentResponse>> {
  return apiRequest<RegisterAgentResponse>('POST', '/api/active-agents', agent, undefined, 'project');
}

/**
 * List agents, optionally filtered by status.
 */
export async function listActiveAgents(
  status?: string,
  limit = 50,
): Promise<ApiResult<ActiveAgentListResponse>> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('limit', String(limit));
  return apiRequest<ActiveAgentListResponse>(
    'GET',
    `/api/active-agents?${params.toString()}`,
  );
}

/**
 * Update an agent's status, current step, files touched, etc.
 */
export async function updateAgent(
  id: number,
  updates: UpdateAgent,
): Promise<ApiResult<ActiveAgentEntry>> {
  return apiRequest<ActiveAgentEntry>('PATCH', `/api/active-agents/${id}`, updates, undefined, 'project');
}

/**
 * Send a heartbeat to indicate the agent is still alive.
 */
export async function heartbeat(
  id: number,
): Promise<ApiResult<{ ok: boolean; heartbeatAt: string }>> {
  return apiRequest<{ ok: boolean; heartbeatAt: string }>('POST', `/api/active-agents/${id}/heartbeat`, {}, undefined, 'project');
}

/**
 * Mark stale agents (no heartbeat for timeoutMinutes).
 */
export async function sweepStaleAgents(
  timeoutMinutes = 30,
): Promise<ApiResult<{ swept: number; agents: Array<{ id: number; sessionId: string }> }>> {
  return apiRequest('POST', '/api/active-agents/sweep', { timeoutMinutes }, undefined, 'project');
}
