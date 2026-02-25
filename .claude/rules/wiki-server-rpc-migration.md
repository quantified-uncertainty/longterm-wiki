# Wiki-Server: Hono RPC Migration (Opportunistic)

We are incrementally migrating wiki-server routes from hand-written response types to Hono RPC type inference. **Do not batch-migrate** — convert routes when you are already modifying them.

## Status

- **Migrated**: `facts.ts` (reference implementation)
- **Not yet migrated**: all other routes (~21 files in `apps/wiki-server/src/routes/`)

## Why

Today, API response types are manually duplicated in 3 places:
1. `apps/wiki-server/src/api-types.ts` (interface definitions)
2. Route handler (actual `c.json(...)` return shape)
3. Client code (`crux/lib/wiki-server/`, `apps/web/src/data/`)

These drift silently. The facts migration caught 2 real bugs: `entity` vs `entityId` and `timeseries` vs `points` field mismatches that had gone unnoticed.

With Hono RPC, the route handler is the single source of truth and client types are inferred at compile-time via `InferResponseType<>`.

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

## When NOT to migrate

- Don't convert a route just because you're reading it
- Don't migrate as a side-effect of an unrelated bug fix
- Do migrate when you're adding/changing endpoints on a route or restructuring it
