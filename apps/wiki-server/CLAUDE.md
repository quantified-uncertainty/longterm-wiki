# Wiki-Server — Claude Code Guide

Hono-based API server with PostgreSQL (via Drizzle ORM). Deployed on Kubernetes.

## Adding a New Endpoint

Follow the complete checklist in `.claude/rules/wiki-server-rpc-migration.md`. Summary:

1. **Create route file** in `src/routes/<name>.ts` — use method-chaining, export `type MyRoute = typeof myApp`
2. **Register in `src/app.ts`** — add auth middleware (`requireWriteScope`) AND mount with `app.route()`
3. **Add crux client** in `crux/lib/wiki-server/<name>.ts` — use `InferResponseType<>`, re-export from `index.ts`
4. **Add frontend types** in `src/api-response-types.ts` — if the frontend consumes the API
5. **Verify** — `pnpm crux validate gate --fix`

## Key Files

| File | Purpose |
|------|---------|
| `src/app.ts` | Route registration + auth middleware |
| `src/api-types.ts` | Zod input schemas, runtime constants (NOT response types) |
| `src/api-response-types.ts` | InferResponseType exports for frontend consumption |
| `src/routes/*.ts` | Route handlers — single source of truth for response shapes |
| `drizzle/` | Database migrations |

## Auth Scopes

Two write scopes in `src/app.ts`:

- **`"content"`** — Wiki data endpoints: facts, claims, citations, entities, resources, links, summaries, hallucination-risk, artifacts, references, pages
- **`"project"`** — Operational endpoints: sessions, jobs, agent-sessions, ids, edit-logs, auto-update-runs, auto-update-news

GET requests don't require write scope. Write scope is enforced on POST/PUT/DELETE.

## Type System Rules

- **Never hand-write response interfaces** — use `InferResponseType<>` from the route type
- **Never add response types to `api-types.ts`** — that file is for Zod input schemas and runtime constants only
- **Avoid `(r: any)` for raw SQL** — type the DB result interface so InferResponseType gets proper field types
- **Use `zv()` for validation** — wraps Hono's validator for typed query/body params

## Database

- PostgreSQL via Drizzle ORM (`src/schema.ts`)
- Raw SQL via `rawDb` (postgres.js) for complex queries — but type the results!
- Migrations in `drizzle/` — use `pnpm drizzle-kit generate` to create, applied automatically on deploy

## Testing

```bash
pnpm test                    # Unit tests (vitest)
pnpm test:integration        # Integration tests (requires running DB)
```
