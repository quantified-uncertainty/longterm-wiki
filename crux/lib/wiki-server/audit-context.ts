/**
 * Audit-context — client-side complement to the wiki-server universal
 * audit log (QUA-442).
 *
 * Provides the X-Agent-Session-Id / X-Agent-Tool values that
 * `buildHeaders()` stamps on every crux→wiki-server request. The server
 * picks these up in `auditContextMiddleware` and propagates them to the
 * trigger via `SET LOCAL app.agent_session_id / app.agent_tool`.
 *
 * The session id is looked up once per process via
 * `primeAuditSessionId()` (called from crux.mjs). `getCachedAuditSessionId()`
 * is synchronous so `buildHeaders()` can read it without awaiting anything.
 *
 * The tool name is the current crux command (e.g. `tb.scaffold`,
 * `sourcing.recheck`) and is published via `process.env.CRUX_COMMAND`.
 * Set by `crux.mjs::main()` once the command has been parsed.
 *
 * Priming is best-effort — if the wiki-server is unreachable or no
 * agent session exists for the current branch, the cache is left as
 * null and the audit row will simply record `session_id = NULL`. This
 * never blocks the crux command from running.
 */

import { currentBranch } from '../git.ts';
import { getAgentSessionByBranch } from './agent-sessions.ts';

// `undefined` = not yet attempted, `null` = attempted and no value found
// (so `buildHeaders()` doesn't retry on every request), `string` = value
// available to ship as X-Agent-Session-Id.
let cachedSessionId: string | null | undefined = undefined;
let priming: Promise<void> | null = null;

/**
 * Attempt to prime the audit session id once for this crux process.
 * Returns the same Promise on repeat calls so concurrent callers
 * don't each kick off a lookup.
 *
 * Safe to call even when wiki-server is down: any error sets the
 * cache to null and the function returns normally.
 */
export function primeAuditSessionId(): Promise<void> {
  if (cachedSessionId !== undefined) return Promise.resolve();
  if (priming) return priming;

  priming = (async () => {
    try {
      const envId = process.env.LW_AGENT_SESSION_ID;
      if (envId && envId.length > 0) {
        cachedSessionId = envId;
        return;
      }

      // Skip the DB lookup when the CLI hasn't configured a server URL or
      // API key yet. Commands that don't use the wiki-server (e.g. local
      // validate) shouldn't pay for the lookup.
      if (!process.env.LONGTERMWIKI_SERVER_URL && !process.env.PROD_LONGTERMWIKI_SERVER_URL) {
        cachedSessionId = null;
        return;
      }

      let branch: string | null = null;
      try {
        branch = currentBranch();
      } catch {
        branch = null;
      }
      if (!branch) {
        cachedSessionId = null;
        return;
      }

      const result = await getAgentSessionByBranch(branch);
      if (result.ok && result.data && typeof result.data.id !== 'undefined') {
        cachedSessionId = String(result.data.id);
      } else {
        cachedSessionId = null;
      }
    } catch {
      cachedSessionId = null;
    } finally {
      priming = null;
    }
  })();

  return priming;
}

/** Synchronous read of the cached session id. Returns null when unset. */
export function getCachedAuditSessionId(): string | null {
  return typeof cachedSessionId === 'string' ? cachedSessionId : null;
}

/**
 * The tool name published via `process.env.CRUX_COMMAND` by crux.mjs.
 * Returns null if unset (e.g. non-crux callers of the client lib).
 */
export function getCruxToolName(): string | null {
  const raw = process.env.CRUX_COMMAND;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Test-only helper: reset the module-level cache. */
export function _resetAuditContextForTesting(): void {
  cachedSessionId = undefined;
  priming = null;
}

/** Test-only helper: seed the cache to a known value. */
export function _setAuditContextForTesting(sessionId: string | null): void {
  cachedSessionId = sessionId;
}
