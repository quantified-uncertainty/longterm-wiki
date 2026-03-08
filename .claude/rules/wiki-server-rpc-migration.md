# Wiki-Server: Hono RPC Migration (Mandatory for New Routes)

All **new** wiki-server routes must use Hono RPC method-chaining. Existing routes should be converted when you are already modifying them.

## Status

- **Migrated**: All route files — `facts.ts`, `citations.ts`, `references.ts`, `health.ts`, `ids.ts`, `edit-logs.ts`, `summaries.ts`, `artifacts.ts`, `agent-sessions.ts`, `entities.ts`, `explore.ts`, `sessions.ts`, `pages.ts`, `links.ts`, `hallucination-risk.ts`, `jobs.ts`, `resources.ts`, `auto-update-news.ts`, `auto-update-runs.ts`, `integrity.ts`
- **Utility files** (no migration needed): `ref-check.ts`, `utils.ts`

## Why

Today, API response types are manually duplicated in 3 places:
1. `apps/wiki-server/src/api-types.ts` (interface definitions)
2. Route handler (actual `c.json(...)` return shape)
3. Client code (`crux/lib/wiki-server/`, `apps/web/src/data/`)

These drift silently. The facts migration caught 2 real bugs: `entity` vs `entityId` and `timeseries` vs `points` field mismatches that had gone unnoticed.

With Hono RPC, the route handler is the single source of truth and client types are inferred at compile-time via `InferResponseType<>`.

## What `api-types.ts` is still used for

`apps/wiki-server/src/api-types.ts` remains at ~1,300 lines after the migration. This is correct — Hono RPC only replaces **response type** duplication. `api-types.ts` still serves:
- **Zod request validation schemas** (input bodies, query params) — still needed for runtime validation
- **Shared enums** (VALID_TOOLS, VALID_AGENCIES) — cross-route constants
- **Request body schemas** — these are not inferred by RPC (only response shapes are)

Do not delete `api-types.ts` or assume the migration is incomplete because it still exists. The migration is complete for response types.

## How to migrate a route

Follow the pattern in `apps/wiki-server/src/routes/facts.ts`:

### 1. Server: use method-chaining and export the route type

```typescript
const myApp = new Hono()
  .get("/endpoint", zv("query", MyQuerySchema), async (c) => {
    // ... handler logic
    return c.json({ result });
  })
  .post("/other", async (c) => {
    // ...
    return c.json({ ok: true });
  });

export const myRoute = myApp;
export type MyRoute = typeof myApp;
```

Key: the method-chaining (`.get().post()`) is what lets TypeScript infer the full route type. Standalone `myApp.get(...)` calls break inference.

### 2. CLI client: replace hand-written types with InferResponseType

```typescript
import type { hc, InferResponseType } from 'hono/client';
import type { MyRoute } from '../../../apps/wiki-server/src/routes/my-route.ts';

type RpcClient = ReturnType<typeof hc<MyRoute>>;
type MyEndpointResult = InferResponseType<RpcClient['endpoint']['$get'], 200>;
```

Keep using `apiRequest()` for the actual HTTP calls (test mock compatibility). Only the types change.

### 3. Frontend (if applicable): use the RPC client from `apps/web/src/lib/wiki-server.ts`

See `getFactsRpcClient()` for the ISR-compatible fetch wrapper pattern.

### 4. Clean up

Remove the old hand-written response interfaces from `api-types.ts` once all consumers use inferred types.

## Adding new routes

All new routes **must** use method-chaining from the start. Follow the pattern above.

## RPC path key gotchas

- Root route `/` maps to `'index'` in the RPC client type (not `'/'`)
- Path params like `/:id` map to `':id'`
- Hyphenated paths like `/by-entity` map to `'by-entity'`
