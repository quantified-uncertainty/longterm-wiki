## 2026-02-18 | claude/resolve-issue-244-vnx6i | Remove duplicate metrics-extractor.mjs

**What was done:** Deleted the now-unused `app/scripts/lib/metrics-extractor.mjs` file (372 lines) since the build script had already been migrated to import directly from `crux/lib/metrics-extractor.ts`. Updated two stale inline comments in `crux/authoring/creator/grading.ts` and `crux/lib/rules/frontmatter-schema.ts` that still referenced the old `.mjs` path.

**Model:** sonnet-4

**Duration:** ~10min

**Issues encountered:**
- None — the migration to the TS canonical source was already done; only cleanup remained.

**Learnings/notes:**
- The build script (`app/scripts/build-data.mjs`) uses `--import tsx/esm` via the `crux` workspace command, which allows it to import `.ts` files directly without a transpile step.
