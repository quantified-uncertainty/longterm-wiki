# Code Review Guidelines

Rules enforced by gate checks and PR review. See [#1246](https://github.com/quantified-uncertainty/longterm-wiki/issues/1246) for full context.

- **No `(r: any)` in wiki-server routes** — define typed row interfaces for raw SQL results (enforced by gate)
- **No `as unknown as T` double-casts** — use runtime type narrowing or proper generics
- **Batch endpoints must use transactions or bulk SQL** — never sequential per-row updates
- **Migration file prefixes must be unique** — no two `.sql` files with the same numeric prefix (enforced by gate)
- **Destructive endpoints (DELETE, bulk UPDATE) must log actions** before executing
- **API callers must use typed wiki-server client functions** (`crux/lib/wiki-server/*.ts`) — not raw `apiRequest<{...}>` with hand-written type parameters. If no typed client exists for the endpoint, create one using `InferResponseType<>` per `wiki-server-rpc-migration.md`.
- **Batch write callers must handle partial success** — `updated < total` may mean "already processed on retry", not "failed". Treat partial success as non-fatal when the endpoint has idempotent semantics (e.g., `WHERE status IN ('pending', 'verifying')`).
- **LLM prompts must escape user content** — use `escapeXml()` from `crux/lib/prompt-utils.ts` for XML-delimited prompts, `JSON.stringify()` or `---` fencing for other formats. See `.claude/rules/llm-prompt-safety.md`.
- **No standalone weak assertions in tests** — `toBeDefined()` alone doesn't catch wrong values; follow with `toBe()`, `toEqual()`, or `toMatchObject()` on specific fields.
- **No `it.skip` without issue number** — skipped tests must reference `#1234` in the skip reason so they get unskipped when the underlying bug is fixed.
