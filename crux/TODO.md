# Crux — Future Refactoring TODO (Tier 3)

These are larger refactoring items identified during the TypeScript migration review.
They require more design work and coordination but would significantly improve code quality.

## 1. Unify Command Handler Pattern

**Problem**: Three incompatible patterns exist for command handlers:
- `buildCommands()` with `SCRIPTS` map (subprocess delegation) — used by `validate.ts`, `fix.ts`, `analyze.ts`, `generate.ts`
- Direct async exports with `commands` registry — used by `gaps.ts`, `insights.ts`, `resources.ts`
- Hybrid approach — used by `updates.ts`, `content.ts`

**Suggested approach**: Standardize on the direct export + `commands` registry pattern. Convert `buildCommands()`-based handlers to use direct exports where the command logic is simple enough. Keep subprocess delegation only for truly heavy scripts that benefit from isolation.

## 2. Break Up `resource-manager.ts`

**Problem**: At ~2050 lines, `resource-manager.ts` is a monolith handling URL validation, entity matching, YAML I/O, deduplication, and reporting.

**Suggested approach**: Split into focused modules:
- `resource-validator.ts` — URL checking and validation
- `resource-matcher.ts` — Entity matching logic
- `resource-io.ts` — YAML file read/write
- `resource-dedup.ts` — Deduplication logic
- `resource-manager.ts` — Orchestrator that imports from above

## 3. Move `process.exit()` Out of Library Code

**Problem**: Several library/utility files call `process.exit()` directly, making them hard to test and reuse:
- `resource-manager.ts`
- `page-improver.ts`
- `page-creator.ts`
- Various authoring scripts

**Suggested approach**: Have library functions throw errors or return error codes. Only the CLI entry point (`crux.mjs`) and top-level script shebangs should call `process.exit()`.

## 4. Standardize `--ci` / `--json` Output Behavior

**Problem**: Inconsistent handling of `--ci` and `--json` flags across commands:
- Some commands treat `--ci` as JSON output
- Some have separate `--json` and `--ci` flags with different behavior
- Some commands don't support either flag

**Suggested approach**: Define a convention:
- `--json` = structured JSON output (for programmatic consumption)
- `--ci` = machine-friendly output (no colors, no progress bars, possibly JSON)
- All commands should support both flags consistently

## ~~5. Resolve `PROJECT_ROOT` via `__dirname` Instead of `process.cwd()`~~ ✅ DONE

Completed: `PROJECT_ROOT` in `content-types.ts` now uses `import.meta.url` + `fileURLToPath`.
All 15+ `process.cwd()` usages across crux/ replaced with `PROJECT_ROOT` imports.
