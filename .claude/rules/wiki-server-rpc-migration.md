# Wiki-Server: Hono RPC Type System — MANDATORY

All wiki-server routes use Hono RPC method-chaining. Response types are inferred at compile-time via `InferResponseType<>`. **Never write hand-written response interfaces** — the route handler is the single source of truth.

## Architecture Overview

```
Route handler (c.json({...}))          ← SINGLE SOURCE OF TRUTH
    │
    ├── export type MyRoute = typeof myApp
    │
    ├── crux/lib/wiki-server/<name>.ts     ← InferResponseType<RpcClient[...], 200>
    │       Uses apiRequest() for HTTP calls, types are compile-time only
    │
    └── api-response-types.ts              ← InferResponseType<RpcClient[...], 200>
            Frontend imports via @wiki-server/api-response-types
```

Three type layers, all derived from the route:
1. **Server route** — method-chained Hono app, exports `type MyRoute = typeof myApp`
2. **Crux CLI client** — `crux/lib/wiki-server/<name>.ts`, uses `InferResponseType<>` from the route type
3. **Frontend** — `apps/wiki-server/src/api-response-types.ts`, uses `InferResponseType<>` from route types; frontend imports via `@wiki-server/api-response-types` tsconfig alias

## Adding a New Route — Complete Checklist

### Step 1: Create the route file

```typescript
// apps/wiki-server/src/routes/my-feature.ts
import { Hono } from "hono";
import { zv } from "../utils.js";
import { z } from "zod";

const myFeatureApp = new Hono()
  .get("/", zv("query", z.object({ limit: z.coerce.number().default(50) })), async (c) => {
    const { limit } = c.req.valid("query");
    // ... handler logic
    return c.json({ items: [], total: 0 });
  })
  .post("/", async (c) => {
    const body = await c.req.json();
    // ...
    return c.json({ id: "new-id" }, 201);
  });

export const myFeatureRoute = myFeatureApp;
export type MyFeatureRoute = typeof myFeatureApp;
```

**Key rules:**
- Method-chaining (`.get().post()`) is required — standalone `myApp.get(...)` breaks type inference
- Use `zv()` (Hono validator wrapper) for query/body validation — this gives typed params AND proper error responses
- **Avoid `(r: any)` for raw SQL results** — this makes InferResponseType produce `any`-typed fields. Instead, type the intermediate:
  ```typescript
  // BAD — produces any-typed fields in InferResponseType
  const items = rows.map((r: any) => ({ id: r.id, name: r.name }));

  // GOOD — produces properly-typed fields
  interface DbRow { id: string; name: string }
  const items = rows.map((r: DbRow) => ({ id: r.id, name: r.name }));

  // ALSO GOOD — use Drizzle typed queries instead of raw SQL
  const items = await db.select().from(myTable).where(...);
  ```

### Step 2: Register in `app.ts`

Two things to add in `apps/wiki-server/src/app.ts`:

```typescript
// 1. Auth middleware — choose the right scope:
//    "content" = wiki data (facts, claims, citations, entities, resources, etc.)
//    "project" = operational/infrastructure (sessions, jobs, agent-sessions, ids, etc.)
app.use("/api/my-feature/*", requireWriteScope("content"));

// 2. Mount the route
app.route("/api/my-feature", myFeatureRoute);
```

### Step 3: Add crux CLI client (if crux needs to call it)

```typescript
// crux/lib/wiki-server/my-feature.ts
import type { hc, InferResponseType } from 'hono/client';
import type { MyFeatureRoute } from '../../../apps/wiki-server/src/routes/my-feature.ts';
import { apiRequest, type ApiResult } from './client.ts';

type RpcClient = ReturnType<typeof hc<MyFeatureRoute>>;

// Response types — derived from route, NOT hand-written
export type MyFeatureListResult = InferResponseType<RpcClient['index']['$get'], 200>;
export type MyFeatureCreateResult = InferResponseType<RpcClient['index']['$post'], 201>;

// API functions — use apiRequest() for HTTP calls
export async function listMyFeatures(limit = 50): Promise<ApiResult<MyFeatureListResult>> {
  return apiRequest<MyFeatureListResult>('GET', `/api/my-feature?limit=${limit}`);
}
```

Then re-export from `crux/lib/wiki-server/index.ts`.

### Step 4: Add frontend types (if frontend consumes the API)

Add to `apps/wiki-server/src/api-response-types.ts`:

```typescript
import type { MyFeatureRoute } from './routes/my-feature.js';

type MyFeatureRpc = ReturnType<typeof hc<MyFeatureRoute>>;

export type MyFeatureListResult = InferResponseType<MyFeatureRpc['index']['$get'], 200>;
export type MyFeatureItem = MyFeatureListResult['items'][number];
```

Frontend files import via: `import type { MyFeatureItem } from "@wiki-server/api-response-types"`

### Step 5: Verify

```bash
cd apps/web && npx tsc --noEmit   # Frontend types compile
cd apps/wiki-server && npx tsc --noEmit  # Server types compile
pnpm crux validate gate --fix     # Full gate
```

## RPC Path Key Mapping

| Route pattern | RPC client key | Example |
|---------------|---------------|---------|
| `/` (root) | `'index'` | `RpcClient['index']['$get']` |
| `/:id` | `[':id']` | `RpcClient[':id']['$get']` |
| `/by-entity` | `['by-entity']` | `RpcClient['by-entity']['$get']` |
| `/by-entity/:entityId` | `['by-entity'][':entityId']` | `RpcClient['by-entity'][':entityId']['$get']` |
| `/stats` | `['stats']` | `RpcClient['stats']['$get']` |

**Never use leading slashes** in keys: `['stats']` not `['/stats']`.

## Known Issue: `(r: any)` Raw SQL Regressions

Several existing routes use `(r: any)` mapping for raw SQL results, which causes InferResponseType to produce `any`-typed fields. This is **worse** than hand-written types. Affected routes:

- `links.ts` — backlinks and related endpoints (BacklinkEntry, RelatedEntry have `any` fields)
- `claims.ts` — similar claims endpoint (SimilarClaimItem has `any` fields)
- `hallucination-risk.ts` — latest endpoint (RiskPageRow has `any` fields)
- `explore.ts`, `pages.ts`, `resources.ts` — search endpoints

When modifying these routes, fix the `(r: any)` by adding typed interfaces for the raw SQL result shape.

## What Belongs Where

| File | Contains | Example |
|------|----------|---------|
| `api-types.ts` | Zod input schemas, runtime constants, enum types | `InsertClaim`, `AccuracyVerdict`, `ACCURACY_VERDICTS` |
| `api-response-types.ts` | InferResponseType exports for frontend | `ClaimRow`, `BacklinkEntry`, `SessionRow` |
| `crux/lib/wiki-server/<name>.ts` | InferResponseType exports + apiRequest() functions for CLI | `GetClaimsResult`, `upsertClaim()` |
| Route files | The actual response shapes (via `c.json()`) | Single source of truth |

**Never add response interfaces to `api-types.ts`** — that file is for inputs and runtime values only.

## Circular Import Prevention

- `api-response-types.ts` imports route types → routes import Zod schemas from `api-types.ts`
- **`api-types.ts` must NEVER import from `api-response-types.ts` or route files** — this would create a cycle
