# Crux — Future Refactoring TODO (Tier 3)

These are larger refactoring items identified during the TypeScript migration review.
They require more design work and coordination but would significantly improve code quality.

## ~~1. Unify Command Handler Pattern~~ ✅ RESOLVED (no change needed)

Audit found all 9 command files already share a consistent interface:
`commands: Record<string, handler>` + `getHelp(): string`. The three
implementation patterns (buildCommands for subprocess-heavy ops, direct
exports for lightweight library calls, custom factory for resources.ts)
are each justified by their use case. No mechanical unification needed.

## 2. Break Up `resource-manager.ts`

**Problem**: At ~2050 lines, `resource-manager.ts` is a monolith handling URL validation, entity matching, YAML I/O, deduplication, and reporting.

**Suggested approach**: Split into focused modules:
- `resource-validator.ts` — URL checking and validation
- `resource-matcher.ts` — Entity matching logic
- `resource-io.ts` — YAML file read/write
- `resource-dedup.ts` — Deduplication logic
- `resource-manager.ts` — Orchestrator that imports from above

## ~~3. Move `process.exit()` Out of Library Code~~ ✅ DONE

Fixed `lib/anthropic.ts` `createClient()` — the only exported library function with
`process.exit()`. Now throws an Error instead. All other `process.exit()` calls are
in `main()` functions guarded by `if (process.argv[1] === ...)`, which is correct.

## ~~4. Standardize `--ci` / `--json` Output Behavior~~ ✅ DONE

Completed: Fixed `validate-cross-links.ts` colors bug, standardized `insights.ts`
to check `options.ci || options.json` consistently, added `'ci'` to all passthrough
lists in `analyze.ts`, `resources.ts`, `content.ts`, and `generate.ts`.

## ~~5. Resolve `PROJECT_ROOT` via `__dirname` Instead of `process.cwd()`~~ ✅ DONE

Completed: `PROJECT_ROOT` in `content-types.ts` now uses `import.meta.url` + `fileURLToPath`.
All 15+ `process.cwd()` usages across crux/ replaced with `PROJECT_ROOT` imports.
