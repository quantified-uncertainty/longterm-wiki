# Server Communication Investigation

**Date:** 2026-02-24
**Status:** Investigation / Proposal
**Context:** PRs #947-#956 wired many frontend features to the wiki-server API. This document evaluates the current patterns and recommends improvements.

## Current Architecture

Three consumers talk to the wiki-server (Hono + PostgreSQL):

| Consumer | Transport | Client code | Lines |
|---|---|---|---|
| **Next.js app** (`apps/web/`) | `fetchDetailed()` / `fetchFromWikiServer()` / raw `fetch()` | `wiki-server.ts` + inline in ~13 page files | ~138 + scattered |
| **Crux CLI** (`crux/`) | `apiRequest()` / `batchedRequest()` | `crux/lib/wiki-server/client.ts` + 16 domain modules | ~2,460 |
| **Build scripts** | Direct fetch | Inline in `build-data.mjs` etc. | Minor |

The wiki-server exposes **18 route modules** with **100+ endpoints** and **617 lines of shared Zod schemas** in `apps/wiki-server/src/api-types.ts`.

## What Works Well

1. **`withApiFallback` pattern** -- Clean abstraction. Dashboards get API data when available, local fallback when not, plus a `DataSourceBanner` that shows users where data came from and why.

2. **`FetchResult<T>` discriminated union** -- Precise error classification (`not-configured` / `connection-error` / `server-error`) enables actionable UI messages. Better than `T | null`.

3. **Shared Zod schemas for inputs** -- `api-types.ts` is imported by both the server (runtime validation) and crux CLI (TypeScript type inference). Input types are not duplicated.

4. **Crux's `ApiResult<T>` pattern** -- Consistent error handling across all 16 domain modules. Well-designed with `apiOk()` / `apiErr()` helpers.

## Pain Points

### 1. Response types are duplicated everywhere (~80 hand-written interfaces)

The server's response shapes are **not exported** -- each consumer re-declares them:

- **Crux CLI:** ~65 interfaces like `FactEntry`, `EntityListResult`, `SessionPageChangesResult` across 16 files in `crux/lib/wiki-server/`
- **Next.js app:** ~15 interfaces like `ApiSession`, `ServerBacklink`, `ServerFact`, `ApiRiskPage` scattered across dashboard pages

These interfaces are hand-written guesses about what the server returns. When a server route changes, these drift silently -- there is no compile-time check that they match.

### 2. Three separate fetch abstractions

| Layer | Function | Error model | Auth header |
|---|---|---|---|
| Next.js | `fetchDetailed<T>()` | `ApiErrorReason` (3 variants) | `Authorization: Bearer` |
| Next.js | `fetchFromWikiServer<T>()` | `T \| null` | `Authorization: Bearer` |
| Next.js (data page) | Raw `fetch()` | `null` on failure | **`x-api-key`** (wrong!) |
| Next.js (search route) | Raw `fetch()` | 503 HTTP | `Authorization: Bearer` |
| Crux | `apiRequest<T>()` | `ApiResult<T>` (4 error variants) | `Authorization: Bearer` |
| Crux | `batchedRequest<T>()` | `ApiResult<T>` | `Authorization: Bearer` |

The data page at `apps/web/src/app/wiki/[id]/data/page.tsx:54` uses `x-api-key` instead of `Authorization: Bearer` -- this is a latent bug (currently works because the server allows unauthenticated access when the API key env var is unset, but will break when auth is enforced).

### 3. No shared response types between server and consumers

The `api-types.ts` file defines **input** schemas (what clients send to the server). But **output** types (what the server returns) are defined nowhere -- they exist only implicitly in `c.json({...})` calls inside route handlers. Each consumer reverse-engineers these shapes.

### 4. Inconsistent timeout, caching, and error handling

- Search route: explicit 3-second `AbortSignal.timeout`
- Crux: 5-second default, 30-second batch timeout
- Dashboard pages: no explicit timeout (relies on Next.js defaults)
- Hallucination risk page: implements its own pagination loop with a safety limit
- Some dashboards use `fetchDetailed` (structured errors); others use `fetchFromWikiServer` (null on error)

### 5. Growing boilerplate per dashboard page

Each new internal dashboard repeats the same ~40-line pattern:
```
define ApiXyz interface → loadFromApi() using fetchDetailed → loadFromLocal() → withApiFallback → render + DataSourceBanner
```

This is functional but tedious. Adding a new dashboard that reads from 2 API endpoints requires writing ~60-80 lines of type definitions and fetch logic before any UI code.

## Options Evaluated

### Option A: Hono RPC (built-in)

Hono has a built-in RPC layer: export `typeof app` from the server, use `hc<AppType>()` on the client for fully typed calls with zero code generation.

**Pros:**
- Zero new dependencies (already using Hono)
- Eliminates all hand-written response types
- Compile-time type checking of paths, methods, and response shapes

**Cons:**
- **IDE performance degrades at scale** -- community reports multi-second autocomplete lag at 100+ endpoints. Would need per-module client splitting.
- **Requires refactoring all 18 route files** to use method chaining (currently uses separate statement pattern)
- **Next.js ISR integration is awkward** -- `hc` client doesn't pass `next: { revalidate }` options; you'd extract the URL and call `fetch()` directly, negating some benefit
- **Error types don't flow** through global error handlers
- **Query param coercion broken** -- `z.coerce.number()` in query schemas doesn't flow correctly to client types

**Migration effort:** High. Every route file and every client file must change. Mechanical but large.

### Option B: ts-rest

Define a "contract" object that wraps existing Zod schemas with path, method, and response schema. Server and client both consume the contract for type safety.

**Pros:**
- Keeps REST structure (paths, methods stay the same)
- Incremental migration (one route module at a time)
- Existing Zod schemas slot directly into contracts
- CLI client works naturally (`@ts-rest/core` has no React dependency)
- Standard `fetch()` underneath, so Next.js ISR works

**Cons:**
- **Hono adapter is community-maintained** (`ts-rest-hono`), not official
- **Large upfront contract definition** -- 100+ endpoints need contract entries
- **Some community concern** about project trajectory (GitHub #797), though still actively maintained
- **Requires response schemas** -- currently response shapes are implicit; you'd need to define Zod schemas for outputs too (this is arguably a benefit, but it's work)

**Migration effort:** Medium. Mechanical but incremental. Contract definitions are boilerplate-heavy.

### Option C: oRPC (newer alternative)

TypeScript-first RPC framework with an official Hono adapter, built-in OpenAPI generation.

**Pros:**
- Official Hono adapter (unlike ts-rest)
- 1.6x faster type checking than tRPC
- Built-in OpenAPI spec generation
- Designed to address tRPC's limitations

**Cons:**
- **v1.0 released December 2025** -- very young, small community
- Limited production battle-testing
- API surface may still change

**Migration effort:** Medium-high. Similar to ts-rest but less ecosystem support.

### Option D: tRPC

**Not recommended.** Requires abandoning REST structure (all endpoints become RPC procedures behind `/trpc`), fights Next.js ISR caching, has a known bug where discriminated unions lose required properties (#5215). Would be a full rewrite, not a migration.

### Option E: OpenAPI codegen (openapi-typescript + openapi-fetch)

Generate types from an OpenAPI spec. Use `@hono/zod-openapi` to produce the spec from Hono routes.

**Pros:**
- Industry-standard OpenAPI spec as source of truth
- Works with any consumer (not just TypeScript)
- Tiny client (~6 KB)

**Cons:**
- Code generation step in build pipeline
- `@hono/zod-openapi` requires significant route refactoring (different API than plain Hono)
- Generated types can be verbose

### Option F: Pragmatic improvements without a framework

Improve the existing patterns without adopting a new library.

**Pros:**
- Zero migration risk
- Can be done incrementally today
- Addresses the most painful issues without framework lock-in

**Cons:**
- Doesn't eliminate the fundamental "response types drift" problem
- Manual discipline required to keep things consistent

## Recommendation

**Short-term (now): Option F -- Pragmatic improvements.** Fix the concrete issues without a framework migration:

1. **Add response type exports to `api-types.ts`.** Define output schemas/interfaces alongside the existing input schemas. Both crux and Next.js import from the same source. This eliminates ~80 duplicated interfaces with zero new dependencies. Example:

   ```typescript
   // In api-types.ts (already shared between server + crux):
   export interface FactsByEntityResponse {
     entityId: string;
     facts: FactEntry[];
     total: number;
     limit: number;
     offset: number;
   }
   ```

2. **Fix the `x-api-key` bug** in `apps/web/src/app/wiki/[id]/data/page.tsx` -- use `fetchDetailed` or `fetchFromWikiServer` instead of raw fetch with wrong auth header.

3. **Consolidate the Next.js fetch layer.** Make `fetchDetailed` the single entry point. Remove direct `process.env.LONGTERMWIKI_SERVER_URL` access from individual page files. Add optional `timeout` support to `fetchDetailed`.

4. **Create typed fetch helpers per domain** in `apps/web/src/lib/` (e.g., `wiki-api/sessions.ts`, `wiki-api/citations.ts`). These would mirror what crux already has, importing shared response types from `api-types.ts`. Dashboard pages call `getSessions()` instead of writing inline fetch + type definitions.

**Medium-term (if the API surface keeps growing): Evaluate Hono RPC or ts-rest** on a single route module (e.g., `facts` -- small, well-defined, used by both crux and Next.js). Measure:
- IDE performance impact
- Developer experience improvement
- Whether the migration pattern is sustainable for all 18 modules

The choice between Hono RPC and ts-rest depends on priorities:
- **Hono RPC** if you want zero new dependencies and are willing to accept the IDE performance tradeoff
- **ts-rest** if you want incremental migration and standard REST semantics
- **oRPC** if you're willing to bet on a newer project with better Hono integration

**Not recommended:** tRPC (wrong architecture), Zodios (abandoned), full OpenAPI codegen (too much ceremony for the current scale).

## Sizing the Short-Term Work

| Task | Scope | Effort |
|---|---|---|
| Add response types to `api-types.ts` | ~40-50 interfaces | 1 session |
| Fix `x-api-key` bug | 1 file | Trivial |
| Consolidate Next.js fetch layer | ~13 files | 1 session |
| Create typed domain helpers for Next.js | ~8-10 new files | 1-2 sessions |
| Update crux clients to import shared response types | 16 files | 1 session |

Total: ~4-5 focused sessions to eliminate the type duplication and inconsistency problems without any framework migration.

## Appendix: Numbers

- **Wiki-server routes:** 18 modules, 5,488 lines
- **Shared input schemas:** 617 lines in `api-types.ts`
- **Crux client code:** 16 domain modules, 2,459 lines, ~65 hand-written response interfaces
- **Next.js integration points:** 18 files touch the wiki-server, ~15 hand-written response interfaces
- **Endpoints:** 100+ across GET/POST/PATCH/DELETE
