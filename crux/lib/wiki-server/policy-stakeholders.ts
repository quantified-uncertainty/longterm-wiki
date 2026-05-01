/**
 * Policy Stakeholders API — wiki-server client (QUA-957 / QUA-943 Phase 1).
 *
 * Mirrors grants.ts: response types are inferred from the Hono RPC route
 * via InferResponseType<>, no raw `apiRequest<T>` with hand-written
 * generics (QUA-770).
 *
 * No production caller wires this in QUA-957 — the converter
 * (`crux/lib/research/sync-applied.ts`) targets this client's input shape,
 * but the lifecycle wiring in QUA-957 does not yet invoke `syncPolicyStakeholders`.
 * Phase 2 (real machine-writes) will be the first caller.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { PolicyStakeholdersRoute } from '../../../apps/wiki-server/src/routes/tablebase/policy-stakeholders.ts';
import type {
  SyncResponse,
  BestEffortSyncResponse,
  BestEffortRejected,
} from '../../../apps/wiki-server/src/routes/tablebase/sync-factory.ts';
import {
  VALID_POSITIONS,
  type SyncStakeholderItem,
} from '../../../apps/wiki-server/src/routes/tablebase/policy-stakeholders-schema.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<PolicyStakeholdersRoute>>;

export type PolicyStakeholdersAllResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type PolicyStakeholdersByPolicyResult = InferResponseType<
  RpcClient['by-policy'][':entityId']['$get'],
  200
>;
export type PolicyStakeholdersByStakeholderResult = InferResponseType<
  RpcClient['by-stakeholder'][':entityId']['$get'],
  200
>;
export type PolicyStakeholdersDeleteBatchResult = InferResponseType<
  RpcClient['delete-batch']['$post'],
  200
>;

// /sync is built via createSyncHandler; Hono RPC can't always infer through
// the factory body. Alias the factory's standard response shape — the same
// pattern grants.ts uses for its hand-rolled /sync.
export type PolicyStakeholdersSyncResult = SyncResponse;
/** QUA-958: response shape when posting `?mode=best_effort`. */
export type PolicyStakeholdersBestEffortResult = BestEffortSyncResponse;
export type { BestEffortRejected };

/** A single stakeholder row (from the `/all` endpoint). */
export type PolicyStakeholderRow = PolicyStakeholdersAllResult['policyStakeholders'][number];

// Re-export the input item type so callers in crux can construct payloads
// against the canonical Zod-derived shape.
export type { SyncStakeholderItem };

/** Position values accepted by the `/by-policy` filter and the sync route. */
export type PolicyStakeholderPosition = (typeof VALID_POSITIONS)[number];

// ---------------------------------------------------------------------------
// Types — sync options
// ---------------------------------------------------------------------------

export interface SyncPolicyStakeholdersOptions {
  /** Bypass server-side sourcing enforcement. Requires `forceSkipSourcingReason` for audit logging. */
  forceSkipSourcing?: boolean;
  /** Reason logged to audit when `forceSkipSourcing` is used. */
  forceSkipSourcingReason?: string;
  /**
   * Skip entity-ref FK validation (used when entities haven't synced yet).
   * The server-side handler refuses the bypass unless `skipEntityValidationReason`
   * is also supplied (epic #4017 Phase A) — this client requires both at the
   * type level so callers can't accidentally trigger a denied bypass.
   */
  skipEntityValidation?: {
    reason: string;
  };
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Fetch all policy stakeholders (paginated). */
export async function getAllPolicyStakeholders(options?: {
  limit?: number;
  offset?: number;
}): Promise<ApiResult<PolicyStakeholdersAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<PolicyStakeholdersAllResult>(
    'GET',
    `/api/policy-stakeholders/all${qs ? `?${qs}` : ''}`,
  );
}

/** Fetch stakeholders for a specific policy. */
export async function getPolicyStakeholdersByPolicy(
  policyEntityId: string,
  options?: { position?: PolicyStakeholderPosition; limit?: number; offset?: number },
): Promise<ApiResult<PolicyStakeholdersByPolicyResult>> {
  const params = new URLSearchParams();
  if (options?.position) params.set('position', options.position);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<PolicyStakeholdersByPolicyResult>(
    'GET',
    `/api/policy-stakeholders/by-policy/${encodeURIComponent(policyEntityId)}${qs ? `?${qs}` : ''}`,
  );
}

/** Fetch policies where the given entity is a stakeholder. */
export async function getPolicyStakeholdersByStakeholder(
  stakeholderEntityId: string,
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<PolicyStakeholdersByStakeholderResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<PolicyStakeholdersByStakeholderResult>(
    'GET',
    `/api/policy-stakeholders/by-stakeholder/${encodeURIComponent(stakeholderEntityId)}${qs ? `?${qs}` : ''}`,
  );
}

/**
 * Sync policy stakeholders (atomic mode).
 *
 * The sync factory currently rejects the whole batch on the first validation
 * failure. Phase 2 (QUA-955) added an opt-in best-effort mode (`?mode=best_effort`)
 * but `policy-stakeholders` does not yet set `bestEffortAllowed: true` on its
 * route config — see `apps/wiki-server/src/routes/tablebase/policy-stakeholders.ts`.
 * Until that opt-in lands, this client only exposes the atomic shape.
 */
export async function syncPolicyStakeholders(
  items: readonly SyncStakeholderItem[],
  options?: SyncPolicyStakeholdersOptions,
): Promise<ApiResult<PolicyStakeholdersSyncResult>> {
  const params = new URLSearchParams();
  if (options?.forceSkipSourcing) {
    params.set('forceSkipSourcing', 'true');
    if (options.forceSkipSourcingReason) {
      params.set('reason', options.forceSkipSourcingReason);
    }
  }
  if (options?.skipEntityValidation) {
    // Reason is required at the type level — `skipEntityValidationReason` is
    // mandatory on the server side (validate-entity-refs.ts::shouldSkipEntityValidation).
    params.set('skipEntityValidation', 'true');
    params.set('skipEntityValidationReason', options.skipEntityValidation.reason);
  }
  const qs = params.toString();
  return apiRequest<PolicyStakeholdersSyncResult>(
    'POST',
    `/api/policy-stakeholders/sync${qs ? `?${qs}` : ''}`,
    { items },
  );
}

/**
 * Sync policy stakeholders in best-effort partial-success mode (QUA-958).
 *
 * Posts `?mode=best_effort` so the route partitions per-item: validated items
 * commit, the rest land in `rejected[]` with a structured `code` (`"zod"`,
 * `"fk_missing"`, `"natural_key"`, `"sourcing_required"`, `"claim_invalid"`).
 * Returns HTTP 200 with both lists; the caller decides what to do with
 * rejections (canary policy: any `code: "zod"` aborts the whole improve-entity
 * run; `code: "fk_missing"` is recorded to followup_actions).
 *
 * The route only honours `?mode=best_effort` because it set
 * `bestEffortAllowed: true` in `policy-stakeholders.ts` — a future contributor
 * who flips that off will get back the atomic `SyncResponse` shape and any
 * client branching on `committed`/`rejected` will surface the regression as
 * a runtime type mismatch instead of silently atomic'ing.
 */
export async function syncPolicyStakeholdersBestEffort(
  items: readonly SyncStakeholderItem[],
  options?: SyncPolicyStakeholdersOptions,
): Promise<ApiResult<PolicyStakeholdersBestEffortResult>> {
  const params = new URLSearchParams();
  params.set('mode', 'best_effort');
  if (options?.forceSkipSourcing) {
    params.set('forceSkipSourcing', 'true');
    if (options.forceSkipSourcingReason) {
      params.set('reason', options.forceSkipSourcingReason);
    }
  }
  if (options?.skipEntityValidation) {
    params.set('skipEntityValidation', 'true');
    params.set('skipEntityValidationReason', options.skipEntityValidation.reason);
  }
  return apiRequest<PolicyStakeholdersBestEffortResult>(
    'POST',
    `/api/policy-stakeholders/sync?${params.toString()}`,
    { items },
  );
}

/** Delete a batch of policy stakeholders by ID. */
export async function deletePolicyStakeholderBatch(
  ids: string[],
): Promise<ApiResult<PolicyStakeholdersDeleteBatchResult>> {
  return apiRequest<PolicyStakeholdersDeleteBatchResult>(
    'POST',
    '/api/policy-stakeholders/delete-batch',
    { ids },
  );
}
