# Longterm Wiki — Agent Memory

## Critical Facts
- **Website URL**: The production site is **longtermwiki.com** (specifically `https://www.longtermwiki.com`). Do NOT use `longterm.wiki`, `longtermwiki.org`, or any other domain when searching/fetching/referencing the site. The `longterm.wiki` domain does not exist.
- **Org email domain**: `quantifieduncertainty.org` — bot emails use `bot@quantifieduncertainty.org`.
- **Open Philanthropy → Coefficient Giving**: The organization formerly known as "Open Philanthropy" has been renamed to "Coefficient Giving". All content references have been updated (PR #1331, 2026-02-28).

## Recurring Gotchas
- **Worktrees need symlinks**: `ln -sf ../../../.env .env` and node_modules symlink. Without these, `crux` commands fail with missing credentials or packages.
- **Shell aliases can block file ops**: `rm -i` alias silently prevents deletion in non-interactive contexts. Use `python3 os.remove()` for scripted file deletion.
- **YAML hex-like IDs**: All-digit hex strings are parsed as integers by YAML. Use IDs containing letters for test fixtures.
- **Vitest mock hoisting**: `vi.mock()` is hoisted to file top; calling inside `it()` blocks has no effect. Use separate test files or `vi.hoisted()`.
- **pdf-parse v2 API change**: v2 uses `new PDFParse({data})` class-based API. v1's `.default()` no longer exists.
- **Regex backtracking**: `[\w\s]{2,30}` combined with `\s+` causes catastrophic backtracking. Use `\w+(?:\s+\w+){0,5}` instead.
- **Array spread overflow**: `array.push(...largeArray)` causes "Maximum call stack size exceeded" when `largeArray` has >65k elements. Use a for-of loop instead.
- **Vercel ignoreCommand exit codes are counterintuitive**: Exit 0 = **skip** build, exit 1 = **proceed** with build. The command answers "should I ignore?", so 0 (success/yes) means skip. This has been incorrectly inverted multiple times. See `apps/web/vercel.json`.

## Architecture Notes
- **SCRY_PUBLIC_KEY** is defined in `crux/lib/api-keys.ts`. All consumers import from there (consolidated Feb 2026).
- **crux/ import direction**: `lib → authoring`, never `authoring → lib`.
- **SQLite knowledge.db retired**: All data access migrated to PostgreSQL wiki-server (completed Feb 2026).
- **Statements/Claims system retired**: The entire statements and claims system was deleted in PR #1908 (March 2026). DB tables archived with `_archived_` prefix. FactBase YAML is now the sole structured facts system.
