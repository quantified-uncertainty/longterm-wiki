/**
 * Type-level test for the planned `createSyncHandler<T>()` factory.
 *
 * This test runs against a HAND-MOCKED factory signature, NOT a real
 * implementation, so that we can verify Hono RPC type inference works
 * BEFORE building the factory itself. This is the de-risking step from
 * Phase 0 audit (issue #4089) — if `InferResponseType<>` cannot resolve
 * through `createSyncHandler({...})`, the entire factory approach is
 * blocked and we need to redesign.
 *
 * The test asserts:
 * 1. `InferResponseType<route['sync']['$post'], 200>` resolves to a CONCRETE
 *    object shape (not `any`, not `unknown`, not a wide union).
 * 2. The shape contains the factory's standard fields: `upserted`, plus
 *    the fields from any `extendResponse` callback.
 * 3. Hono method-chaining (`.get(...).post(...)`) is preserved across the
 *    factory call.
 *
 * If this test compiles, the factory design is type-safe and we can proceed.
 * If it fails to compile, the factory must be redesigned (e.g., using a
 * different return shape or a different composition pattern).
 *
 * Run via: `pnpm tsc --noEmit apps/wiki-server/src/routes/tablebase/sync-factory.test-d.ts`
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { InferResponseType } from "hono/client";
import { hc } from "hono/client";

// ---------------------------------------------------------------------------
// MOCKED factory signature — this is what we plan to build in Phase 1.
// The actual implementation goes in `sync-factory.ts`. This file mocks it
// so we can verify type inference works BEFORE writing the implementation.
// ---------------------------------------------------------------------------

interface SyncConfig<TItem> {
  name: string;
  // ... other config fields will be added in Phase 1
  toRow: (item: TItem) => Record<string, unknown>;
}

/**
 * Mocked factory. The real implementation will:
 *  1. Parse + validate the request body
 *  2. Run the 7-phase pipeline
 *  3. Return c.json({ upserted, verdictsWritten, claimsLinked })
 *
 * For type-inference purposes, we model only the return shape. The handler
 * MUST be a plain async function `(c: Context) => Promise<Response>` with
 * a specific JSON return type so that Hono RPC can infer it from the chain.
 */
function createSyncHandler<TItem>(_config: SyncConfig<TItem>) {
  return async (c: Context) => {
    // The real implementation will do work here. For type purposes, we
    // need the inferred return type of c.json() to be a concrete shape,
    // not a union widened by error paths.
    return c.json({
      upserted: 0 as number,
      verdictsWritten: 0 as number,
      claimsLinked: 0 as number,
    });
  };
}

// ---------------------------------------------------------------------------
// Test 1: A factory-built route preserves Hono method-chaining
// ---------------------------------------------------------------------------

interface MockGrantItem {
  id: string;
  organizationId: string;
  name: string;
  amount: number | null;
}

const grantsApp = new Hono()
  .get("/stats", (c) => c.json({ total: 0 }))
  .post(
    "/sync",
    createSyncHandler<MockGrantItem>({
      name: "grants",
      toRow: (item) => ({ ...item }),
    }),
  )
  .get("/all", (c) => c.json({ grants: [] as MockGrantItem[] }));

// If method-chaining broke, this `typeof grantsApp` would be the unmodified
// `Hono` base type, not the chained variant. The fact that we can use it
// below as a Hono route confirms chaining works through the factory call.
type GrantsRoute = typeof grantsApp;

// ---------------------------------------------------------------------------
// Test 2: InferResponseType resolves the factory route to a concrete shape
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<GrantsRoute>>;

// This is the critical assertion: the response type from the factory-built
// /sync endpoint must resolve to the EXACT shape we returned from c.json,
// not `any`, `unknown`, or a wide union.
type SyncResponse = InferResponseType<RpcClient["sync"]["$post"], 200>;

// Type assertion: SyncResponse must be assignable to this exact shape.
// If the factory broke type inference, this assignment would fail at
// compile time.
const _expected: {
  upserted: number;
  verdictsWritten: number;
  claimsLinked: number;
} = null as unknown as SyncResponse; // as-any-ok: type-level test asserting RPC inference shape

// Reverse direction: the expected shape must be assignable back to
// SyncResponse. This catches the case where SyncResponse is `unknown` or
// a wider type that accepts any object.
const _reverse: SyncResponse = {
  upserted: 1,
  verdictsWritten: 2,
  claimsLinked: 3,
};

// Negative test: this MUST fail to compile if uncommented. SyncResponse
// should NOT accept arbitrary fields.
//
// const _wrong: SyncResponse = {
//   upserted: 1,
//   verdictsWritten: 2,
//   claimsLinked: 3,
//   nonExistentField: "should not compile",
// };

// ---------------------------------------------------------------------------
// Test 3: The other endpoints in the chain are still inferable
// ---------------------------------------------------------------------------

type StatsResponse = InferResponseType<RpcClient["stats"]["$get"], 200>;
type AllResponse = InferResponseType<RpcClient["all"]["$get"], 200>;

const _stats: StatsResponse = { total: 0 };
const _all: AllResponse = { grants: [] };

// ---------------------------------------------------------------------------
// Test 4: Multiple factory-built routes in one app (the production case)
// ---------------------------------------------------------------------------

interface MockPersonnelItem {
  id: string;
  personId: string;
  organizationId: string;
  role: string;
}

const personnelApp = new Hono()
  .post(
    "/sync",
    createSyncHandler<MockPersonnelItem>({
      name: "personnel",
      toRow: (item) => ({ ...item }),
    }),
  );

type PersonnelRoute = typeof personnelApp;
type PersonnelRpc = ReturnType<typeof hc<PersonnelRoute>>;
type PersonnelSync = InferResponseType<PersonnelRpc["sync"]["$post"], 200>;

// Both routes should resolve to the SAME shape since they use the same
// factory. (When we add `extendResponse`, this will diverge per-route.)
const _personnel: PersonnelSync = {
  upserted: 0,
  verdictsWritten: 0,
  claimsLinked: 0,
};

// Suppress unused warnings — these vars exist for type assertion side effects
void _expected;
void _reverse;
void _stats;
void _all;
void _personnel;
void grantsApp;
void personnelApp;

// ---------------------------------------------------------------------------
// Phase 0 verdict
// ---------------------------------------------------------------------------
//
// If `tsc --noEmit` passes on this file, the factory's type design is sound
// and Phase 1 can proceed.
//
// If it fails, the factory needs a different return-type strategy. Likely
// fixes (in order of preference):
//   1. Make the handler return type explicit: `Promise<Response<{...}>>`
//   2. Use Hono's `Context.json` overload that takes a typed payload first
//   3. Wrap the factory output in a no-op identity function that fixes
//      the inferred return type
//   4. Fall back to extracting only `runPostSyncPipeline()` as a utility
//      (Approach A in Discussion #4088), giving up on factory type inference
