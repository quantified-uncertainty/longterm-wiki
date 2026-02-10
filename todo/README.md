# Post-Migration Cleanup Tasks

Identified via codebase audit (2026-02-10). Ordered by priority.

| # | Task | Priority | Effort | Risk |
|---|------|----------|--------|------|
| [001](./001-strip-client-load-directives.md) | Strip Astro `client:load` from 441 MDX files | High | ~45 min | Low |
| [002](./002-remove-dead-code-and-starlight-css.md) | Remove dead Mermaid.tsx, unused UI components, Starlight CSS vars | High | ~30–45 min | Low |
| [003](./003-fix-generated-file-sync.md) | Fix id-registry/pathRegistry sync, consolidate schema.ts | High | ~45–60 min | Medium |
| [004](./004-update-tooling-astro-to-nextjs.md) | Update 6 tooling files still referencing Astro patterns | Medium | ~60–90 min | Medium |
| [005](./005-consolidate-entity-type-definitions.md) | Consolidate EntityType defined in 4 separate places | Medium | ~45–60 min | Medium |
| [006](./006-validation-engine-improvements.md) | Extract shared validation utilities, fix duplication, add tests | Low–Med | ~90–120 min | Low |

**Total estimated effort:** ~5–7 hours

## Context

These issues were identified during a deep audit of the codebase after the Astro/Starlight → Next.js 15 migration. The migration was largely successful, but left behind cruft in three categories:

1. **Dead Astro artifacts** in content and tooling (001, 002, 004)
2. **Sync/duplication issues** from the repo split (003, 005)
3. **Technical debt** in tooling that predates the migration (006)
