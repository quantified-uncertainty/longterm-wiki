# Crux — Future Refactoring TODO (Tier 3)

These are larger refactoring items identified during the TypeScript migration review.
They require more design work and coordination but would significantly improve code quality.

## ~~1. Unify Command Handler Pattern~~ ✅ RESOLVED (no change needed)

Audit found all 9 command files already share a consistent interface:
`commands: Record<string, handler>` + `getHelp(): string`. The three
implementation patterns (buildCommands for subprocess-heavy ops, direct
exports for lightweight library calls, custom factory for resources.ts)
are each justified by their use case. No mechanical unification needed.

## ~~2. Break Up `resource-manager.ts`~~ ✅ DONE

Split the ~2050-line monolith into 6 focused modules:
- `resource-types.ts` — Shared types, interfaces, constants (~95 lines)
- `resource-io.ts` — YAML file read/write, publication loading (~90 lines)
- `resource-utils.ts` — URL normalization, link extraction, ID utilities (~145 lines)
- `resource-metadata.ts` — ArXiv, forum, Semantic Scholar, web metadata fetchers (~490 lines)
- `resource-validator.ts` — Validation against arXiv, Wikipedia, forums, DOIs, dates (~440 lines)
- `resource-manager.ts` — Slim CLI orchestrator with command handlers (~607 lines)

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

## 6. Migrate existing pages to use `entityType` in frontmatter

Currently ~600 pages in entity-required categories (people, organizations, risks,
responses, models, worldviews, intelligence-paradigms) rely on YAML entity definitions
in `data/entities/` instead of declaring `entityType` in their frontmatter.

The page-creator pipeline now auto-sets `entityType` for newly created pages (using
the category-to-entityType mapping in `crux/lib/category-entity-types.ts`), so new
pages get auto-entities from the frontmatter scanner at build time. But existing pages
still depend on YAML.

### Migration plan

1. **Write a script** to scan all MDX pages in entity-required categories and add
   `entityType: <type>` to their frontmatter (using the same mapping).
2. **Verify** that build-data produces identical entities after the migration
   (YAML entities still take precedence, so this is additive).
3. **Gradually** move rich entity metadata (relatedEntries, customFields) into
   frontmatter fields if desired, or keep YAML as the source for relational data.

### Why this matters

- Eliminates the two-file requirement for new pages
- Makes frontmatter self-describing (you can see the entity type without checking YAML)
- Reduces the chance of the CI failure we hit (missing entity definitions)
