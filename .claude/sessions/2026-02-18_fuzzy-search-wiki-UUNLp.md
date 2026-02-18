## 2026-02-18 | claude/fuzzy-search-wiki-UUNLp | Add ID stability check for entity numeric IDs

**What was done:** Implemented a pre-build check in `build-data.mjs` that detects silent entity numeric ID reassignments (issue #148). When the build detects that a slug's numeric ID changed or an ID now points to a different slug, it reports the reassignment, scans for affected EntityLink references in MDX files, and exits with an error. Added `--allow-id-reassignment` flag for explicit opt-in override. Extracted core logic into `app/scripts/lib/id-stability.mjs` with 14 unit tests.

**Model:** opus-4-6

**Duration:** ~30min

**Issues encountered:**
- None

**Learnings/notes:**
- Entity numeric IDs are fundamentally stable because they're stored in source files (YAML/MDX frontmatter), not just the derived registry. The main risk is accidental removal of a `numericId:` field from a source file, which causes build-data to assign a new ID.
- There are 203 EntityLink references using numeric IDs (like `id="E42"`) across the content — these are the references at risk if IDs get reassigned.
