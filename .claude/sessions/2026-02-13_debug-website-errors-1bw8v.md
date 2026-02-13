## 2026-02-13 | claude/debug-website-errors-1bw8v | Fix validation errors and broken references

**What was done:** Fixed 5 failing validation checks (255 broken EntityLink references, DataInfoBox numeric ID resolution, graph sync, broken internal link) by repairing validator bugs and correcting content. All 28 validation checks now pass, all 322 tests pass, and the Next.js build succeeds.

**Issues encountered:**
- `crux/validate/validate-component-refs.ts` `loadEntities()` read `database.entities` which doesn't exist (database uses `typedEntities`)
- `crux/validate/validate-data.ts` didn't resolve numeric entity IDs (E43-style) from id-registry.json
- `crux/validate/validate-graph-sync.ts` had a hardcoded list of entity files that was missing the per-factor subitem files
- `crux/lib/rules/component-refs.ts` `isInternalDoc` check used `includes('/internal/')` but relativePath lacks leading slash
- 169 unique broken EntityLink IDs across 63 MDX files: 67 path-style IDs and 103 missing entity slugs

**Learnings/notes:**
- The standalone validator (`crux/validate/validate-component-refs.ts`) and unified rule (`crux/lib/rules/component-refs.ts`) are separate implementations with different bugs
- Entity files in `data/entities/` can be split into per-factor files (e.g., `ai-transition-model-subitems-*.yaml`); validators must discover them dynamically
- `ContentFile.relativePath` is relative to `content/docs/`, not the project root, so path checks need to account for the missing leading slash
