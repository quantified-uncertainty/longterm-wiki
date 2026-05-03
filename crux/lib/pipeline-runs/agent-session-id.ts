/**
 * Coerce the cached audit session id (a string from
 * `getCachedAuditSessionId()` because that's what's shipped on every
 * X-Agent-Session-Id header) into a number for the bigint
 * `agent_sessions.id` foreign key on `pipeline_runs`. Returns null when
 * the cache is unset or the value is non-numeric.
 *
 * Shared helper used by `withPipelineRun` so the coercion is consistent
 * across pipelines.
 */
export function parseAgentSessionId(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
