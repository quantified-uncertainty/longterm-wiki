/**
 * Agent Session Events API — wiki-server client module
 *
 * Appends and retrieves activity timeline events for agent sessions.
 * Each event captures a moment in the session lifecycle (checklist check,
 * error, note, status update, etc.), providing an audit trail.
 *
 * Response types are inferred from the Hono route via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { AgentSessionEventsRoute } from '../../../apps/wiki-server/src/routes/agent-session-events.ts';
import type { CreateAgentEvent } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<AgentSessionEventsRoute>>;

/** Shape returned by GET /by-agent/:agentId (200 success). */
export type AgentEventListResponse = InferResponseType<
  RpcClient['by-agent'][':agentId']['$get'],
  200
>;

/** A single event row. */
export type AgentEventEntry = AgentEventListResponse['events'][number];

/** Shape returned by POST / (201 created). */
export type AppendEventResponse = InferResponseType<
  RpcClient['index']['$post'],
  201
>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Append an event to an agent's activity timeline.
 */
export async function appendEvent(
  event: CreateAgentEvent,
): Promise<ApiResult<AppendEventResponse>> {
  return apiRequest<AppendEventResponse>('POST', '/api/agent-session-events', event);
}

/**
 * List events for a specific agent, ordered by timestamp (newest first).
 */
export async function listEvents(
  agentId: number,
  limit = 200,
): Promise<ApiResult<AgentEventListResponse>> {
  return apiRequest<AgentEventListResponse>(
    'GET',
    `/api/agent-session-events/by-agent/${agentId}?limit=${limit}`,
  );
}
