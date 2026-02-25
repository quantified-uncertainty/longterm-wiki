---
numericId: E890
title: "Server Communication Investigation"
description: "Evaluation of wiki-server client/server architecture — pain points, framework options (Hono RPC, ts-rest, oRPC), and pragmatic improvement plan for type-safe API communication."
readerImportance: 15
researchImportance: 20
lastEdited: "2026-02-24"
evergreen: false
---

# Server Communication Investigation

**Date:** 2026-02-24
**Status:** Investigation / Proposal
**Context:** PRs #947-#956 wired many frontend features to the wiki-server API. This document evaluates the current patterns and recommends improvements.

## Current Architecture

Three consumers talk to the wiki-server (Hono + PostgreSQL):

| Consumer | Transport | Client code | Size |
|---|---|---|---|
| **Next.js app** (`apps/web/`) | `fetchDetailed()` / `fetchFromWikiServer()` / raw `fetch()` | `wiki-server.ts` (138 lines) + 13 fetch locations across 11 files | 9 hand-written `Api*Entry` interfaces |
| **Crux CLI** (`crux/`) | `apiRequest()` / `batchedRequest()` | `crux/lib/wiki-server/client.ts` + 17 domain modules | 107 exported interfaces & types |
| **Build scripts** | Direct fetch | Inline in `build-data.mjs` etc. | Minor |

The wiki-server exposes **18 route modules** with **109 endpoints** and **778 lines** in `apps/wiki-server/src/api-types.ts` (53+ Zod input schemas on lines 1-619, 14 response interfaces on lines 620-778).

## What Works Well

1. **`withApiFallback` pattern** -- Clean abstraction. Dashboards get API data when available, local fallback when not, plus a `DataSourceBanner` that shows users where data came from and why.

2. **`FetchResult<T>` discriminated union** -- Precise error classification (`not-configured` / `connection-error` / `server-error`) enables actionable UI messages. Better than `T | null`.

3. **Shared Zod schemas for inputs** -- `api-types.ts` is imported by both the server (runtime validation) and crux CLI (TypeScript type inference). Input types are not duplicated. Additionally, **14 response interfaces** are already exported (covering sessions, facts, and links endpoints), which serve as the model for expanding coverage.

4. **Crux's `ApiResult<T>` pattern** -- Consistent error handling across all 17 domain modules. Well-designed with `apiOk()` / `apiErr()` helpers.

5. **Crux's two-tier architecture** -- Core HTTP primitives (`apiRequest()` with 5s timeout, `batchedRequest()` with 30s timeout) in `client.ts` are cleanly separated from 17 domain-specific wrapper modules. Each domain module handles batch splitting with data-type-optimized sizes (200 entities, 500 facts, 2,000 links, 100 risk snapshots).

## Pain Points

### 1. Response types are mostly duplicated (~120 hand-written interfaces across consumers)

Of 109 server endpoints, only **14 have response types exported** from `api-types.ts` (sessions: 4, facts: 5, links+related: 5). The remaining **95 endpoints return untyped JSON** -- response shapes exist only implicitly in `c.json({...})` calls inside route handlers.

Each consumer re-declares response shapes for these untyped endpoints:

- **Crux CLI:** 107 exported interfaces & types across 17 domain modules in `crux/lib/wiki-server/`. Some are re-exports of the 14 shared server types (e.g., `SessionApiEntry = z.input<typeof CreateSessionSchema>`), but most are hand-written result wrappers (`SaveArtifactsResult`, `JobStatsResult`, etc.)
- **Next.js app:** 9 `Api*Entry` interfaces scattered across dashboard pages (`ApiRunEntry`, `ApiNewsItem`, `ApiAgentSession`, `ApiJobEntry`, `ApiArtifactEntry`, etc.) plus ~15 display-only `Row` types

When a server route changes, the hand-written types drift silently -- no compile-time check that they match. The 14 shared types (sessions, facts, links) prove the pattern works; the other 95 endpoints just haven't been covered yet.

### 2. Four separate fetch strategies across 13 locations

The Next.js app has **13 locations** that call the wiki-server, using 4 different strategies:

| Strategy | Function | Error model | Auth | Locations |
|---|---|---|---|---|
| Error-aware | `fetchDetailed<T>()` | `FetchResult<T>` (3 error variants) | Bearer | 8 dashboards (auto-update-runs, citation-accuracy, citation-content, auto-update-news, jobs, improve-runs, agent-sessions) |
| Legacy null-based | `fetchFromWikiServer<T>()` | `T \| null` | Bearer | 1 file (`citation-data.ts`) |
| Custom pagination | `getWikiServerConfig()` + manual loop | `FetchResult<T>` (manual) | Bearer | 1 file (`hallucination-risk/page.tsx`, 70-line pagination loop) |
| Raw fetch | `fetch()` | varies | varies | 2 files (search route: Bearer + 3s timeout; data page: **`x-api-key`** -- wrong!) |

Crux has its own two-tier system:

| Layer | Function | Error model | Timeout |
|---|---|---|---|
| Core | `apiRequest<T>()` | `ApiResult<T>` (4 error variants) | 5s default |
| Core | `batchedRequest<T>()` | `ApiResult<T>` | 30s |

The data page at `apps/web/src/app/wiki/[id]/data/page.tsx:54` uses `x-api-key` instead of `Authorization: Bearer` -- this is a latent bug (currently works because the server allows unauthenticated access when the API key env var is unset, but will break when auth is enforced).

### 3. Only 13% of endpoints have shared response types

The `api-types.ts` file defines **53+ input schemas** (lines 1-619) but only **14 response interfaces** (lines 620-778) covering 3 of 18 route modules (sessions, facts, links/related). The remaining **95 endpoints** return untyped JSON via inline `c.json({...})` calls.

The server-side response construction uses 4 inconsistent patterns:
1. **Inline untyped objects** (majority) -- `return c.json({ results: rows, total })` with no type annotation
2. **Database row casting to `any`** (pages.ts, citations.ts) -- raw SQL returns `any`, field mapping is unvalidated
3. **Mapped helper functions** (sessions.ts) -- `mapSessionRow()` documents shape implicitly, response type exported
4. **Complex aggregations** (citations.ts `/accuracy-dashboard`, 177 lines) -- entirely untyped, impossible for clients to infer

Error responses follow a consistent format (`{ error: "<code>", message: string }`) but this shape is **not exported as a type or schema**.

### 4. Inconsistent timeout, caching, and error handling

**Timeouts:**
- Search route: explicit 3-second `AbortSignal.timeout` (exemplary)
- Crux: 5-second default, 30-second batch timeout (via AbortController)
- All 8 dashboard pages using `fetchDetailed`: **no timeout** (relies on Next.js defaults)
- Hallucination risk pagination loop: **no timeout** on individual requests

**ISR revalidation:**
- Dashboard summaries: 60-300 seconds
- Citation data: 600 seconds (10 min)
- Page-level data: 300 seconds
- Search proxy: no caching (always fresh)

**Error handling:**
- 8 dashboards use `fetchDetailed` → `withApiFallback` → `DataSourceBanner` (good)
- `citation-data.ts` uses `fetchFromWikiServer` → silent `null` fallback → empty array (loses error details)
- Hallucination risk page: builds its own `FetchResult<T>` manually (correct but duplicates logic)

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

**Community research (Feb 2026):** Hono RPC works well below ~50 endpoints. Hono's creator Yusuke Wada [confirmed](https://github.com/honojs/hono/issues/3808) that 300+ endpoints makes `hc` "impossible" due to TypeScript instantiation depth limits, and acknowledged IDE degradation is a known limitation. Practical ceiling is ~100 endpoints with module splitting. The `hc` client is intentionally thin -- no batching, no React Query integration, no retry logic. The 9M weekly npm downloads are for Hono overall, not the RPC feature specifically. Monorepo setups are fragile: `AppType` export requires precise tsconfig alignment across packages or types break silently. For our 100+ endpoints, Hono RPC would require aggressive module splitting from day one.

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

**Community research (Feb 2026):** ts-rest's trajectory is the biggest concern. Two part-time volunteer maintainers, both with full-time jobs elsewhere. The v3.53.0 RC (Standard Schema / Zod 4 support) has sat unreleased for **9 months**. [GitHub issue #797](https://github.com/ts-rest/ts-rest/issues/797) ("Future of ts-rest") was opened by a developer who'd already been burned by Zodios's abandonment -- maintainers reassured the community in May 2025, then the issue was **reopened in September** after the reassurances weren't sustained. 105 open issues, 32 open PRs. The `ts-rest-hono` adapter is effectively dead (54 stars, last release November 2023, single maintainer). At 100+ endpoints, TypeScript performance degrades to 40+ second builds and 10+ second IDE autocompletion ([Issue #764](https://github.com/ts-rest/ts-rest/issues/764)); mitigation requires splitting contracts from day one. Production user Inkitt (\$59M raised) documented positive outcomes, but no major enterprise adoption is publicly known. ~115K weekly npm downloads, ~3,300 GitHub stars. The library is functional but the community explicitly invokes the "Zodios parallel" -- beloved, feature-complete, thin maintenance, eventual abandonment risk.

### Option C: oRPC (newer alternative)

TypeScript-first RPC framework with an official Hono adapter, built-in OpenAPI generation.

**Pros:**
- Official Hono adapter (unlike ts-rest)
- 1.6x faster type checking than tRPC (claims 2.8x runtime speed, 2.6x smaller bundle)
- Built-in OpenAPI spec generation
- Designed to address tRPC's limitations
- Optional contract-first mode (like ts-rest) OR procedure-first (like tRPC)
- Native file upload/download and Server Actions support

**Cons:**
- **v1.0 released December 2025** -- very young, small community
- **Solo maintainer** (unnoq / Hung Viet Pham) -- bus factor of 1, biggest risk
- Limited production battle-testing
- API surface may still change

**Migration effort:** Medium-high. Similar to ts-rest but less ecosystem support.

**Community research (Feb 2026):** oRPC is the most interesting newcomer but carries real risk. Created by a developer who used tRPC extensively, tried ts-rest but found it "missing features I relied on from tRPC, like flexible middleware," and built oRPC to combine both. ThoughtWorks Technology Radar placed it in the "Assess" ring. ~245K weekly npm downloads (growing). The commercial SaaS boilerplate supastarter chose oRPC over tRPC for their v3 rewrite. [InfoQ covered the v1.0 launch](https://www.infoq.com/news/2025/12/orpc-v1-typesafe/). Val Town evaluated oRPC but hesitated specifically on the solo-maintainer risk. The "bus factor 1" concern is the most frequently cited reservation across Reddit, HN, and blog posts. If the single maintainer loses interest, the project could stall like ts-rest but faster. However, the technical design is strong: incremental tRPC migration path, first-class OpenAPI from Zod schemas, and the official Hono adapter means no community-maintained shim layer.

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

### Phase 1 (now): Pragmatic foundations -- Option F

Fix the concrete issues that cause daily friction. This work is valuable regardless of which framework we pilot later, because it establishes the shared response types that any framework integration would need anyway.

1. **Expand response type exports in `api-types.ts`.** The 14 existing response interfaces (sessions, facts, links) prove the pattern works. Add response types for the remaining high-traffic modules: citations (18 endpoints, 0 types), jobs (10 endpoints, 0 types), entities (5 endpoints, 0 types). Target: cover the ~40 most-used endpoints. Both crux and Next.js import from the same source.

2. **Fix the `x-api-key` bug** in `apps/web/src/app/wiki/[id]/data/page.tsx:54` -- use `fetchDetailed` instead of raw fetch with wrong auth header. This will break when auth is enforced.

3. **Consolidate the Next.js fetch layer.** Make `fetchDetailed` the single entry point. Migrate `citation-data.ts` from `fetchFromWikiServer` (silent null) to `fetchDetailed` (structured errors). Extract the pagination helper from `hallucination-risk/page.tsx` for reuse. Add optional `timeout` support to `fetchDetailed`.

4. **Create typed fetch helpers per domain** in `apps/web/src/lib/wiki-api/` (e.g., `sessions.ts`, `citations.ts`). These import shared response types from `api-types.ts`. Dashboard pages call `getSessions()` instead of writing ~60-80 lines of inline fetch + type definitions.

### Phase 2 (soon): Framework pilot -- head-to-head comparison

**Option F doesn't scale forever.** At 109 endpoints growing toward 200+, manually maintaining response types is a losing game. The framework pilot should happen within the next few weeks, not "if the API keeps growing."

**Pilot design:** Pick **one route module** and implement it with two frameworks side by side. The `facts` module is ideal: 5 endpoints, well-defined Zod inputs, used by both crux and Next.js, has existing response types to compare against.

**Framework A: oRPC** -- strongest technical fit (official Hono adapter, contract-first + procedure-first modes, built-in OpenAPI). Solo-maintainer risk is real but bounded: if the pilot succeeds and the project later stalls, we'd have one module to port, not 18.

**Framework B: Hono RPC** -- zero new dependencies, type safety from `typeof app`. The IDE performance concern is theoretical at our scale (109 endpoints vs the "impossible" threshold of 300+). Per-module splitting may work fine.

**Measure:**
- TypeScript compilation time delta
- IDE autocomplete latency (is it perceptibly slower?)
- Lines of code eliminated vs added
- Developer ergonomics for adding a new endpoint
- Whether Next.js ISR (`next: { revalidate }`) integrates cleanly

**Decision criteria:** If either framework eliminates the response type duplication problem without degrading IDE performance, adopt it incrementally (one module at a time). If both degrade DX, stick with Option F's manual types as the long-term approach.

### Phase 3 (if pilot succeeds): Incremental migration

Migrate remaining 17 route modules one at a time, prioritizing by endpoint count (citations: 18, jobs: 10, resources: 8). Each module migration is independent and safe to ship separately.

### Framework comparison after community research

| Dimension | Hono RPC | ts-rest | oRPC |
|---|---|---|---|
| **Maintenance health** | Part of Hono (healthy) | Concerning (9-month gap, RC unreleased) | Active but solo maintainer |
| **Hono integration** | Native (built-in) | Dead community adapter | Official adapter |
| **Scale at 100+ endpoints** | Creator says "impossible" at 300+ | 40s builds, 10s+ IDE lag | Claims better perf; unproven at scale |
| **Bus factor** | Hono team (healthy) | 2 part-time volunteers | **1 person** (biggest risk) |
| **Community size** | 9M weekly (Hono overall) | ≈115K weekly, 3.3K stars | ≈245K weekly, growing |
| **Production battle-testing** | Moderate | Moderate (Inkitt) | Minimal |
| **OpenAPI generation** | No | Via contract | Built-in, first-class |
| **Server Actions** | No | No | Yes |
| **Migration approach** | All-or-nothing per module | Incremental | Incremental |

**Pilot candidates (for Phase 2 head-to-head):**

- **oRPC** is the strongest technical fit for our architecture (Hono server, multiple consumers, 100+ endpoints, need for both procedure and contract modes). The solo-maintainer risk is real but bounded by the pilot approach: if the project stalls, we lose one module's worth of investment.

- **Hono RPC** is the zero-dependency alternative. At 109 endpoints we're below the "impossible" threshold (300+), so the IDE performance concern may not materialize in practice. The pilot will answer this empirically.

**Not recommended for pilot:**

- **ts-rest** -- maintenance trajectory (9-month unreleased RC), dead Hono adapter, and community anxiety about the project's future make it a poor bet for a project that will depend on it for years.
- **tRPC** -- wrong architecture (requires abandoning REST structure).
- **Zodios** -- abandoned.
- **Full OpenAPI codegen** -- too much ceremony for current scale.

## Sizing

### Phase 1: Pragmatic foundations

| Task | Scope | Effort |
|---|---|---|
| Add response types for top ≈40 endpoints to `api-types.ts` | ≈30 new interfaces | 1 session |
| Fix `x-api-key` bug | 1 file | Trivial |
| Consolidate Next.js fetch layer (migrate legacy, extract pagination helper, add timeouts) | ≈5 files | 1 session |
| Create typed domain helpers in `apps/web/src/lib/wiki-api/` | ≈8-10 new files | 1-2 sessions |
| Update crux clients to import shared response types (replacing hand-written duplicates) | 17 files | 1 session |

Total: ~4-5 sessions.

### Phase 2: Framework pilot

| Task | Scope | Effort |
|---|---|---|
| Implement `facts` module with oRPC (server + crux client + Next.js client) | 3-4 files | 1 session |
| Implement `facts` module with Hono RPC (server + crux client + Next.js client) | 3-4 files | 1 session |
| Measure & document performance comparison | Benchmarks + writeup | 0.5 sessions |

Total: ~2-3 sessions for the head-to-head comparison.

### Phase 3: Incremental migration (if pilot succeeds)

| Task | Scope | Effort |
|---|---|---|
| Migrate remaining 17 route modules | ≈18 route files + ~17 client modules | 1-2 sessions per module, ~8-10 sessions total |

Total: ~8-10 sessions spread over time.

## Appendix A: Numbers

- **Wiki-server routes:** 18 modules, 109 endpoints
- **Shared schemas in `api-types.ts`:** 778 lines (53+ input Zod schemas, 14 response TypeScript interfaces)
- **Response type coverage:** 14 of 109 endpoints (13%) have shared response types — sessions (4), facts (5), links+related (5)
- **Crux client code:** 17 domain modules + 1 core client in `crux/lib/wiki-server/`, 107 exported interfaces & types (mix of server re-exports and hand-written wrappers)
- **Next.js integration points:** 13 fetch locations across 11 files, 9 hand-written `Api*Entry` interfaces + ~15 display types
- **Fetch strategies in Next.js:** 8 use `fetchDetailed`, 1 uses legacy `fetchFromWikiServer`, 1 uses custom pagination, 2 use raw `fetch`

### Endpoint inventory by route module

| Module | Endpoints | Response types exported? |
|---|---|---|
| citations.ts | 18 | No |
| jobs.ts | 10 | No |
| resources.ts | 8 | No |
| claims.ts | 7 | No |
| edit-logs.ts | 6 | No |
| hallucination-risk.ts | 6 | No |
| sessions.ts | 6 | **Yes** (4 interfaces) |
| artifacts.ts | 5 | No |
| auto-update-news.ts | 5 | No |
| entities.ts | 5 | No |
| facts.ts | 5 | **Yes** (5 interfaces) |
| links.ts | 5 | **Yes** (2 interfaces) |
| pages.ts | 5 | No |
| summaries.ts | 5 | No |
| auto-update-runs.ts | 4 | No |
| agent-sessions.ts | 4 | No |
| ids.ts | 4 | No |
| health.ts | 1 | No |

### Next.js fetch locations

| File | Strategy | Auth | Status |
|---|---|---|---|
| `internal/auto-update-runs/page.tsx` | fetchDetailed | Bearer | OK |
| `internal/citation-accuracy/page.tsx` | fetchDetailed | Bearer | OK |
| `internal/citation-content/page.tsx` (2 calls) | fetchDetailed | Bearer | OK |
| `internal/auto-update-news/page.tsx` | fetchDetailed | Bearer | OK |
| `internal/jobs/page.tsx` | fetchDetailed | Bearer | OK |
| `internal/improve-runs/page.tsx` | fetchDetailed | Bearer | OK |
| `internal/agent-sessions/page.tsx` (2 calls) | fetchDetailed | Bearer | OK |
| `internal/hallucination-risk/page.tsx` | Custom pagination | Bearer | OK (but not reusable) |
| `lib/citation-data.ts` | fetchFromWikiServer | Bearer | Legacy (silent null) |
| `api/search/route.ts` | Raw fetch | Bearer | OK (3s timeout) |
| `wiki/[id]/data/page.tsx` | Raw fetch | **x-api-key** | **BUG** |

### Crux batch sizes by data type

| Module | Batch size | Timeout |
|---|---|---|
| entities.ts | 200 | 30s |
| facts.ts | 500 | 30s |
| links.ts | 2,000 | 30s |
| risk.ts | 100 | 30s |
| auto-update.ts | 500 | 30s |

## Appendix B: Community Research Sources (Feb 2026)

### Hono RPC
- [Hono RPC documentation](https://hono.dev/docs/guides/rpc)
- [GitHub #3808 -- IDE performance at scale](https://github.com/honojs/hono/issues/3808) -- Yusuke Wada confirms 300+ endpoints is "impossible"
- [GitHub #3004 -- Client splitting discussion](https://github.com/honojs/hono/issues/3004)
- Hono: 9M weekly npm downloads, 22K+ GitHub stars

### ts-rest
- [GitHub issue #797 -- "Future of ts-rest"](https://github.com/ts-rest/ts-rest/issues/797) -- community anxiety about maintenance, reopened Sept 2025
- [GitHub issue #764 -- Performance at scale](https://github.com/ts-rest/ts-rest/issues/764) -- 40s builds, 10s+ IDE lag at 100+ endpoints
- [GitHub issue #389 -- "Type instantiation excessively deep"](https://github.com/ts-rest/ts-rest/issues/389)
- [Inkitt -- "How ts-rest Saved Our Sanity"](https://medium.com/inkitt-tech/how-ts-rest-saved-our-sanity-a-tale-of-taming-the-multi-platform-beast-508dc0b0a8f8) -- most documented production user
- [ts-rest-hono adapter](https://github.com/msutkowski/ts-rest-hono) -- 54 stars, last release Nov 2023
- v3.52.1 (March 2025) latest stable; v3.53.0-rc.1 (June 2025) unreleased for 9 months
- ~115K weekly npm downloads, ~3,300 GitHub stars, 105 open issues, 32 open PRs

### oRPC
- [oRPC v1.0 announcement](https://orpc.unnoq.com/blog/v1-announcement) -- creator's journey from tRPC to ts-rest to building oRPC
- [InfoQ coverage of v1.0 launch](https://www.infoq.com/news/2025/12/orpc-v1-typesafe/)
- [ThoughtWorks Technology Radar -- "Assess" ring](https://www.thoughtworks.com/en-gb/radar/languages-and-frameworks/orpc)
- [oRPC comparison page](https://orpc.dev/docs/comparison) -- positions against ts-rest and tRPC
- [supastarter chose oRPC for v3](https://supastarter.dev) -- commercial SaaS boilerplate
- Val Town evaluated oRPC, hesitated on solo-maintainer risk
- ~245K weekly npm downloads, growing; solo maintainer (unnoq / Hung Viet Pham)

### Cross-framework comparisons
- [Catalin Pit -- trpc-openapi vs ts-rest](https://catalins.tech/public-api-trpc/)
- [Wisp CMS -- oRPC vs tRPC and alternatives](https://www.wisp.blog/blog/comparative-analysis-orpc-vs-trpc-and-other-alternatives)
- [HN thread -- type-safe API discussion (Aug 2025)](https://news.ycombinator.com/item?id=44780167)
- [HN thread -- REST vs RPC approaches (Aug 2023)](https://news.ycombinator.com/item?id=37099355)
