/**
 * Composer dispatch table for `things.title` / `description` / `parent_title`.
 *
 * Phase 4b-B.1 of QUA-408. Replaces 22 hand-rolled string composers across
 * the sync handlers with a single registry keyed by `thingType`. This is the
 * composer-only consolidation step — it does NOT change the schema or
 * `things.search_vector`. Phase 4b-B.2 will drop the columns and replace the
 * generated column with a materialized view.
 *
 * See:
 *   - QUA-408: https://linear.app/quantifieduncertainty/issue/QUA-408
 *   - QUA-470: https://linear.app/quantifieduncertainty/issue/QUA-470
 *   - docs/audits/things-denormalization-audit.md
 *
 * Usage:
 *   1. In a sync handler's route file, call `registerComposer("<thing-type>", fn)`
 *      at module top-level. The function takes `(row, entityTitleMap)` and
 *      returns `{title, description, parentTitle}`.
 *   2. In the sync handler's transaction body, call
 *      `composeThing("<thing-type>", row, titleMap)` and pass the result into
 *      `upsertThingsInTx`.
 *
 * Why a registry instead of a switch statement?
 *   - Each handler keeps its composer co-located with its other route logic.
 *   - Removing a thing type only requires removing its `registerComposer()`
 *     call, not editing the dispatch file.
 *   - Tests can register fakes for unrelated thing types without touching
 *     production composers.
 */

import type { ThingType } from "../../schema.js";

/**
 * Output of a thing composer — the derived display fields written to the
 * `things` table.
 */
export interface ComposedThingDisplay {
  title: string;
  description: string | null;
  parentTitle: string | null;
}

/**
 * Map from entityId / stableId / slug → human-readable title. Pre-resolved by
 * the caller (typically via `resolveEntityTitles()` or the sync-factory
 * `thingsTitleIds` hook) before invoking a composer.
 */
export type EntityTitleMap = Map<string, string>;

/**
 * A composer takes a source row (typed by the caller) and a pre-resolved
 * entity title map, and returns the `{title, description, parentTitle}`
 * triple to write into the `things` row.
 */
export type ThingComposer<TRow = unknown> = (
  row: TRow,
  titleMap: EntityTitleMap,
) => ComposedThingDisplay;

// Internal registry. Keyed by thing_type string. Composers are stored as the
// type-erased `ThingComposer<unknown>`; callers re-narrow via the generic
// parameter on `composeThing<TRow>()`.
const composers = new Map<string, ThingComposer<unknown>>();

/**
 * Register a composer for a given thing_type. Throws if a composer is already
 * registered — composers must be unique per type to avoid silent override
 * during phased rollout.
 *
 * Call this at module top-level in the route file that owns the thing_type:
 *
 * ```ts
 * registerComposer<PersonnelRow>("personnel", (row, titleMap) => {...});
 * ```
 */
export function registerComposer<TRow>(
  thingType: ThingType,
  composer: ThingComposer<TRow>,
): void {
  if (composers.has(thingType)) {
    throw new Error(
      `Composer for thing_type "${thingType}" already registered. ` +
        `Composers must be unique per type — check for duplicate registerComposer() calls.`,
    );
  }
  composers.set(thingType, composer as ThingComposer<unknown>);
}

/**
 * Returns true if a composer is registered for the given thing_type.
 * Useful for phased rollout: handlers can check `hasComposer()` and fall
 * back to inlined composition if their type hasn't been migrated yet.
 */
export function hasComposer(thingType: ThingType): boolean {
  return composers.has(thingType);
}

/**
 * Compose the display fields for a given thing_type. Throws if no composer
 * is registered.
 *
 * The generic `TRow` parameter is for caller convenience — it's narrowed at
 * the call site, not validated against the registered composer's actual
 * input type. Each call site is responsible for passing a row whose shape
 * matches what the registered composer expects.
 */
export function composeThing<TRow>(
  thingType: ThingType,
  row: TRow,
  titleMap: EntityTitleMap,
): ComposedThingDisplay {
  const composer = composers.get(thingType);
  if (!composer) {
    throw new Error(
      `No composer registered for thing_type "${thingType}". ` +
        `Call registerComposer() at module top-level in the route file that owns this type.`,
    );
  }
  return (composer as ThingComposer<TRow>)(row, titleMap);
}

/**
 * Test helper: clear the composer registry. Use in `beforeEach` so tests
 * that register composers don't bleed state into other tests. Production
 * code must never call this.
 */
export function _resetComposers(): void {
  composers.clear();
}

/**
 * Test/debug helper: list the thing_types that currently have a registered
 * composer. Useful for the "every thing_type has a composer" coverage test
 * that lands at the end of the QUA-470 rollout.
 */
export function _registeredComposerTypes(): string[] {
  return [...composers.keys()].sort();
}
