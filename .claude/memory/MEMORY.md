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

## Architecture Notes
- **SCRY_PUBLIC_KEY** is duplicated in 3 files. Should be consolidated into `crux/lib/`.
- **crux/ import direction**: `lib → authoring`, never `authoring → lib`.
- **SQLite knowledge.db retired**: All data access migrated to PostgreSQL wiki-server (completed Feb 2026).
- **citation_quotes → claims migration**: Write pipelines redirected to claims system. citation_quotes table is read-only pending frontend migration (#1311).
