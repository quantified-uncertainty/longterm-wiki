## 2026-02-15 | claude/document-website-architecture-Pc7sh | Document website architecture and clever ideas

**What was done:** Rewrote the internal architecture documentation page (`content/docs/internal/architecture.mdx`) from scratch. The old version referenced Astro/Starlight, outdated file paths, and `npm` commands, and was missing most of the system's clever architectural patterns. The new version documents 17 novel design patterns with source locations, covers the current Next.js 15 tech stack, and updates all file paths, commands, and diagrams to match the current codebase.

**Pages:** architecture

**PR:** #150

**Issues encountered:**
- `pnpm install` failed due to puppeteer network issues in the sandbox, preventing full build and test runs. All three blocking CI validations passed via direct `node crux/crux.mjs` invocation.

**Learnings/notes:**
- The architecture.mdx was substantially outdated (still referencing Astro, `npm run`, old `src/data/` paths). Future sessions touching the build pipeline or data layer should check that this page stays current.
- The "Clever Ideas" section (17 patterns) provides a useful catalog of non-obvious design decisions. When adding new patterns to the codebase, add them here.
