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
import type { ApplyResult } from "./apply-verdicts.ts";
import type { PolicyEntity } from "./gap-analyzer.ts";
import {
  VALID_IMPORTANCE,
  VALID_POSITIONS,
  type SyncStakeholderItem,
} from "../../../apps/wiki-server/src/routes/tablebase/policy-stakeholders-schema.ts";

type Stakeholder = NonNullable<PolicyEntity["stakeholders"]>[number];
type Position = (typeof VALID_POSITIONS)[number];
type Importance = (typeof VALID_IMPORTANCE)[number];

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
const VALID_IMPORTANCE_SET = new Set<string>(VALID_IMPORTANCE);

const STAKEHOLDER_TARGET_PREFIX = "stakeholder.";

/**
 * Generate the same deterministic 10-char ID the build-data helper produces.
 *
 * Source-of-truth: `validate-policy-stakeholders-strict.ts::generateShortId`
 * and `apps/web/scripts/lib/wiki-server-data.mjs::generateShortId` — both
 * derive `id = sha256(policyEntityId:stakeholderName).base64url[:10]`. All
 * three copies must stay in lockstep so any ingestion path produces the
 * same `id` for the same `(policyEntityId, name)` pair, otherwise the
 * natural-key UPDATE-on-conflict semantics break (a re-send mints a new id
 * and inserts a duplicate). QUA-957 follow-up: extract to a shared module.
 */
function generateShortId(input: string): string {
  return createHash("sha256").update(input).digest("base64url").substring(0, 10);
}

function isPosition(p: unknown): p is Position {
  return typeof p === "string" && VALID_POSITION_SET.has(p);
}

function isImportance(p: unknown): p is Importance {
  return typeof p === "string" && VALID_IMPORTANCE_SET.has(p);
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

  // Index post-apply stakeholders by canonical slug. Mirrors the matchKey
  // logic in `applyVerdictsToPolicy::applyVerdictsToPolicy`. First-write-wins
  // matches the applier's own dedup behavior — if the post-apply entity
  // somehow contains two stakeholders that canonicalize to the same slug
  // (the applier shouldn't produce this), we surface the collision via a
  // warning so it's visible rather than silently dropping the second row.
  const stakeholdersByCanonical = new Map<string, Stakeholder>();
  for (const s of entity.stakeholders ?? []) {
    const canon = canonicalSlug(s.name);
    if (!canon) continue;
    if (stakeholdersByCanonical.has(canon)) {
      warnings.push(
        `post-apply entity contains two stakeholders that canonicalize to '${canon}' — keeping first ('${stakeholdersByCanonical.get(canon)?.name}'), dropping '${s.name}'`,
      );
      continue;
    }
    stakeholdersByCanonical.set(canon, s);
  }

  // Track stakeholders we've already emitted to handle the case where
  // multiple `stakeholder.<slug>` verdicts canonicalize to the same row
  // (e.g. "fbi" and "federal-bureau-of-investigation" → same entity).
  // First-write-wins keeps the result deterministic.
  const emittedIds = new Set<string>();

  for (const a of applied) {
    if (!a.targetField.startsWith(STAKEHOLDER_TARGET_PREFIX)) continue;
    if (a.action === "skipped") continue;

    const slug = a.targetField.slice(STAKEHOLDER_TARGET_PREFIX.length);
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

    if (!isPosition(stakeholder.position)) {
      warnings.push(
        `stakeholder.${canon}: position='${stakeholder.position}' is not in the PG enum (${VALID_POSITIONS.join(", ")}) — dropped`,
      );
      continue;
    }

    const id = generateShortId(`${policyEntityId}:${stakeholder.name}`);
    if (emittedIds.has(id)) continue;
    emittedIds.add(id);

    // `context` lives on the YAML stakeholder type only structurally — the
    // gap-analyzer's `PolicyEntity` declaration omits it but the route
    // schema accepts an optional `string[]`. Read defensively to mirror
    // the canonical build-data transform (`wiki-server-data.mjs:925`).
    const rawContext = (stakeholder as { context?: unknown }).context;
    const context = Array.isArray(rawContext) && rawContext.every((c) => typeof c === "string")
      ? (rawContext as string[])
      : null;

    const item: SyncStakeholderItem = {
      id,
      policyEntityId,
      stakeholderEntityId: stakeholder.entityId ?? null,
      stakeholderDisplayName: stakeholder.name,
      position: stakeholder.position,
      reason: stakeholder.reason ?? null,
      source: stakeholder.source ?? null,
      context,
    };
    if (stakeholder.importance != null && stakeholder.importance !== "") {
      if (isImportance(stakeholder.importance)) {
        item.importance = stakeholder.importance;
      } else {
        warnings.push(
          `stakeholder.${canon}: importance='${stakeholder.importance}' is not in the PG enum (${VALID_IMPORTANCE.join(", ")}) — field dropped, item still emitted`,
        );
      }
    }
    items.push(item);
  }

  return { items, warnings };
}
