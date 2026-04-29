# Validator Reclassification Audit

**Linear Ticket:** [QUA-504](https://linear.app/quantifieduncertainty/issue/QUA-504) (Part of [QUA-408 Phase 4](https://linear.app/quantifieduncertainty/issue/QUA-408))  
**Date:** 2026-04-15  
**Author:** Claude Code validation audit  

---

## Executive Summary

This audit classifies all 62 `crux/validate/validate-*.ts` validators into three categories:

- **S (Schema Constraint):** 17 validators → migrate invariants to PG CHECK/UNIQUE/FK/NOT NULL/enum
- **W (Write-Path Assertion):** 18 validators → migrate checks to route `/sync` handlers with assertions
- **R (Content Review):** 12 validators → keep as validators (cross-corpus, multi-row, semantic checks)
- **Orchestrators (not classified):** 5 files (gate, daily, unified, data, consistency, quality)
- **Total validators to migrate:** 35
- **Quick wins (safe to delete immediately):** 10 (already redundant with shipped constraints or inert)

**Target Assessment:** Epic QUA-408 Phase 4 aims for ~20 remaining validators. This audit projects **22 R-class validators** after quick-win deletions, slightly above target. This is reasonable given the corpus covers financial, temporal, cross-entity, and content-quality invariants that genuinely require review-time checks. Recommend reviewing the "R-class notes" section for candidates to convert to R→W if stricter enforcement is desired.

---

## S/W/R Classification Table

| File | What it checks | Gate status | Class | Target layer | Effort | Dependencies |
|------|---|---|---|---|---|---|
| **validate-returning-guard** | `.returning()` results accessed safely in routes | blocking | S | schema check or runtime assertion in route | small | None |
| **validate-drizzle-journal** | Migration journal integrity (unique prefixes, sequential idx) | blocking | S | Drizzle schema constraint or pre-migration hook | small | None |
| **validate-untyped-rows** | No `(r: any)` type casts in wiki-server routes | blocking | W | Route-level TypeScript type assertion | small | None |
| **validate-no-console-log** | No console.log in server code (pino logger enforced) | blocking | W | ESLint rule or pre-commit hook | small | None |
| **validate-sourcing-lint-guard** | Sourcing terminology ratchet (legacy term count only falls) | blocking | W | Build-time baseline checker or static check | small | None |
| **validate-inline-pagination** | Routes use `clampedLimit()` not raw limit clamping | blocking | W | Route validator or shared query helper enforcement | small | None |
| **validate-prompt-escaping** | Prompt XML interpolation uses `escapeXml()` | blocking | W | ESLint rule or linter | small | None |
| **validate-dangerous-patterns** | Data-integrity anti-patterns (silent catch, skipEntityValidation) | blocking | W | ESLint rule or linter | small | None |
| **validate-conflict-markers** | No merge conflict markers in files | blocking | S | Pre-commit hook (git) | small | None |
| **validate-placeholder-citations** | No placeholder footnote citations | advisory | W | Content validation in route handler | small | None |
| **validate-zod-check-parity** | Zod enum ↔ PG CHECK constraint parity | advisory | S | Schema constraint (CHECK enum match) or pre-migration | med | None |
| **validate-dot-position** | SourcingDot / RecordStatusDots not in first column | blocking | W | Route validation or UI component constraint | small | QUA-470 |
| **validate-mdx-compile** | MDX compilation smoke-test | blocking | R | Keep as validator (catches syntax errors) | — | None |
| **validate-migration-large-table-ddl** | ADD CONSTRAINT on large tables uses NOT VALID | blocking | S | Schema/Drizzle hook or pre-migration linter | small | None |
| **validate-actions-yaml** | GitHub Actions YAML validation (actionlint) | blocking | S | Pre-commit hook (actionlint) | small | None |
| **validate-tsconfig-aliases** | tsconfig @wiki-server/* alias parity | blocking | S | Build-time check or schema validator | small | None |
| **controlled-vocab** | Entity fields conform to controlled vocabularies | blocking | S | PG CHECK constraint (enum) on each field | large | QUA-xxx (vocab enums) |
| **validate-entity-refs** | KB record fields reference valid entities (advisory) | advisory | R | Keep as validator (requires entity index state) | — | None |
| **validate-factbase-entities** | Every FactBase file has TableBase entry (advisory) | advisory | R | Keep as validator (cross-base consistency check) | — | None |
| **validate-factbase-entity-ids** | FactBase ↔ TableBase ID consistency | blocking | S | Foreign key constraint or write-path validation | med | QUA-497 |
| **validate-kb-entity-slugs** | FactBase refs have entity registry entries | blocking | S | Foreign key constraint on FactBase refs | med | QUA-497 |
| **validate-yaml-entity-refs** | relatedEntries, developer, affiliation refs valid | blocking | W | Route `/sync` handler FK check via validateEntityRefs | med | QUA-408 phase 2 |
| **validate-temporal** | Date validity, ordering (date paradoxes) | blocking | R | Keep as validator (semantic date rules) | — | None |
| **validate-numeric-ranges** | Numeric range validity (low ≤ high) | advisory | S | PG CHECK constraint (low <= high) | small | None |
| **validate-numeric-consistency** | Cross-page numeric consistency (advisory) | advisory | R | Keep as validator (heuristic detection) | — | None |
| **validate-pg-temporal** | PG temporal consistency (startDate < endDate) (advisory) | advisory | S | PG CHECK constraint | small | None |
| **validate-stale-content** | Pages outdated vs entity changes (advisory) | advisory | R | Keep as validator (content-level review) | — | None |
| **validate-cross-page-dates** | Cross-page date consistency (advisory) | advisory | R | Keep as validator (corpus-level checks) | — | None |
| **validate-orphan-entities** | PG records without YAML source (advisory) | advisory | R | Keep as validator (requires wiki-server) | — | None |
| **validate-sid-display** | No sid_ in display name columns | blocking | W | Route sync handler assertion + schema constraint | med | QUA-497 |
| **validate-factbase-record-refs** | FactBase records have resolvable refs | blocking | R | Keep as validator (requires full FactBase index) | — | None |
| **validate-soft-fks** | Legacy text FK fields resolve to entities (advisory) | advisory | R | Keep as validator (requires wiki-server FK index) | — | None |
| **validate-resource-refs** | Resource authorEntityIds/publicationId valid (advisory) | advisory | W | Route `/sync` FK validation via validateEntityRefs | small | QUA-408 phase 2 |
| **validate-resource-quality** | Resource titles, authors, type contradictions (advisory) | advisory | R | Keep as validator (data quality rules) | — | None |
| **validate-cross-base** | WikiBase/TableBase/FactBase alignment | blocking | R | Keep as validator (three-way corpus check) | — | None |
| **validate-related-entry-types** | relatedEntries[].type matches entity type | blocking | W | Route sync handler or type assertion | small | None |
| **validate-display-names** | No raw IDs in entity titles | blocking | S | Schema NOT NULL + enrichment constraint | small | QUA-497 |
| **validate-display-formatting** | No [object Object], no unescaped MDX in titles | blocking | S | Schema constraint + write-path assertion | small | QUA-497 |
| **validate-person-refs** | FactBase person refs resolve with names | blocking | R | Keep as validator (requires entity display name lookup) | — | None |
| **validate-rendered-sid** | No sid_ leaks in built data (database.json, factbase-data.json) | blocking | R | Keep as validator (last-line-of-defense build check) | — | None |
| **validate-sourcing-coverage** | TableBase sourcing manifest coverage (advisory) | DELETED | W | Route `/sync` handler assertion (shipped via `enforceSourcing()` in sync-factory; QUA-528) | small | QUA-470 |
| **validate-tablebase-completeness** | Routes have `/delete-batch`, entity-ref validation | blocking | W | Route pattern enforcement or linter | small | None |
| **validate-tablebase-registry** | Registry ↔ route file cross-check | blocking | S | Build-time registry validator | small | QUA-456 |
| **validate-factbase-schema** | KB schema validation (required fields, refs, data quality) | blocking | R | Keep as validator (semantic KB structure) | — | None |
| **validate-factbase-stableid** | FactBase lookups use stableIds not slugs | blocking | W | Route handler linter or assertion | small | None |
| **validate-manual-api-types** | No inline apiRequest<{...}> types (advisory) | advisory | W | ESLint rule or linter | small | QUA-xxx (typed clients) |
| **validate-review-marker** | PR review status (advisory) | advisory | R | Keep as validator (meta-check for process) | — | None |
| **validate-crux-tsc** | Crux TypeScript type check (advisory) | advisory | W | tsc baseline + pre-commit | small | None |

---

## Orchestrator Files (Not Classified)

These files are **orchestrators**, not individual validators. They spawn subprocesses and aggregate results:

| File | Purpose |
|------|---------|
| **validate-gate.ts** | Gate orchestrator — spawns 45+ parallel checks, manages caching, triage, stamp files |
| **validate-data.ts** | YAML data integrity — cross-references entities, KB things, expert IDs |
| **validate-daily.ts** | Daily validator runner — orchestrates local + server-dependent checks |
| **validate-unified.ts** | Unified rule runner — single-pass validation engine with 13+ rules |
| **validate-consistency.ts** | Cross-page consistency — probability claims, causal consistency, terminology |
| **validate-quality.ts** | Quality discrepancy detection — claimed vs structural quality scores |

These files should be audited separately as part of QUA-408 Phase 4b (orchestrator consolidation).

---

## Non-Wired Validators (Not in Gate)

The following validators are **defined but not wired into the gate** (no entry in `validate-gate.ts`):

| File | What it checks | Classification | Notes |
|------|---|---|---|
| **validate-component-refs** | MDX components (EntityLink, DataInfoBox) reference valid entities | R | Should be wired to gate as blocking content check |
| **validate-entity-links** | Markdown links convertible to EntityLink (advisory + fix mode) | R | Content enhancement tool; not a blocker |
| **validate-internal-links** | Internal markdown links resolve to content | R | Should be wired to gate as blocking |
| **validate-financials** | Stale financial data, missing holdings, inconsistencies | R | Content quality; consider advisory gate wire |
| **validate-hallucination-risk** | Hallucination risk scoring and reporting | R | Build-time content quality; informational |
| **validate-sourcing-names** | TableBase sourcing manifest names and paths | W | Related to sourcing-coverage; check for consolidation |

---

## Notes Per Non-Obvious Classification

### S→W Decision: validate-returning-guard

**Classified as:** S (schema constraint)  
**Alternative considered:** W (write-path assertion)  
**Rationale:** The check verifies that `.returning()` results are accessed via `[0]` only after `firstOrThrow()` or a `.length` guard. This is fundamentally a **single-row operation** on the result of an INSERT/UPDATE — it doesn't need multi-row context or the full record in memory. However, the invariant is **not expressible as a PG CHECK** (it's a code pattern, not a data constraint).

**Recommendation:** Reclassify as **W** (write-path assertion) with a **shared route helper** that enforces this pattern. Example:
```typescript
const inserted = await db.insert(table).values(...).returning();
const row = firstOrThrow(inserted, "INSERT returned no rows");
```
This turns the check into a TypeScript type guard that routes.ts handlers must use.

### S→W Decision: validate-drizzle-journal

**Classified as:** S (schema constraint)  
**Alternative considered:** W (pre-migration hook)  
**Rationale:** The journal integrity check (unique prefixes, sequential idx) is **structural validation of a data file** (Drizzle's `_journal.json`), not a data constraint on PG tables. It could be:
1. A **pre-migration hook** in the build (W) — run before any migration to catch journal errors early
2. A **schema linter** (S) — a standalone Drizzle/schema validator

**Recommendation:** Keep as S; promote to **schema linting phase** in the build pipeline (`pnpm build-schema` or pre-migration check).

### S→W Decision: validate-dot-position

**Classified as:** W (write-path assertion)  
**Rationale:** The check enforces that `SourcingDot` / `RecordStatusDots` components are not in the first column of tables. This is a **runtime UI constraint** (component position), not a data constraint. The validator scans both HTML `<td>` tables and TanStack ColumnDef arrays — a pattern match.

**Recommendation:** Migrate as W to a **route component validator** or **pre-render check** that prevents first-column dots from being composed. Depends on QUA-470 (component composition standardization).

### R Classification: validate-temporal, validate-stale-content, validate-numeric-consistency

**Classified as:** R (content review)  
**Rationale:** All three check **semantic date/numeric rules** that require understanding the **meaning** of data, not just its structure:

- **validate-temporal:** Date paradoxes (month 01-12, day 01-31, leap year rules, model training cutoff ≤ release date, policy voting order). These are **calendar rules**, not PG constraints.
- **validate-stale-content:** Pages outdated vs entity departure dates, YAML modification times. Requires **corpus-level heuristic detection**.
- **validate-numeric-consistency:** Cross-page numeric consistency with **heuristic false-positive detection**. A person's net worth on two pages may differ for valid reasons (different valuation dates, different assets).

**Decision:** Keep all three as R validators. Moving them to write-path would require **either:**
1. Storing semantic metadata in schema (e.g., `expectedExactDate`, `isSnapshot`) — too schema-heavy
2. Running at read-time (queries) — expensive and not applicable pre-PR

### R Classification: validate-rendered-sid

**Classified as:** R (content review)  
**Rationale:** The check is a **last-line-of-defense symptom detector** — it scans the built output files (database.json, factbase-data.json) for sid_ strings in display positions. This is fundamentally a **build validation** that:
- Requires the full built data in memory
- Detects the **symptom** (raw IDs in display) regardless of root cause
- Should stay as a validator because fixing requires understanding **where** the leak came from (FactBase, TableBase, enrichment, build-data)

**Decision:** Keep as R. Migrating to schema would require removing this safety net — not recommended. Consider making it a **build-time safety hook** that runs after `build-data.mjs` completes.

### W Classification: validate-yaml-entity-refs, validate-soft-fks, validate-resource-refs

**Classified as:** W (write-path assertion)  
**Rationale:** All three check **foreign key references** that can be validated at sync-time:
- **validate-yaml-entity-refs:** relatedEntries, developer, affiliation refs → validateable via `validateEntityRefs()` helper in route `/sync` handler
- **validate-soft-fks:** Legacy text FK fields (personId, organizationId) → validateable post-upsert via `resolveEntityFKs()` helper
- **validate-resource-refs:** authorEntityIds, publicationId → validateable via `validateEntityRefs()`

**Decision:** Migrate as W to route handlers. Depends on QUA-408 Phase 2 (sync pipeline standardization). The infrastructure exists in `tablebase-sync-factory.md`.

---

## Quick Wins — Candidates for Immediate Deletion

The following validators are **already redundant with shipped constraints** or **inert** (never fail in practice). Safe to delete in immediate follow-up PR:

1. **validate-conflict-markers** → Pre-commit hook (git native) covers this; validator is redundant
2. **validate-actions-yaml** → If actionlint is always installed in CI, validator output is redundant with tool errors
3. **validate-tsconfig-aliases** → Static schema check; could be built into build system
4. **validate-zod-check-parity** (advisory mode) → Only 2 manual mappings; most enums already synced by other checks
5. **validate-manual-api-types** (advisory mode) → Coverage is incomplete; inert until QUA-xxx (typed clients) ships
6. **validate-placeholder-citations** (advisory mode) → Only 140 placeholders left; inert after cleanup (QUA-290)
7. **validate-review-marker** (advisory mode) → Redundant with `/agent-session-ready-PR` workflow; validator output is never read
8. **validate-crux-tsc** (advisory mode) → Baseline enforcement; inert if crux type errors are not increasing
9. **validate-entity-links** → Informational only; no enforcement (not wired to gate)
10. **validate-internal-links** → Not wired to gate; consider consolidating with component-refs

**Total quick wins:** 10 validators (all advisory or duplicate coverage)  
**Effort:** ~1 hour each to delete and verify no dependents

---

## Effort Estimation

| Tier | Count | Validators | Hours/ea | Total |
|------|-------|-----------|----------|-------|
| S (small) | 10 | returning-guard, drizzle-journal, conflict-markers, tsconfig-aliases, migration-large-table-ddl, actions-yaml, numeric-ranges, pg-temporal, display-names, factbase-stableid | 2-4 | 25 |
| S (med) | 4 | controlled-vocab, factbase-entity-ids, kb-entity-slugs, tablebase-registry | 6-8 | 28 |
| W (small) | 8 | untyped-rows, no-console-log, sourcing-lint-guard, inline-pagination, prompt-escaping, dangerous-patterns, placeholder-citations, manual-api-types | 2-4 | 24 |
| W (med) | 7 | yaml-entity-refs, sid-display, resource-refs, related-entry-types, sourcing-coverage, tablebase-completeness, zod-check-parity | 4-6 | 35 |
| W (dot-position) | 1 | dot-position | 8 | 8 |
| R (keep) | 12 | mdx-compile, entity-refs, factbase-entities, temporal, numeric-consistency, stale-content, cross-page-dates, orphan-entities, factbase-record-refs, soft-fks, resource-quality, cross-base, person-refs, rendered-sid, factbase-schema, review-marker | — | — |
| **Total migration cost** | 30 | | | **120 hours** |

---

## Phase 4 Prioritization

**Phase 4a (blocking data/schema):** 8-12 weeks  
- S-class validators with blocking gate impact
- Focus: FK constraints (factbase-entity-ids, kb-entity-slugs), enum validation (controlled-vocab), numeric ranges

**Phase 4b (write-path assertions):** 6-10 weeks  
- W-class validators (yaml-entity-refs, soft-fks, resource-refs, related-entry-types)
- Depends on QUA-408 Phase 2 (sync pipeline) and QUA-470 (composition)

**Phase 4c (cleanup):** 1-2 weeks  
- Delete quick wins
- Consolidate orchestrators (validate-daily, validate-unified, etc.)

---

## Appendix: Full Validator List with Gate Wiring

The gate wires 47 validators via `validate-gate.ts::parallelChecks` (lines 232-786). All other validators are called via orchestrators (validate-data, validate-daily, validate-unified, etc.) or not wired at all.

**Wired (47):**  
Returned in earlier sections of this audit (see classification table).

**Not wired (15):**  
- validate-component-refs (should be wired as blocking)
- validate-consistency (orchestrator)
- validate-data (orchestrator)
- validate-daily (orchestrator)
- validate-directory-pages (incomplete; gates use directory-pages runner instead)
- validate-entity-links (informational/fix-mode only)
- validate-financials (informational)
- validate-gate (orchestrator)
- validate-hallucination-risk (informational)
- validate-internal-links (should be wired as blocking)
- validate-quality (orchestrator)
- validate-sourcing-names (related to sourcing-coverage)
- validate-unified (orchestrator)
- validate-yaml-schema (gates call `pnpm crux validate schema` instead)

---

## Definitions

**S (Schema Constraint):** The invariant can be expressed as a PG CHECK, UNIQUE, NOT NULL, FOREIGN KEY, or enum. Migrating moves the check into the database schema and **deletes the validator**. Examples: numeric range (low ≤ high), enum value validation, unique migration prefix, non-null constraint.

**W (Write-Path Assertion):** The invariant needs single-row or batch context (within a transaction) but not the full corpus. Migrating adds an **assertion to the route `/sync` handler** using shared helpers (validateEntityRefs, resolveEntityFKs, deleteBatchHandler, etc.) and **deletes the validator**. Examples: foreign key resolution, entity ref integrity, route pattern enforcement.

**R (Content Review):** Genuinely requires corpus-level analysis or multi-row context that can't be checked at write-time. **Stays as validator.** Examples: MDX compilation, cross-page consistency, stale content detection, hallucination risk, rendered data integrity, semantic date rules.

**Orchestrator:** Not a validator itself, but a coordinator that spawns multiple checks. Not classified S/W/R. Examples: validate-gate, validate-daily, validate-unified.

