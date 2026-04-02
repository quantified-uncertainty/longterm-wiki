/**
 * Platform Accounts API — wiki-server client module.
 *
 * Response types inferred from Hono RPC route via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { PlatformAccountsRoute } from '../../../apps/wiki-server/src/routes/tablebase/platform-accounts.ts';

type RpcClient = ReturnType<typeof hc<PlatformAccountsRoute>>;
export type LookupResult = InferResponseType<RpcClient['lookup']['$get'], 200>;
export type ByEntityResult = InferResponseType<RpcClient['by-entity'][':entityId']['$get'], 200>;

export interface SyncPlatformAccountItem {
  platform: string;
  platformUsername: string;
  platformUserId?: string | null;
  entityStableId?: string | null;
  displayName?: string | null;
  profileUrl?: string | null;
}

export async function lookupPlatformAccount(
  platform: string,
  username: string,
): Promise<ApiResult<LookupResult>> {
  return apiRequest('GET', `/api/platform-accounts/lookup?platform=${encodeURIComponent(platform)}&username=${encodeURIComponent(username)}`);
}

export async function getPlatformAccountsByEntity(
  entityStableId: string,
): Promise<ApiResult<ByEntityResult>> {
  return apiRequest('GET', `/api/platform-accounts/by-entity/${encodeURIComponent(entityStableId)}`);
}

export async function syncPlatformAccounts(
  items: SyncPlatformAccountItem[],
): Promise<ApiResult<{ upserted: number }>> {
  return apiRequest('POST', '/api/platform-accounts/sync', { items });
}

export async function getAllPlatformAccounts(
  options?: { platform?: string; unlinked?: boolean; limit?: number; offset?: number },
): Promise<ApiResult<{ accounts: Array<Record<string, unknown>>; total: number }>> {
  const params = new URLSearchParams();
  if (options?.platform) params.set('platform', options.platform);
  if (options?.unlinked) params.set('unlinked', 'true');
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest('GET', `/api/platform-accounts/all${qs ? `?${qs}` : ''}`);
}
