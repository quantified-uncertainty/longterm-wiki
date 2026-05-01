/**
 * Pure diff helper: PG `policy_stakeholders` rows ↔ YAML `stakeholders[]` arrays.
 *
 * Lives in `crux/lib/research/` so the cron command and unit tests can both
 * reach it without touching CLI / wiki-server infrastructure. No IO — callers
 * pass already-loaded YAML entities and PG row sets.
 *
 * Used by:
 *   - `crux/commands/maintenance-reconcile-stakeholders.ts` (the cron)
 *   - tests verifying steady-state reconciliation produces zero diffs
 *
 * QUA-958 (parent QUA-943).
 *
 * ### Why we canonicalize before comparing
 *
 * YAML and PG can encode the same stakeholder slightly differently:
 *   - whitespace around the display name
 *   - YAML-only `position: "reform"` (PG enum rejects it; the converter drops
 *     those entries — they should NOT show up as PG-missing diffs)
 *   - `null` vs `undefined` vs missing for `importance` / `reason` / `source`
 *
 * The diff must NOT flag these as real divergences. We coerce both sides
 * through `normalizeStakeholder()` (defined here) and compare structurally.
 */

import { canonicalSlug } from "./canonical-names.ts";
import { VALID_POSITIONS } from "../../../apps/wiki-server/src/routes/tablebase/policy-stakeholders-schema.ts";

const VALID_POSITION_SET = new Set<string>(VALID_POSITIONS);

export interface PolicyEntityForReconcile {
  id: string;
  type: string;
  stableId?: string;
  stakeholders?: Array<{
    name: string;
    entityId?: string | null;
    position?: string;
    importance?: string | null;
    reason?: string | null;
    source?: string | null;
    context?: string[] | null;
  }>;
}

export interface PgStakeholderRow {
  id: string;
  policyEntityId: string;
  stakeholderEntityId: string | null;
  stakeholderDisplayName: string;
  position: string;
  importance: string | null;
  reason: string | null;
  source: string | null;
  context: string[] | null;
}

/** Per-entity diff. Empty when YAML and PG agree (after normalization). */
export interface EntityDiff {
  policyEntityId: string;
  /** YAML had this stakeholder; PG didn't. */
  missingFromPg: string[];
  /** PG had this stakeholder; YAML didn't. */
  missingFromYaml: string[];
  /** Both had it but normalized fields differ. */
  fieldDiffs: Array<{
    name: string;
    field: string;
    yaml: unknown;
    pg: unknown;
  }>;
}

export interface ReconcileResult {
  entitiesScanned: number;
  /** Policies whose YAML has at least one PG-eligible stakeholder. */
  entitiesNonEmpty: number;
  /** Policies with any kind of diff. */
  entitiesWithDiff: number;
  /** Policies with diffs AND non-empty YAML stakeholders (red-team #4). */
  entitiesNonEmptyWithDiff: number;
  diffs: EntityDiff[];
}

interface NormalizedStakeholder {
  name: string;
  position: string;
  stakeholderEntityId: string | null;
  importance: string | null;
  reason: string | null;
  source: string | null;
  context: string[] | null;
}

/**
 * Coerce a YAML or PG stakeholder to the same shape so structural compare is
 * meaningful. Returns null when the entry can't be persisted in PG (e.g.
 * legacy `position: reform`) — those don't count as divergences.
 */
function normalizeStakeholder(s: {
  name?: string;
  stakeholderDisplayName?: string;
  entityId?: string | null;
  stakeholderEntityId?: string | null;
  position?: string;
  importance?: string | null;
  reason?: string | null;
  source?: string | null;
  context?: string[] | null;
}): NormalizedStakeholder | null {
  const name = (s.name ?? s.stakeholderDisplayName ?? "").trim();
  if (!name) return null;
  const position = s.position ?? "";
  if (!VALID_POSITION_SET.has(position)) return null;
  return {
    name,
    position,
    stakeholderEntityId: s.entityId ?? s.stakeholderEntityId ?? null,
    importance: s.importance ?? null,
    reason: (s.reason ?? null) === "" ? null : s.reason ?? null,
    source: (s.source ?? null) === "" ? null : s.source ?? null,
    context: Array.isArray(s.context) && s.context.length > 0 ? s.context : null,
  };
}

/**
 * Compute per-entity diffs. PG rows come grouped by `policyEntityId` (the
 * scanner can pre-bucket via SQL `GROUP BY` or in-memory).
 */
export function reconcilePolicyStakeholders(
  policyEntities: PolicyEntityForReconcile[],
  pgRowsByPolicy: Map<string, PgStakeholderRow[]>,
): ReconcileResult {
  const result: ReconcileResult = {
    entitiesScanned: 0,
    entitiesNonEmpty: 0,
    entitiesWithDiff: 0,
    entitiesNonEmptyWithDiff: 0,
    diffs: [],
  };

  // We index PG rows by the policy's stableId since that's what the dual-write
  // posts as `policyEntityId`. Some policies in YAML may not have a stableId
  // (rare — Phase 0c assigned one to every policy that's a write target). We
  // skip those for the diff: they can't have PG rows by definition.
  for (const policy of policyEntities) {
    if (policy.type !== "policy") continue;
    const pid = policy.stableId ?? null;
    if (!pid) continue;

    result.entitiesScanned++;

    const yamlStakeholders = (policy.stakeholders ?? [])
      .map(normalizeStakeholder)
      .filter((s): s is NormalizedStakeholder => s !== null);
    const pgRows = pgRowsByPolicy.get(pid) ?? [];
    const pgStakeholders = pgRows
      .map(normalizeStakeholder)
      .filter((s): s is NormalizedStakeholder => s !== null);

    const yamlHasNonEmpty = yamlStakeholders.length > 0;
    if (yamlHasNonEmpty) result.entitiesNonEmpty++;

    // Index by canonical slug — same equivalence the apply path uses.
    const byYaml = new Map<string, NormalizedStakeholder>();
    for (const y of yamlStakeholders) {
      const k = canonicalSlug(y.name);
      if (k) byYaml.set(k, y);
    }
    const byPg = new Map<string, NormalizedStakeholder>();
    for (const p of pgStakeholders) {
      const k = canonicalSlug(p.name);
      if (k) byPg.set(k, p);
    }

    const diff: EntityDiff = {
      policyEntityId: pid,
      missingFromPg: [],
      missingFromYaml: [],
      fieldDiffs: [],
    };

    for (const [k, y] of byYaml.entries()) {
      const p = byPg.get(k);
      if (!p) {
        diff.missingFromPg.push(y.name);
        continue;
      }
      // Compare normalized fields. Field-level diffs are recorded; missing/
      // extra are above.
      for (const field of ["position", "importance", "reason", "source", "stakeholderEntityId"] as const) {
        if (y[field] !== p[field]) {
          diff.fieldDiffs.push({ name: y.name, field, yaml: y[field], pg: p[field] });
        }
      }
      // `context` is array; compare structurally.
      if (!arraysEqual(y.context, p.context)) {
        diff.fieldDiffs.push({ name: y.name, field: "context", yaml: y.context, pg: p.context });
      }
    }
    for (const [k, p] of byPg.entries()) {
      if (!byYaml.has(k)) diff.missingFromYaml.push(p.name);
    }

    const hasDiff =
      diff.missingFromPg.length > 0 ||
      diff.missingFromYaml.length > 0 ||
      diff.fieldDiffs.length > 0;
    if (hasDiff) {
      result.entitiesWithDiff++;
      if (yamlHasNonEmpty) result.entitiesNonEmptyWithDiff++;
      result.diffs.push(diff);
    }
  }

  return result;
}

function arraysEqual(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
