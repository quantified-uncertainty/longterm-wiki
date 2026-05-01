/**
 * Converter: applyVerdictsToPolicy result → policy-stakeholders sync payload.
 *
 * Phase 1 (QUA-957) of QUA-943: pure function with no IO. Takes the change
 * log + post-apply entity from `applyVerdictsToPolicy` and produces the
 * `{items}` payload accepted by the typed client at
 * `crux/lib/wiki-server/policy-stakeholders.ts::syncPolicyStakeholders`.
 *
 * No production caller invokes this in Phase 1 — Phase 2 (real machine-writes)
 * will be the first caller. Wiring exists now so Phase 2 only has to flip
 * the call-site without designing the data shape under deadline pressure.
 *
 * ### Filtering
 *
 * Only stakeholders touched by the apply (action: "added" | "updated") are
 * emitted. The natural-key UNIQUE on `(policyEntityId, stakeholderDisplayName)`
 * means any subset is safe — the route resolves a re-send as an UPDATE on
 * the existing row rather than producing duplicates.
 *
 * Skipped applied entries (action: "skipped") are dropped. Stakeholder
 * entries that exist post-apply but were not touched in this run are also
 * dropped — they represent prior state, not what this run wrote.
 *
 * ### Position handling
 *
 * The PG sync schema only accepts `position: "support" | "oppose" | "neutral" | "mixed"`,
 * but the YAML `StakeholderPosition` type also includes `"reform"` (a legacy
 * value that QUA-875 phased out for new entries but did not migrate from
 * existing data). Stakeholders whose post-apply position is missing or
 * outside the PG enum are dropped from the payload with an entry in
 * `warnings` — Phase 2 can decide whether to coerce, skip, or backfill.
 *
 * ### Slug → name resolution
 *
 * `applyVerdictsToPolicy` records `targetField: "stakeholder.<slug>"` where
 * `<slug>` may be the raw LLM extractor token (e.g. "fbi") that doesn't match
 * the post-apply stakeholder name verbatim. The applier itself uses
 * `canonicalSlug` to dedupe; we mirror that here so the converter sees the
 * same equivalence the applier saw when it decided whether to add or update.
 */

import { createHash } from "node:crypto";
import { canonicalSlug } from "./canonical-names.ts";
import type { ApplyResult, VerifiedVerdict } from "./apply-verdicts.ts";
import type { PolicyEntity } from "./gap-analyzer.ts";
import type { SyncStakeholderItem } from "../../../apps/wiki-server/src/routes/tablebase/policy-stakeholders-schema.ts";
import { VALID_POSITIONS } from "../../../apps/wiki-server/src/routes/tablebase/policy-stakeholders-schema.ts";

export interface ConvertAppliedToSyncInput {
  /** Policy `stableId` — becomes `policyEntityId` on each item. */
  policyEntityId: string;
  /** Result from `applyVerdictsToPolicy` (entity + applied change-log). */
  applyResult: ApplyResult<PolicyEntity>;
}

export interface ConvertAppliedToSyncResult {
  /** Items ready to send to `syncPolicyStakeholders`. */
  items: SyncStakeholderItem[];
  /**
   * Stakeholder change-log entries that were dropped during conversion (slug
   * couldn't be matched to a post-apply stakeholder, or post-apply position
   * was missing/non-PG). Each entry names the targetField for diagnostics.
   */
  warnings: string[];
}

const VALID_POSITION_SET = new Set<string>(VALID_POSITIONS);

/**
 * Generate the same deterministic 10-char ID the build-data helper produces.
 *
 * Source-of-truth: `validate-policy-stakeholders-strict.ts::generateShortId`
 * and `apps/web/scripts/lib/wiki-server-data.mjs::generateShortId` — both
 * derive `id = sha256(policyEntityId:stakeholderName).base64url[:10]`.
 *
 * Determinism matters: if Phase 2 re-sends the same `(policyEntityId, name)`
 * pair (e.g. retry-with-feedback), the row keeps the same `id` and the
 * natural-key resolves the conflict to UPDATE rather than INSERT.
 */
function generateShortId(input: string): string {
  return createHash("sha256").update(input).digest("base64url").substring(0, 10);
}

function isStakeholderTarget(targetField: string): boolean {
  return targetField.startsWith("stakeholder.");
}

function targetSlug(targetField: string): string {
  return targetField.slice("stakeholder.".length);
}

/**
 * Convert a `applyVerdictsToPolicy` result into a `syncPolicyStakeholders`
 * payload covering only the stakeholders that this apply touched.
 *
 * Pure function — no IO, deterministic for fixed inputs.
 */
export function convertAppliedToStakeholderSync(
  input: ConvertAppliedToSyncInput,
): ConvertAppliedToSyncResult {
  const { policyEntityId, applyResult } = input;
  const { entity, applied } = applyResult;
  const warnings: string[] = [];
  const items: SyncStakeholderItem[] = [];

  // Index post-apply stakeholders by canonical slug AND by name canonical
  // form so we can resolve `stakeholder.<targetSlug>` regardless of which
  // surface form the LLM emitted. Mirrors the matchKey logic in
  // `applyVerdictsToPolicy::applyVerdictsToPolicy`.
  const stakeholdersByCanonical = new Map<string, NonNullable<PolicyEntity["stakeholders"]>[number]>();
  for (const s of entity.stakeholders ?? []) {
    const canon = canonicalSlug(s.name);
    if (canon && !stakeholdersByCanonical.has(canon)) {
      stakeholdersByCanonical.set(canon, s);
    }
  }

  // Track stakeholders we've already emitted to handle the case where
  // multiple `stakeholder.<slug>` verdicts canonicalize to the same row
  // (e.g. "fbi" and "federal-bureau-of-investigation" → same entity).
  // First-write-wins keeps the result deterministic.
  const emittedIds = new Set<string>();

  for (const a of applied) {
    if (!isStakeholderTarget(a.targetField)) continue;
    if (a.action === "skipped") continue;

    const slug = targetSlug(a.targetField);
    const canon = canonicalSlug(slug);
    const stakeholder = stakeholdersByCanonical.get(canon);

    if (!stakeholder) {
      warnings.push(
        `${a.targetField}: no matching stakeholder in post-apply entity (canonical='${canon}') — dropped`,
      );
      continue;
    }

    if (!stakeholder.position) {
      warnings.push(
        `stakeholder.${canon}: no position on post-apply entity — dropped (PG schema requires position)`,
      );
      continue;
    }

    if (!VALID_POSITION_SET.has(stakeholder.position)) {
      warnings.push(
        `stakeholder.${canon}: position='${stakeholder.position}' is not in the PG enum (${VALID_POSITIONS.join(", ")}) — dropped`,
      );
      continue;
    }

    const id = generateShortId(`${policyEntityId}:${stakeholder.name}`);
    if (emittedIds.has(id)) continue;
    emittedIds.add(id);

    // Build the item against the canonical Zod-derived shape. `position`
    // is narrowed by the VALID_POSITION_SET check above; the cast pacifies
    // TS since `stakeholder.position` is typed `string | undefined` upstream.
    const item: SyncStakeholderItem = {
      id,
      policyEntityId,
      stakeholderEntityId: stakeholder.entityId ?? null,
      stakeholderDisplayName: stakeholder.name,
      position: stakeholder.position as SyncStakeholderItem["position"],
      reason: stakeholder.reason ?? null,
      source: stakeholder.source ?? null,
    };
    if (
      stakeholder.importance &&
      (stakeholder.importance === "high" ||
        stakeholder.importance === "medium" ||
        stakeholder.importance === "low")
    ) {
      item.importance = stakeholder.importance;
    }
    items.push(item);
  }

  return { items, warnings };
}

// ---------------------------------------------------------------------------
// Re-exports for testing convenience — keeps the public surface in one place.
// ---------------------------------------------------------------------------

export type { VerifiedVerdict };
