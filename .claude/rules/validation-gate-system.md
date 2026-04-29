# Validation & Gate System

Subsystem map for the `crux/validate/` validator system, the gate check, and how checks are wired. **Read this before adding a new validator, changing gate behavior, or wondering "why didn't CI catch that?"**

## Why this file exists

There are **52 `validate-*.ts` files** in `crux/validate/` (plus ~20 test files and a handful of shared helpers). Gate logic is spread across `validate-gate.ts`, `validate-data.ts`, and `validate-daily.ts`. Agents adding a new check commonly:
- Wire it into the wrong pipeline (daily instead of gate)
- Miss the blocking-vs-advisory distinction
- Duplicate existing validators (four separate `validate-factbase-*-refs.ts` files exist)
- Write a validator without using the validator-first pattern from `.claude/rules/implementation-quality.md`

---

## The four pipelines

| Command | Purpose | File | When it runs |
|---------|---------|------|--------------|
| `pnpm crux w validate gate` | **CI-blocking pre-PR check** | `validate-gate.ts` (1096 lines) | On every PR, before merge |
| `pnpm crux w validate data` | Data-integrity subset | `validate-data.ts` (421 lines) | Called by gate + ad-hoc |
| `pnpm crux w validate daily` | Slow/expensive checks | `validate-daily.ts` (513 lines) | Nightly CI |
| `pnpm crux w validate unified` | Unified rule runner | `validate-unified.ts` (189 lines) | Fast content-only check |

**Rule of thumb**: if the check must run on every PR, add it to gate. If it's slow/expensive, daily.

## The gate orchestrator — `validate-gate.ts`

### Structure

- **`Step` interface** at line 157 — **subprocess-based, not function-based**:
  ```ts
  interface Step {
    id: string;
    name: string;
    command: string;          // e.g. 'node' or 'npx'
    args: string[];           // e.g. ['--import', 'tsx/esm', 'crux/validate/validate-my-check.ts']
    cwd: string;              // where to run from
    advisory?: boolean;       // true = failure reported but doesn't block
    emitOutputInCi?: boolean; // print captured output in CI even on success
    requiresServer?: boolean; // auto-advisory when wiki-server unreachable
  }
  ```
  Note: the gate does NOT call an in-process `run()` function — each check is a **separate subprocess** spawned with `command` + `args`. This is what allows parallel execution without blocking the main process.
- **Sequential steps** at top (ID allocation, build-data — other steps depend on these)
- **`runSequential()`** (line 809), **`runParallel()`** (line 828) — the subprocess runners
- **`gate-triage.ts`** — LLM optimization that predicts which checks can be skipped based on the diff, to reduce CI time. Fail-closed: on error, runs everything.

### Adding a new check to the gate

1. Write your validator as `crux/validate/validate-<name>.ts`. Make it runnable standalone: `npx tsx crux/validate/validate-<name>.ts` exits 0 on pass, non-zero on fail. Emit errors to stderr.
2. Add an entry to the `parallelChecks` array in `validate-gate.ts`, grouped with similar checks:
   ```ts
   {
     id: 'my-check',
     name: 'My new check',
     command: 'npx',
     args: ['tsx', 'crux/validate/validate-my-check.ts'],
     cwd: PROJECT_ROOT,
     // advisory: true,  // uncomment for non-blocking
   }
   ```
3. Decide blocking (default) vs `advisory: true`. New rules enforcing a freshly-applied pattern should be blocking so the pattern doesn't regress.
4. Add a test file `crux/validate/validate-<name>.test.ts` — most validators have one.

## The 50+ gate checks (reference, as of 2026-04)

Selected from `validate-gate.ts::parallelChecks`. Line numbers in the file.

### Content & syntax (blocking)
- `Unified blocking rules` — MDX syntax, frontmatter, wiki IDs, EntityLink, pipeline artifacts
- `YAML schema`
- `MDX compilation smoke-test` (advisory)

### Code quality (blocking)
- `.returning() guard check` — Drizzle writes must handle empty return
- `Drizzle migration journal integrity` — unique prefixes
- `No untyped row casts in routes` — blocks `(r: any)` in wiki-server
- `No console.log in server code`
- `No inline limit clamping in routes (use clampedLimit)`
- `Prompt XML interpolation escaping` — enforces `escapeXml()`
- `Data-integrity anti-patterns` — silent catch, `as any` in routes, `skipEntityValidation` without reason
- `Direct apiRequest<T> calls (QUA-770)` — must use typed wiki-server client or `// typed-client-ok: <reason>` marker

### TypeScript (blocking/advisory)
- `TypeScript type check — app` (blocking)
- `TypeScript type check — crux` (advisory)

### FactBase / TableBase (blocking)
- `FactBase lookups use stableIds (not slugs)` (328)
- `FactBase entity coverage` (430) — every FactBase file has TableBase entry
- `FactBase ↔ TableBase entity ID consistency` (439) — duplicates, stableId mismatches
- `FactBase record ref resolution` (512)
- `Soft FK entity reference validation` (521, advisory)
- `Person reference validation` (696)

### Entities / IDs (blocking)
- `Entity reference integrity (KB records)` (419)
- `KB entity slug validation` (448)
- `YAML entity reference integrity` (457)
- `Orphan entity detection (PG without YAML source)` (487)
- `No sid_ values in display name columns` (500)
- `Rendered SID check (no sid_ leaks in built data)` (706)
- `Display name quality (no raw machine IDs in titles)` (666)

### Temporal / numeric (blocking)
- `Temporal invariant validation` (466)
- `PG temporal consistency` (534)
- `Numeric range validation (low ≤ high)` (558)
- `Controlled vocabulary validation` (546)

### Source-check / completeness (blocking)
- `TableBase source-check coverage` (650)
- `Tablebase route completeness` (676) — delete, things sync, entity ref validation
- `Dot indicator position` (352) — SourceCheckDot / RecordStatusDots not in first column
- `Display formatting quality` (686) — no `[object Object]`, no unescaped MDX in titles

### Resources (blocking/advisory)
- `Resource reference validation` (570, advisory)
- `Resource data quality` (583)

### Cross-base consistency (blocking)
- `Cross-base consistency` (594) — WikiBase / TableBase / FactBase alignment
- `Related entry type mismatches` (606)
- `Component reference validation` (381)

### Advisory-only
- `Directory page data quality`
- `Cross-page numeric consistency`
- `Stale content detection`
- `Cross-page date consistency`

## Shared infrastructure in `crux/validate/`

Non-validator files you should know exist before writing new helpers:

- `types.ts` — shared `ValidatorResult` / `ValidatorOptions` types
- `gate-triage.ts` (+ `.test.ts`) — LLM diff-based skip predictor, called from `validate-gate.ts`
- `cross-entity-consistency.ts` — cross-file invariant helper
- `check-staleness.ts` — staleness check utility
- `to-rdjsonl.ts` — rdjsonl output formatter
- `cross-check-people.ts` — person reference cross-check helper
- `__tests__/` — test-only validators (e.g. `validate-prompt-escaping.test.ts`)

## The validators (by concern)

Grouped by what they check. **Before writing a new validator, grep this list.**

- **Entity refs**: `entity-refs`, `yaml-entity-refs`, `component-refs`, `resource-refs`, `kb-entity-slugs`, `person-refs`, `soft-fks`
- **FactBase**: `factbase-entities`, `factbase-entity-ids`, `factbase-stableid`, `factbase-record-refs`, `factbase-schema`
- **IDs / SIDs**: `rendered-sid`, `sid-display`, `display-names`
- **Schema / compile**: `yaml-schema`, `mdx-compile`, `temporal`, `numeric-consistency`, `controlled-vocab`
- **Code quality**: `no-console-log`, `returning-guard`, `untyped-rows`, `prompt-escaping`, `dangerous-patterns`, `drizzle-journal`, `typed-client`
- **Source-check**: `source-check-coverage`, `source-check-names`, `tablebase-completeness`, `dot-position`, `display-formatting`
- **Content quality**: `hallucination-risk`, `financials`, `cross-base`, `cross-page-dates`, `stale-content`, `related-entry-types`, `directory-pages`
- **Infra**: `inline-pagination`
- **Resources**: `resource-refs`, `resource-quality`, `orphan-entities`
- **Data integrity**: `data`, `consistency`, `quality`, `daily`, `unified`

## Validator-first pattern (read `.claude/rules/implementation-quality.md`)

When applying a structural rule across >5 files, **write the validator first**, then fix violations using its output as the work queue. A validator is cheaper than trusting grep to find everything.

Four complexity tiers:
1. **Text pattern** (banned import, naming) → regex scan
2. **Structural pattern** (component position in JSX) → line state machine (`validate-dot-position.ts`)
3. **Cross-file invariant** (unique IDs, matching FKs) → load + check in memory (`validate-drizzle-journal.ts`)
4. **Runtime check** (rendered output) → Playwright e2e (`e2e/render-audit.spec.ts`)

## Adding functionality — checklist

1. **Does a similar validator exist?** Grep the list above first.
2. **Wire it into gate, not daily**, if it must run on every PR.
3. **Blocking vs advisory**: blocking unless you have a documented reason (see `validate-gate.ts` comments on fail-open exceptions — e.g., `assign-ids`, `typecheck-crux`, `mdx-compile`, `gate-triage`).
4. **Standalone-runnable**: `npx tsx crux/validate/validate-<name>.ts` should work.
5. **Test file**: add `validate-<name>.test.ts` — most validators have one.
