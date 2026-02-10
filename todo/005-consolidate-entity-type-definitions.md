# Consolidate EntityType definitions into single source of truth

**Priority:** Medium
**Effort:** ~45–60 min
**Risk:** Medium (type system refactor)

## Problem

The concept of "entity type" is defined independently in 4 places with different levels of detail. Adding a new entity type requires updating 3–4 files manually with no enforcement.

### Current locations

| File | What it defines | Used by |
|------|----------------|---------|
| `app/src/data/entity-ontology.ts` | `ENTITY_TYPES` record — 48 types with label, icon, color, headerColor | Display layer, explore page filtering |
| `app/src/data/entity-schemas.ts` | `EntityTypeName` — Zod discriminated union of ~20 per-type schemas + catch-all `GenericEntitySchema` | Runtime validation, type guards |
| `app/src/data/schema.ts` (+ `/data/schema.ts`) | `EntityType` — Zod enum of ~39 types | Build-time validation |
| `app/src/components/wiki/InfoBox.tsx` | `type EntityType = string` | InfoBox component |
| `tooling/lib/content-types.mjs` | `CONTENT_TYPES` — path patterns per type | Tooling validation |

### Specific inconsistencies

- entity-ontology.ts has 48 types (most complete)
- schema.ts has ~39 types (missing some ATM subtypes)
- entity-schemas.ts has 20 specific + catch-all (intentionally fewer)
- InfoBox.tsx just uses `string` (gives up on type safety entirely)
- Old type aliases (`researcher` → `person`, `lab` → `organization`) exist in entity-schemas.ts but not consistently elsewhere

## Proposed fix

1. **Make `entity-ontology.ts` the canonical list** — it already has the most complete set
2. **Derive the Zod enum in schema.ts** from the ontology keys:
   ```ts
   import { ENTITY_TYPES } from './entity-ontology';
   export const EntityTypeEnum = z.enum(Object.keys(ENTITY_TYPES) as [string, ...string[]]);
   ```
3. **Update entity-schemas.ts** to import the type list rather than hardcoding
4. **Replace `type EntityType = string` in InfoBox.tsx** with an import from entity-ontology
5. **Consolidate the old-type-name remapping** into one place (entity-ontology.ts already has backward compat aliases)
6. **Update tooling content-types.mjs** to reference the canonical list (or accept that tooling uses a separate JS-only definition)

## Verification

1. `pnpm build` succeeds
2. `pnpm test` passes
3. Adding a test entity type to `entity-ontology.ts` and verifying it's recognized everywhere without additional changes
4. TypeScript compilation catches uses of removed/renamed types
