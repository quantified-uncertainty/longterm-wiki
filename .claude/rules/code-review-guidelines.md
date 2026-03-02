# Code Review Guidelines

Rules enforced by gate checks and PR review. See [#1246](https://github.com/quantified-uncertainty/longterm-wiki/issues/1246) for full context.

- **No `(r: any)` in wiki-server routes** — define typed row interfaces for raw SQL results (enforced by gate)
- **No `as unknown as T` double-casts** — use runtime type narrowing or proper generics
- **Batch endpoints must use transactions or bulk SQL** — never sequential per-row updates
- **Migration file prefixes must be unique** — no two `.sql` files with the same numeric prefix (enforced by gate)
- **Destructive endpoints (DELETE, bulk UPDATE) must log actions** before executing
