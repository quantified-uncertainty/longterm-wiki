# ID System

Subsystem map for the wiki's ID schemes (`numericId`, `stableId`, slugs, legacy IDs). **Read this before allocating an ID, writing a new entity type, or adding an ID validator** — there are three distinct ID concepts and agents repeatedly conflate them.

## Why this file exists

Last 100 PRs had 21 ID-related rework incidents: regex bugs (#4065), allocation races (#4043), personnel ID regex (#3964), `sid_` prefix handling (#4008), string/number type confusion from `postgres.js` returning strings where Sets expected numbers. The failure mode is always the same: agent assumes ID system is simpler than it is, picks the wrong helper, or invents a new ID format.

---

## The three ID schemes (understand this before touching IDs)

| Scheme | Example | Format | Who uses it | Storage |
|--------|---------|--------|-------------|---------|
| **numericId** | `E42`, `E1334` | `E<int>` | Wiki entities with their own pages | `entity_ids` PG table (sequence-allocated) |
| **stableId** | `sid_1LcLlMGLbw` | `sid_` + 10 alphanumeric | FactBase entities + lightweight TableBase records (personnel, etc.) | `entities.stable_id`, FactBase YAML |
| **tableId** | `g_abc123`, numeric PK | varies | Per-table primary keys (grants, investments, etc.) | Each tablebase table |
| slug | `anthropic`, `geoffrey-hinton` | kebab-case | Human-readable, legacy, URL path | YAML filenames, `entities.id` |

**Key rule**: `numericId` is ONLY for wiki entities that have their own pages (`/wiki/E42`). Only ~200-300 entities should have one. Everything else (personnel, authors, minor refs) gets a `stableId` only.

## Tier 1: wiki entities (have a page)

- **When**: organization with a wiki page, concept with a wiki page, major person with a bio page
- **How to allocate**: `pnpm crux tb ids allocate <slug>`
- **What you get**: a `numericId` (E-number) + a `stableId` (`sid_`)
- **Result**: agent-allocated, written to `data/entities/*.yaml`, wiki page at `/wiki/E<N>`
- **Backend**: `crux/commands/ids.ts` (CLI) → `crux/lib/wiki-server/ids.ts::allocateId()` → wiki-server `/api/ids/allocate` → PG `entity_ids` sequence

## Tier 2: lightweight TableBase records (no page)

- **When**: paper author, personnel row, minor person, directory-only record
- **How to allocate**: `pnpm crux tb ensure-entities --type=person` or `crux tb create-entity`
- **What you get**: a `stableId` only, NO `numericId`, NO wiki page
- **Result**: row in `entities` PG table

## Tier 3: per-table records

- **When**: grant, investment, funding round, personnel record — PG-primary data
- **How to allocate**: the sync handler creates the PK automatically; don't manually mint
- **Format**: each table has its own PK convention

## Core ID helpers — `@longterm-wiki/id-utils` (`packages/id-utils/src/index.ts`)

| Export | Purpose |
|--------|---------|
| `SID_PREFIX = "sid_"` | The canonical prefix constant |
| `isSid(s)` | Is this a `sid_`-prefixed stableId? |
| `isAnySid(s)` | Broader: any stableId format (accepts legacy) |
| `isDisplayableName(s)` | Inverse of `isSid` — safe to show to users? |
| `stripSid(s)` | Remove `sid_` prefix |
| `generateSid()` | Create a new `sid_<random10>` stableId |

**Import path**: `import { isSid, SID_PREFIX } from "@longterm-wiki/id-utils"`.
**Do not invent your own SID check** — always use `isSid()`.

Currently imported by: `apps/wiki-server/src/routes/tablebase/{entities,record-lookup,personnel,entity-profile}.ts`, `apps/web/src/app/things/[id]/page.tsx`, `apps/web/src/components/wiki/factbase/ref-detection.ts`, `apps/web/src/lib/stable-id.ts`, `apps/wiki-server/src/routes/shared/{query-helpers,entity-ref}.ts`. If you need SID logic in a new file, import from here.

## Core ID allocation — `crux/lib/wiki-server/ids.ts` (RPC client)

| Export | Purpose |
|--------|---------|
| `allocateId(slug, description?)` | Allocate one ID (numericId + stableId) |
| `allocateBatch(items)` | Allocate many atomically |
| `allocateIds(slugs)` | Convenience wrapper |
| `getIdBySlug(slug)` | Lookup existing |
| `listIds()` | Enumerate |
| `isConfigured()` | Is the wiki-server reachable? |

**Never mint an ID manually.** Always call `allocateId()` — it handles concurrency, sequence allocation, and persists to PG + YAML.

## Validation (run before PR)

Four SID/ID validators in `crux/validate/`:

| Validator | What it catches |
|-----------|-----------------|
| `validate-rendered-sid.ts` | `sid_` leaking into built HTML/JSON (user-visible) |
| `validate-sid-display.ts` | `sid_` in display name columns (contacts, titles) |
| `validate-factbase-stableid.ts` | FactBase entity IDs match the stableId format |
| `validate-factbase-entity-ids.ts` | FactBase ↔ TableBase entity ID consistency (no duplicates, no orphans) |
| `validate-kb-entity-slugs.ts` | FactBase refs have matching entity registry entries |

`validate-gate.ts` runs all of these in blocking mode (see lines 500, 512, 648). If you touch IDs, run `pnpm crux w validate gate --fix` before PR.

## Migration scripts (when you need them)

Three historical migrations under `crux/scripts/`:
- `migrate-kb-slugs-to-stableids.ts` — slug → sid_ conversion
- `migrate-ref-slugs.ts` — bulk reference rewrite
- `migrate-resource-hex-to-stableid.ts` — hex → sid_ conversion

These are one-shot historical scripts. Do not run them unless you're migrating data; look at them for patterns when writing a new one-shot migration.

## Known rough edges (don't re-discover)

- **postgres.js returns BIGINT as string**, not number. `Set<number>` comparisons fail silently. Always normalize via `Number(id)` or `String(id)` depending on the target type. (Caught in PR #3964.)
- **Two regex styles for stableIds** in the wild: `STABLE_ID_RE` (sid_ + 10-char) and a looser `[A-Za-z0-9_-]{10}` (legacy). Prefer the sid_-prefixed form.
- **Allocation races** (PR #4043) — the server-side sequence is safe, but local YAML write-back can race if two agents allocate simultaneously. `allocateBatch()` is atomic; prefer it over multiple `allocateId()` calls.
- **Layered architecture, not duplication**: `crux/commands/ids.ts` (CLI) → `crux/lib/wiki-server/ids.ts` (RPC client) → `packages/id-utils` (pure SID format helpers). This is intentional; don't "consolidate" it.

## Adding functionality — checklist

1. **Minting a new ID?** → `allocateId()`. Don't invent.
2. **Checking if something is a SID?** → `isSid()` from `@longterm-wiki/id-utils`. Don't regex it yourself.
3. **New entity type?** → decide Tier 1 (wiki page) vs Tier 2 (lightweight) before allocating.
4. **New validator?** → grep existing `validate-*sid*.ts` and `validate-*entity-id*.ts` first.
5. **Comparing IDs from PG?** → `Number()` or `String()` to normalize. Don't trust bigint types.
