/**
 * Audit-log API client (QUA-442). Talks to `/api/audit-log/*` on
 * wiki-server; served by `apps/wiki-server/src/routes/operational/audit-log.ts`.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { AuditLogRoute } from '../../../apps/wiki-server/src/routes/operational/audit-log.ts';

type RpcClient = ReturnType<typeof hc<AuditLogRoute>>;

/** Shape returned by GET /recent (200 success). */
export type AuditRecentResponse = InferResponseType<
  RpcClient['recent']['$get'],
  200
>;

export interface AuditRecentOptions {
  table?: string;
  session?: string;
  txn?: string;
  since?: string;
  limit?: number;
}

export async function listRecentAuditEntries(
  opts: AuditRecentOptions = {},
): Promise<ApiResult<AuditRecentResponse>> {
  const params = new URLSearchParams();
  if (opts.table) params.set('table', opts.table);
  if (opts.session) params.set('session', opts.session);
  if (opts.txn) params.set('txn', opts.txn);
  if (opts.since) params.set('since', opts.since);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const path = `/api/audit-log/recent${qs ? `?${qs}` : ''}`;
  return apiRequest<AuditRecentResponse>('GET', path);
}
