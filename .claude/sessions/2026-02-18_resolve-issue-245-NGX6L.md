## 2026-02-18 | claude/resolve-issue-245-NGX6L | Fix build-data.mjs ID write-back side effect (issue #245)

**What was done:** Created `app/scripts/assign-ids.mjs` as a dedicated pre-build step that handles all numericId assignment and file writes. Modified `build-data.mjs` to be purely read-only (no source file mutations during build). Updated `app/package.json` `prebuild`/`sync:data` scripts to run `assign-ids.mjs` before `build-data.mjs`.

**Pages:** (none — infrastructure-only change)

**Model:** sonnet-4-6

**Duration:** ~45min

**Issues encountered:**
- YAML entities without numericIds caused a stability check failure on the second run: assign-ids.mjs was writing those entities' in-memory IDs to the registry, then on the next run the IDs changed (because MDX file IDs are reserved before entity IDs are assigned, shifting the counter). Fixed by skipping YAML entities in assign-ids.mjs assignment — they need manual numericId addition to source YAML.
- `_fullPath` was already deleted from page objects before the page ID write-back loop in build-data.mjs (line 1384 deletes it, but page ID assignment is at line 1512+). This was a pre-existing bug where page IDs were assigned to the registry but never written to MDX frontmatter. Fixed by having assign-ids.mjs handle this correctly.
- Index pages (`index.mdx` → `__index__/prefix` IDs) were omitted from initial assign-ids.mjs scan. Fixed to match build-data.mjs behavior.

**Learnings/notes:**
- The old build-data.mjs had a silent bug: `page._fullPath` was deleted before the page ID write-back, so page IDs were written only to id-registry.json (in-memory), never to MDX frontmatter. Since page order is deterministic, the same IDs were reassigned each build — so it was stable by accident, not by design.
- YAML entities without numericIds should be added manually (or via `crux content create`). assign-ids.mjs warns about them but correctly skips them to maintain registry stability.
- The `data/id-registry.json` written by assign-ids.mjs only includes IDs backed by source files. build-data.mjs can still write additional in-memory IDs (for YAML entities), but these are transient.
