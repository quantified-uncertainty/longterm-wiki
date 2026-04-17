# Three Bases Architecture — Quick Reference

Subsystem map for the TableBase / FactBase / WikiBase architecture. **Read this before adding a new data type, writing a new sync, or using the word "entity" in a commit message** — the naming is overloaded and agents repeatedly pick the wrong layer.

**Canonical source**: the wiki page at `content/docs/internal/data-architecture.mdx` (E1334) has the full version with mermaid diagrams, table inventories, and migration history. This file is the *agent cheat-sheet* — read this first, follow the link if you need depth.

> **For the cross-base `things` table specifically**: see `docs/audits/things-denormalization-audit.md` for the full write-site inventory, the `search_vector` GENERATED column constraint, and the `*_display_name` sibling pattern audit. Directly informs how [QUA-408](https://linear.app/quantifieduncertainty/issue/QUA-408) Tier 4b will normalize this layer.

---

## The three layers

| Base | What it stores | Source of truth | Access module |
|------|----------------|-----------------|----------------|
| **TableBase** | Typed relational records (entities, resources, publications, orgs) | `data/entities/*.yaml`, `data/resources/*.yaml` | `apps/web/src/data/tablebase.ts` |
| **FactBase** | Structured triples with temporal data + provenance | `packages/factbase/data/fb-entities/*.yaml` | `apps/web/src/data/factbase.ts` |
| **WikiBase** | Long-form MDX articles | `content/docs/**/*.mdx` | `Page` interface in `tablebase.ts` |

PG has read mirrors of all three. YAML/MDX is authoritative; PG is queryable.

## The word "entity" is overloaded — this bites agents constantly

| Where you see it | What it means |
|------------------|---------------|
| `data/entities/*.yaml` | YAML catalog entry (slug-based ID like `anthropic`) |
| `entities` PG table | Read mirror of the YAML catalog |
| `packages/factbase/data/fb-entities/anthropic.yaml` | **FactBase** entity (10-char ID like `mK9pX3rQ7n`) |
| `factbase.ts::getFactBaseEntity()` | Returns FactBase entity by slug OR 10-char ID |

**Bridge**: `factbase-data.json` has a `slugToEntityId` map. If you're confused about which "entity" you hold, check: `sid_` prefix or 10 chars alphanumeric = FactBase; plain slug = TableBase.

## The word "things" — unambiguous as of QUA-501

The PG `things` table is the **cross-base universal search index** — it fans in rows from entities, facts, grants, resources, personnel, etc. so search can hit one table. It is **not** a FactBase concept; `source_table` + `source_id` columns point back to the originating record.

> **Historical note**: FactBase entity YAML used to live at `packages/factbase/data/things/`, which collided with the PG table name and was the #1 source of "which things is this?" confusion. QUA-501 renamed that directory to `packages/factbase/data/fb-entities/`. When you read "things" anywhere in the codebase today, it unambiguously means the PG search-index table.

## The word "facts" is also overloaded

| Where you see it | What it means |
|------------------|---------------|
| `packages/factbase/data/fb-entities/*.yaml` `facts:` blocks | **Authoritative** FactBase YAML facts |
| `facts` PG table | Read mirror of FactBase YAML. Will become primary source once PG schema includes all Fact fields (`validEnd`, `currency`, etc.) |
| `tablebase.ts::Fact` interface | Legacy bridge type for calc-engine, old components |

> **Note**: The old `data/facts/*.yaml` directory has been **removed**. If you see a doc or comment referring to it, it's stale. Don't look for it.

**Rule**: new structured facts go in FactBase YAML (`packages/factbase/data/fb-entities/*.yaml`). Period. Use `<FBF>` / `<FBFactValue>` / `<Calc>` in MDX.

## Which base owns this file? Quick map

| Module | Base |
|--------|------|
| `apps/web/src/data/tablebase.ts` | TableBase |
| `apps/web/src/data/factbase.ts` | FactBase |
| `apps/web/scripts/build-data.mjs` | ALL (compiles YAML + MDX → JSON + PG) |
| `packages/factbase/` | FactBase core (serialization, types, YAML loading) |
| `apps/wiki-server/src/schema.ts` | ALL PG schema |
| `apps/wiki-server/src/routes/tablebase/` | TableBase mirror API |
| `apps/wiki-server/src/routes/factbase/` | FactBase mirror API |
| `apps/wiki-server/src/routes/wikibase/` | WikiBase mirror API |
| `apps/wiki-server/src/routes/things.ts` | Cross-base universal index API |

## When in doubt — the decision tree

1. **Does it have numeric fields to aggregate, many-to-many relationships, or its own directory page?** → **PG-primary TableBase** table (grants, investments, benchmarks pattern). See `.claude/rules/tablebase-sync-factory.md`.
2. **Is it a structured fact about an existing entity (revenue, CEO, headcount, valuation)?** → **FactBase** YAML (`packages/factbase/data/fb-entities/<entity>.yaml`).
3. **Is it a lightweight catalog entry used as a link target (a concept, a risk, a minor person)?** → **YAML entity** in `data/entities/*.yaml`.
4. **Is it long-form prose?** → **WikiBase** MDX in `content/docs/`.

**Strongly prefer PG-primary tables for new features with dedicated UI.** YAML entities are for link targets, not data-rich records.

## Read this too

- Full architecture doc: `content/docs/internal/data-architecture.mdx` (E1334) — authoritative
- Entity-sync plumbing: `.claude/rules/tablebase-sync-factory.md`
- Source-check/verdicts: `.claude/rules/source-check-system.md`
