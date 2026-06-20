// crux tb improve-entity — closed-loop iterative entity improver.
//
// Designed against the FISA-702 post-mortem (E2/E4): the existing
// proposeClaims pipeline returns ~28% verified-rate when claims are
// hand-authored against guess-curated URLs.  This loop:
//
//   1. analyzes gaps in the entity's current YAML
//   2. discovers authoritative sources via runResearch (E4 winner)
//   3. extracts gap-targeted claims from fetched content with Haiku
//   4. pre-filters claims by token presence (E2: catches 41% absent-token)
//   5. proposes the survivors via the existing claims-first pipeline
//   6. polls until settled, then applies verified+partial verdicts to YAML
//   7. records per-iteration metrics; exits when target hit / iters / budget
//
// Supported entity types:
//   - policy        (data/entities/responses.yaml)
//   - organization  (data/entities/organizations.yaml)
//
// Usage:
//   pnpm crux tb improve-entity fisa-702 --target=15
//   pnpm crux tb improve-entity anthropic --target=10 --max-iters=2 --budget=4

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

import { type CommandResult } from "../lib/cli.ts";
import { runResearch } from "../lib/search/research-agent.ts";
import { proposeClaims, getClaimStatus } from "../lib/wiki-server/claims.ts";
import { suggestResourcesApi } from "../lib/wiki-server/resources.ts";
import { searchEntities } from "../lib/wiki-server/entities.ts";
import { createLlmClient, streamingCreate, extractText, MODELS } from "../lib/llm.ts";
import { CostTracker } from "../lib/cost-tracker.ts";
import { escapeXml } from "../lib/prompt-utils.ts";

import {
  analyzePolicyGaps,
  analyzeOrganizationGaps,
  policyCoverageScore,
  organizationCoverageScore,
  type CoverageScore,
  type Gap,
  type OrganizationEntity,
  type PolicyEntity,
} from "../lib/research/gap-analyzer.ts";
import { preFilterBatch, type PreFilterClaim } from "../lib/research/pre-filter.ts";
import {
  applyVerdictsToOrganization,
  applyVerdictsToPolicy,
  canonicalizePersonKey,
  MIN_POSITION_CONFIDENCE,
  type ApplyResult,
  type PersonEntityResolver,
  type StakeholderEntityResolver,
  type StakeholderPosition,
  type VerifiedVerdict,
} from "../lib/research/apply-verdicts.ts";
import { canonicalSlug } from "../lib/research/canonical-names.ts";
import {
  buildInspectionReport,
  fetchHistoricalRuns,
  formatInspectionLine,
} from "../lib/research/inspect.ts";
import {
  withPipelineRun,
  type WithPipelineRunOptions,
} from "../lib/pipeline-runs/lifecycle.ts";
import { getCachedAuditSessionId } from "../lib/wiki-server/audit-context.ts";
import { parseAgentSessionId } from "../lib/pipeline-runs/agent-session-id.ts";
import {
  assertNoImproveEntityMutexConflict,
  ImproveEntityMutexError,
  IMPROVE_ENTITY_PIPELINE_NAME,
  type CheckMutexOptions,
} from "../lib/improve-entity/mutex.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ENTITIES_DIR = path.join(ROOT, "data/entities");
const SNAPSHOTS = path.join(ROOT, ".claude/snapshots/improve-entity");

const SUPPORTED_TYPES = new Set(["policy", "organization"]);

/**
 * Possible exit reasons reported on {@link ImproveResult.reason}. The suite
 * runner switches on this string, so it MUST be a typed union — a typo on
 * either side silently misroutes the result.
 */
export type ImproveReason = "target-hit" | "max-iters" | "no-progress" | "budget-exhausted";

/** The single source of truth for the budget-exhausted reason token. Used as
 *  `result.reason`, the suite's `=== check`, and the pipeline-runs
 *  `markStatus({ reason, errorCode })` arguments — all kebab-case so a query
 *  on either field returns the same set of runs. */
export const BUDGET_EXHAUSTED_REASON = "budget-exhausted" as const;

/** Thrown when the live CostTracker total has reached the configured budget. */
export class BudgetExhaustedError extends Error {
  readonly spentUsd: number;
  readonly budgetUsd: number;
  constructor(spentUsd: number, budgetUsd: number) {
    super(`Spent $${spentUsd.toFixed(4)} of $${budgetUsd.toFixed(2)} budget`);
    this.name = "BudgetExhaustedError";
    this.spentUsd = spentUsd;
    this.budgetUsd = budgetUsd;
  }
}

/** Throws {@link BudgetExhaustedError} when the live tracker total has reached
 *  or exceeded `budgetUsd`. */
export function checkBudgetOrThrow(tracker: CostTracker, budgetUsd: number): void {
  if (tracker.totalCost >= budgetUsd) {
    throw new BudgetExhaustedError(tracker.totalCost, budgetUsd);
  }
}

export interface EntityWithType {
  id: string;
  stableId?: string;
  type: string;
  title?: string;
  [k: string]: unknown;
}

export interface IterationMetrics {
  iter: number;
  gaps_identified: number;
  sources_found: number;
  claims_extracted: number;
  claims_filtered_out: number;
  claims_proposed: number;
  claims_verified: number;
  claims_partial: number;
  claims_contradicted: number;
  claims_unverifiable: number;
  verified_rate: number;
  applied_to_yaml: number;
  cost_research_usd: number;
  cost_extract_usd: number;
  duration_s: number;
}

export interface ImproveResult {
  entity_slug: string;
  entity_id: string;
  entity_type: string;
  iterations: IterationMetrics[];
  final_coverage: number;
  final_facts: Record<string, number>;
  total_cost_usd: number;
  total_duration_s: number;
  hit_target: boolean;
  reason: ImproveReason;
  /** When `--wait-for-settle` is set: count of submitted claims still in
   *  pending/verifying status when the main loop exited (target/iters/budget).
   *  Omitted when the flag is off. */
  pending_at_target_hit?: number;
  /** When `--wait-for-settle` is set: additional verified+partial claims
   *  finalized during the post-exit drain phase. Omitted when off. */
  verified_after_drain?: number;
}

export interface ImproveOptions {
  slug: string;
  /** Stop when (provisions + stakeholders) ≥ target. Default 12. */
  target?: number;
  /** Max LLM spend in USD across all iterations. Default 2.0. */
  budgetUsd?: number;
  /** Max iterations. Default 1 (QUA-1033 — most policies converge in 1). */
  maxIters?: number;
  /** When true, don't write YAML back. */
  dryRun?: boolean;
  /** When true, suppress the per-entity result dump. Used by the suite runner. */
  quiet?: boolean;
  /** When true, after the main loop exits (target/iters/budget) keep polling
   *  any unsettled batches until all claims reach a terminal status, applying
   *  newly-verified verdicts to YAML. Default false (preserves prior
   *  fast-exit behavior). Recommended for CI gate suite runs (QUA-871) so
   *  per-run results aren't sensitive to worker-queue timing. */
  waitForSettle?: boolean;
  /** When true, skip the QUA-1032 single-instance mutex check. Use only for
   *  explicit takeover after a crashed run. Default false. */
  force?: boolean;
  /** Test injection — passed through to {@link checkImproveEntityMutex}.
   *  Production callers leave this undefined. */
  mutexCheckOverrides?: Pick<CheckMutexOptions, "list" | "nowMs" | "freshnessMs">;
}

// ──────────────────────────────────────────────────────────────────────────────
// Wait-for-settle: per-batch tracking + drain helper (QUA-939)
// ──────────────────────────────────────────────────────────────────────────────

/** Default global wall-clock cap for the post-loop drain (30 min). The drain
 *  bounds total time spent waiting for stuck batches; matches the
 *  `MAX_POLL_ROUNDS * 30s = 30 min` per-iteration polling cap. */
const DEFAULT_DRAIN_MAX_DURATION_MS = 30 * 60 * 1000;
/** Default sleep between drain polls (30s). Matches the per-iteration polling
 *  cadence — the worker queue moves on a similar timescale. */
const DEFAULT_DRAIN_POLL_INTERVAL_MS = 30_000;

/** A claim verdict row as returned by `getClaimStatus`. Mirrors the shape we
 *  consume from `apps/wiki-server/src/routes/claims/claims.ts`. */
export interface ClaimVerdictRow {
  id: number;
  status: string;
  verdictReasoning: string | null;
  extractedValue: string | null;
  claimText: string;
}

/** Per-batch state tracked across iterations so `drainPendingBatches` can
 *  reconstruct VerifiedVerdicts after the main loop exits. Exported for tests. */
export interface SubmittedBatchInfo {
  iter: number;
  batchId: string;
  /** Submitted claims in submission order (parallel to `claimIds`). */
  submittedByOrder: PreFilterClaim[];
  /** Claim IDs returned by proposeClaims (parallel to `submittedByOrder`).
   *  An entry is undefined only if the propose response had fewer rows than
   *  expected — we keep the index aligned so the apply path can skip cleanly. */
  claimIds: Array<number | undefined>;
  /** True once a poll returned `allSettled`. */
  settled: boolean;
  /** Set of claim IDs (subset of `claimIds`) whose verdicts have already been
   *  applied to the entity. Pre-filled by the per-iteration apply step;
   *  the drain only applies claim IDs not in this set. */
  appliedClaimIds: Set<number>;
  /** Latest verdict rows seen (used to determine pending-vs-terminal status
   *  and to construct VerifiedVerdicts on drain). */
  lastVerdicts: ClaimVerdictRow[];
}

/** Tally of verdict statuses produced by {@link buildVerifiedVerdictsFromBatch}. */
export interface VerdictCounts {
  verified: number;
  partial: number;
  contradicted: number;
  unverifiable: number;
}

/**
 * Build {@link VerifiedVerdict}s for a single batch by joining its
 * `submittedByOrder` (carries targetField/displayHint/position) with
 * `lastVerdicts` (carries verdict status + extracted value) via the parallel
 * `claimIds` array.
 *
 * When `onlyNew` is true, claim IDs already in `batch.appliedClaimIds` are
 * skipped — used by the drain phase to compute "verifieds caught after the
 * main loop exited" without re-applying earlier verdicts.
 *
 * Exported for testing.
 */
export function buildVerifiedVerdictsFromBatch(
  batch: SubmittedBatchInfo,
  onlyNew: boolean,
): { verdicts: VerifiedVerdict[]; counts: VerdictCounts } {
  const verdictsByClaimId = new Map(batch.lastVerdicts.map((v) => [v.id, v]));
  const out: VerifiedVerdict[] = [];
  const counts: VerdictCounts = { verified: 0, partial: 0, contradicted: 0, unverifiable: 0 };
  for (let i = 0; i < batch.submittedByOrder.length; i++) {
    const insertedId = batch.claimIds[i];
    if (insertedId == null) continue;
    if (onlyNew && batch.appliedClaimIds.has(insertedId)) continue;
    const v = verdictsByClaimId.get(insertedId);
    if (!v) continue;
    const status = v.status;
    if (status === "verified") counts.verified++;
    else if (status === "partial") counts.partial++;
    else if (status === "contradicted") counts.contradicted++;
    else if (status === "unverifiable") counts.unverifiable++;
    if (status === "verified" || status === "partial") {
      const submitted = batch.submittedByOrder[i] as PreFilterClaim & {
        position?: StakeholderPosition | null;
        positionConfidence?: number | null;
      };
      out.push({
        targetField: String(submitted.targetField ?? ""),
        claimText: v.claimText,
        extractedValue: v.extractedValue,
        proposedValue: submitted.proposedValue as string | null | undefined,
        sourceUrl: String(submitted.sourceUrl),
        status,
        displayHint: (submitted.displayHint as string | null) ?? undefined,
        position: submitted.position ?? null,
        positionConfidence: submitted.positionConfidence ?? null,
      });
    }
  }
  return { verdicts: out, counts };
}

/** Mark every claim ID in `batch` whose latest verdict is verified/partial as
 *  `appliedClaimIds`. Idempotent — safe to call after each apply. */
function markAppliedFromLastVerdicts(batch: SubmittedBatchInfo): void {
  for (let i = 0; i < batch.submittedByOrder.length; i++) {
    const id = batch.claimIds[i];
    if (id == null) continue;
    const v = batch.lastVerdicts.find((x) => x.id === id);
    if (!v) continue;
    if (v.status === "verified" || v.status === "partial") batch.appliedClaimIds.add(id);
  }
}

/** Count claim verdicts in pending/verifying status across all tracked batches. */
function countPending(batches: SubmittedBatchInfo[]): number {
  let n = 0;
  for (const b of batches) {
    for (const v of b.lastVerdicts) {
      if (v.status === "pending" || v.status === "verifying") n++;
    }
  }
  return n;
}

export interface DrainOptions {
  /** Max wall-clock time to spend draining (ms). Default 30 min. */
  maxDurationMs?: number;
  /** Sleep between polls (ms). Default 30s — matches per-iteration cadence. */
  pollIntervalMs?: number;
  /** Injected for tests. Defaults to the real `getClaimStatus`. Returns the
   *  unwrapped status payload, or null on transport/API failure. */
  pollFn?: (batchId: string) => Promise<{ allSettled: boolean; claims: ClaimVerdictRow[] } | null>;
  /** Injected for tests. Defaults to {@link applyVerdictsToEntity}. */
  applyFn?: (entity: EntityWithType, verdicts: VerifiedVerdict[]) => Promise<ApplyResult<EntityWithType>>;
}

/**
 * Post-exit drain: poll every unsettled batch until allSettled or a global
 * time cap is hit, applying any verdicts whose claim IDs were not yet in
 * `appliedClaimIds`. Mutates `batches` in place (updates `settled`,
 * `lastVerdicts`, `appliedClaimIds`) so the caller can inspect post-drain
 * state if needed.
 *
 * Called from {@link improveSingleEntity} only when `--wait-for-settle` is set.
 * Exported for testing.
 */
export async function drainPendingBatches(
  entity: EntityWithType,
  batches: SubmittedBatchInfo[],
  opts: DrainOptions = {},
): Promise<{
  entity: EntityWithType;
  pendingAtStart: number;
  verifiedAfterDrain: number;
  partialAfterDrain: number;
  appliedAfterDrain: number;
  timedOut: boolean;
}> {
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_DRAIN_MAX_DURATION_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_DRAIN_POLL_INTERVAL_MS;
  const pollFn =
    opts.pollFn ??
    (async (batchId: string) => {
      const r = await getClaimStatus(batchId);
      if (!r.ok) return null;
      // The route returns `{ batchId, totalClaims, byStatus, claims, allSettled, estimatedRemaining }`.
      // It returns the FULL claim set (LIMIT 1000) for the batch on every
      // call — see `apps/wiki-server/src/routes/claims/claims.ts::/status/:batchId`.
      // If that ever becomes paginated, the merge-vs-replace assumption below
      // (and in the per-iteration polling) will need revisiting.
      const d = r.data as unknown as { allSettled?: unknown; claims?: unknown };
      if (typeof d.allSettled !== "boolean" || !Array.isArray(d.claims)) return null;
      return { allSettled: d.allSettled, claims: d.claims as ClaimVerdictRow[] };
    });
  const applyFn = opts.applyFn ?? applyVerdictsToEntity;

  const pendingAtStart = countPending(batches);

  let cur = entity;
  let verifiedAfterDrain = 0;
  let partialAfterDrain = 0;
  let appliedAfterDrain = 0;
  let timedOut = false;
  const t0 = Date.now();
  let pollFailureCount = 0;

  // Outer loop: keep polling until no batch is unsettled or we time out.
  // The first pass also captures any batches that finished between the
  // per-iteration poll and now (they'll have `settled=false` but the next
  // poll returns allSettled=true).
  while (true) {
    const unsettled = batches.filter((b) => !b.settled);
    if (unsettled.length === 0) break;
    const elapsed = Date.now() - t0;
    if (elapsed >= maxDurationMs) {
      timedOut = true;
      console.warn(
        `[drain] max duration ${(maxDurationMs / 1000).toFixed(0)}s reached; ` +
          `${unsettled.length} batch(es) still unsettled`,
      );
      break;
    }

    // Cap the sleep to the remaining budget so a 30s default sleep can't
    // overshoot a near-deadline check by up to 30s.
    const sleepMs = Math.min(pollIntervalMs, maxDurationMs - elapsed);
    await new Promise((r) => setTimeout(r, sleepMs));

    // Re-check the deadline after the sleep so a clamped-to-zero sleep doesn't
    // proceed to poll one more time past the cap.
    if (Date.now() - t0 >= maxDurationMs) {
      timedOut = true;
      console.warn(
        `[drain] max duration ${(maxDurationMs / 1000).toFixed(0)}s reached after sleep; ` +
          `${unsettled.length} batch(es) still unsettled`,
      );
      break;
    }

    for (const b of unsettled) {
      if (Date.now() - t0 >= maxDurationMs) {
        timedOut = true;
        break;
      }
      const sr = await pollFn(b.batchId);
      if (!sr) {
        pollFailureCount++;
        // Log every transient failure at warn so debugging a stuck drain has
        // a paper trail. The outer while-loop bound prevents indefinite spin.
        console.warn(`[drain] pollFn returned null for batch ${b.batchId} (failure #${pollFailureCount})`);
        continue;
      }
      b.lastVerdicts = sr.claims;
      b.settled = sr.allSettled;

      const built = buildVerifiedVerdictsFromBatch(b, /*onlyNew*/ true);
      if (built.verdicts.length > 0) {
        const result = await applyFn(cur, built.verdicts);
        cur = result.entity;
        verifiedAfterDrain += built.counts.verified;
        partialAfterDrain += built.counts.partial;
        appliedAfterDrain += result.applied.filter(
          (a) => a.action === "added" || a.action === "updated",
        ).length;
        // Mark every verified/partial claim ID as applied so a subsequent
        // poll on the same batch (e.g. when the worker is still finalizing
        // others) doesn't re-build the same verdicts.
        markAppliedFromLastVerdicts(b);
      }
    }
  }

  return { entity: cur, pendingAtStart, verifiedAfterDrain, partialAfterDrain, appliedAfterDrain, timedOut };
}

/** Zod runtime guard for {@link StakeholderPosition}. The literal list MUST
 *  match the type alias exported from `apply-verdicts.ts`; the
 *  `satisfies readonly StakeholderPosition[]` assertion makes a typo a
 *  compile error. */
const STAKEHOLDER_POSITIONS = ["support", "oppose", "reform", "neutral"] as const satisfies readonly StakeholderPosition[];
const StakeholderPositionSchema = z.enum(STAKEHOLDER_POSITIONS);

const ExtractedSchema = z.array(
  z.object({
    targetField: z.string().min(1),
    claimText: z.string().min(1),
    proposedValue: z.string().nullable().optional(),
    displayHint: z.string().nullable().optional(),
    position: StakeholderPositionSchema.nullable().optional(),
    positionConfidence: z.number().min(0).max(1).nullable().optional(),
  }),
);

export interface ExtractedClaim {
  targetField: string;
  claimText: string;
  proposedValue: string | null;
  displayHint: string | null;
  position: StakeholderPosition | null;
  positionConfidence: number | null;
}

/** Stem patterns (with word boundaries) to look for in source content for
 *  each classified position. Used by the pre-filter to drop stakeholder
 *  claims whose claimed position has no textual support in the source
 *  (e.g. "ACLU opposes" with no "oppos*" word in the source).
 *
 *  Word boundaries (`\b`) prevent false positives like "neutralize"
 *  matching "neutral" or "supportive technologies" matching "support".
 *  These are regex source strings — the pre-filter compiles them with
 *  the `i` flag for case-insensitive matching. */
const POSITION_STEM_PATTERNS: Record<StakeholderPosition, string[]> = {
  support: ["\\bsupport"],   // support, supports, supported, supporter, supporting
  oppose: ["\\boppos"],       // oppose, opposes, opposed, opposition, opposing
  reform: ["\\breform"],      // reform, reforms, reformer, reforming
  neutral: ["\\bneutral\\b"], // neutral, neutrality (NOT neutralize/neutralized)
};

// ──────────────────────────────────────────────────────────────────────────────
// YAML I/O — locate the entity's source file by scanning data/entities/
// ──────────────────────────────────────────────────────────────────────────────

interface FoundEntity {
  entity: EntityWithType;
  filePath: string;
  index: number;
}

/** Find an entity by slug across all data/entities/*.yaml files. */
function findEntity(slug: string): FoundEntity | null {
  const files = fs
    .readdirSync(ENTITIES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => path.join(ENTITIES_DIR, f));
  for (const filePath of files) {
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const idx = parsed.findIndex((e) => (e as EntityWithType).id === slug);
    if (idx !== -1) {
      return { entity: parsed[idx] as EntityWithType, filePath, index: idx };
    }
  }
  return null;
}

/**
 * Surgical splice: replace ONLY the bytes for this entity's block, leaving
 * the rest of the file byte-identical. Avoids the diff-bomb that
 * yaml.dump(allEntities) creates by reformatting every other entity.
 */
function saveEntity(filePath: string, slug: string, entity: EntityWithType): void {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const startMarker = `- id: ${slug}`;
  const startIdx = lines.findIndex((l) => l.startsWith(startMarker));
  if (startIdx === -1) throw new Error(`Entity ${slug} not found in ${filePath}`);
  // The block ends at the next "- id:" or EOF.
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("- id:")) {
      endIdx = i;
      break;
    }
  }
  const blockYaml = yaml
    .dump([entity], { indent: 2, lineWidth: 120, noRefs: true, sortKeys: false })
    .trimEnd();
  const before = lines.slice(0, startIdx).join("\n");
  const after = lines.slice(endIdx).join("\n");
  const out = (before ? before + "\n" : "") + blockYaml + "\n" + after;
  fs.writeFileSync(filePath, out, "utf8");
}

// ──────────────────────────────────────────────────────────────────────────────
// Type-aware dispatch
// ──────────────────────────────────────────────────────────────────────────────

function gapsFor(entity: EntityWithType): Gap[] {
  if (entity.type === "policy") return analyzePolicyGaps(entity as unknown as PolicyEntity);
  if (entity.type === "organization")
    return analyzeOrganizationGaps(entity as unknown as OrganizationEntity);
  return [];
}

function coverageFor(entity: EntityWithType): CoverageScore {
  if (entity.type === "policy") return policyCoverageScore(entity as unknown as PolicyEntity);
  if (entity.type === "organization")
    return organizationCoverageScore(entity as unknown as OrganizationEntity);
  return { score: 0, components: {}, facts_in_yaml: {} };
}

function progressMetric(entity: EntityWithType): number {
  if (entity.type === "policy") {
    const e = entity as unknown as PolicyEntity;
    return (e.provisions?.length ?? 0) + (e.stakeholders?.length ?? 0);
  }
  if (entity.type === "organization") {
    const e = entity as unknown as OrganizationEntity;
    return (
      (e.products?.length ?? 0) +
      (e.keyPeople?.length ?? 0) +
      (e.keyDates?.length ?? 0)
    );
  }
  return 0;
}

async function applyVerdictsToEntity(
  entity: EntityWithType,
  verdicts: VerifiedVerdict[],
): Promise<ApplyResult<EntityWithType>> {
  if (entity.type === "policy") {
    // Build a stakeholder resolver from verdict displayHints. Pre-fetch entity
    // search once per unique candidate (in parallel) — the resolver closure
    // itself is synchronous because the applier is pure.
    const candidateNames = new Set<string>();
    for (const v of verdicts) {
      if (!v.targetField.startsWith("stakeholder.")) continue;
      const name = v.displayHint ?? v.targetField.slice("stakeholder.".length);
      if (name) candidateNames.add(name);
    }
    const resolved = new Map<string, string>();
    await Promise.all(
      Array.from(candidateNames).map(async (name) => {
        try {
          const sr = await searchEntities(name, 5);
          if (!sr.ok) return;
          const data = sr.data as { results?: Array<{ id: string; title?: string; entityType?: string }> };
          const results = data.results ?? [];
          const targetCanon = canonicalSlug(name);
          if (!targetCanon) return;
          // Match if any search result's title or id canonicalizes to the same slug.
          const match = results.find((r) => {
            const rcanon = canonicalSlug(r.title ?? "") || canonicalSlug(r.id);
            return rcanon === targetCanon;
          });
          if (match) resolved.set(targetCanon, match.id);
        } catch (e) {
          // network/api error — skip cross-ref for this candidate
          void e;
        }
      }),
    );
    const stakeholderResolver: StakeholderEntityResolver = (canon) =>
      resolved.get(canon) ?? null;
    const r = applyVerdictsToPolicy(entity as unknown as PolicyEntity, verdicts, {
      resolveStakeholderEntity: stakeholderResolver,
    });
    return r as unknown as ApplyResult<EntityWithType>;
  }
  if (entity.type === "organization") {
    // Build a person resolver from the verdicts' display names. We pre-fetch
    // search results once per unique candidate to keep the closure synchronous.
    const candidateNames = new Set<string>();
    for (const v of verdicts) {
      if (!v.targetField.startsWith("keyPerson.")) continue;
      const name = v.displayHint ?? v.targetField.slice("keyPerson.".length);
      if (name) candidateNames.add(name);
    }
    const resolved = new Map<string, string>();
    for (const name of candidateNames) {
      try {
        const sr = await searchEntities(name, 5);
        if (!sr.ok) continue;
        const data = sr.data as { results?: Array<{ id: string; title?: string; entityType?: string }> };
        const results = data.results ?? [];
        const targetCanon = canonicalizePersonKey(name);
        const match = results.find(
          (r) => r.entityType === "person" && canonicalizePersonKey(r.title ?? r.id) === targetCanon,
        );
        if (match) resolved.set(targetCanon, match.id);
      } catch {
        // network/api error — skip cross-ref for this candidate
      }
    }
    const resolver: PersonEntityResolver = (canon) => resolved.get(canon) ?? null;
    const r = applyVerdictsToOrganization(entity as unknown as OrganizationEntity, verdicts, {
      resolvePersonEntity: resolver,
    });
    return r as unknown as ApplyResult<EntityWithType>;
  }
  return {
    entity,
    applied: [],
    warnings: [`unsupported entity type for verdict applier: ${entity.type}`],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Gap-driven claim extraction
// ──────────────────────────────────────────────────────────────────────────────

const HAIKU_PRICING = { inputPerM: 1.0, outputPerM: 5.0 };

let _llm: ReturnType<typeof createLlmClient> | null = null;
function llm() {
  if (!_llm) _llm = createLlmClient();
  return _llm;
}

interface ExtractFieldGuide {
  scalarFieldsHint: string;
  arrayTargetsHint: string;
}

function extractFieldGuide(entityType: string): ExtractFieldGuide {
  if (entityType === "organization") {
    return {
      scalarFieldsHint:
        '"scalar.<field>" where <field> is description/website/orgType/founded/headquarters/employees/funding/parentOrg/orgStatus/safetyFocus',
      arrayTargetsHint:
        '"product.<name-slug>"      e.g. "product.claude-3-5-sonnet"\n' +
        '    "keyPerson.<name-slug>"    e.g. "keyPerson.dario-amodei"\n' +
        '    "keyDate.<event-slug>"     e.g. "keyDate.founded-2021"\n' +
        '    "tag.<value>"\n' +
        '    "relatedEntry.<entity-slug>"\n' +
        '    "factbase.revenue" or "factbase.valuation"  (will be routed to FactBase, separate ticket)',
    };
  }
  // policy
  return {
    scalarFieldsHint:
      '"scalar.<field>" where <field> is description/billNumber/introduced/policyStatus/author/jurisdiction/fullTextUrl',
    arrayTargetsHint:
      '"provision.<title-slug>"    e.g. "provision.targeting-non-us-persons"\n' +
      '    "stakeholder.<name-slug>"   e.g. "stakeholder.american-civil-liberties-union"\n' +
      '    "tag.<value>"\n' +
      '    "relatedEntry.<entity-slug>"',
  };
}

function buildExtractPrompt(
  entity: EntityWithType,
  gaps: Gap[],
  sourceUrl: string,
  sourceContent: string,
): string {
  const truncated = sourceContent.slice(0, 8000);
  const gapsXml = gaps
    .map((g) =>
      `  <gap key="${escapeXml(g.key).replace(/"/g, "&quot;")}" target="${escapeXml(g.target).replace(/"/g, "&quot;")}">${escapeXml(g.description)}</gap>`,
    )
    .join("\n");
  const guide = extractFieldGuide(entity.type);
  const description = typeof entity.description === "string" ? entity.description : "";
  return `Extract structured facts from the source document below to fill gaps in the ${escapeXml(
    entity.type,
  )} entity "${escapeXml(entity.title ?? entity.id)}".

<entity id="${escapeXml(entity.id).replace(/"/g, "&quot;")}">
  <type>${escapeXml(entity.type)}</type>
  <title>${escapeXml(entity.title ?? "")}</title>
  <description>${escapeXml(description.slice(0, 500))}</description>
</entity>

<gaps_to_fill>
${gapsXml}
</gaps_to_fill>

<source url="${escapeXml(sourceUrl).replace(/"/g, "&quot;")}">
${escapeXml(truncated)}
</source>

For each fact you can extract from the source that fills one of the gaps, return a JSON object with:
- targetField: one of:
    ${guide.scalarFieldsHint}
    ${guide.arrayTargetsHint}
- claimText: a concise, paraphrased assertion that can be verified against the source. Avoid overly-specific dates or figures unless the source states them verbatim.
- proposedValue: the actual value to write into YAML (a sentence for product / provision / stakeholder / description, a short string for billNumber, etc.).
    * For keyDate.* claims: proposedValue MUST be a structured date string in ISO format — "YYYY-MM-DD" if a full date is given, "YYYY-MM" for month-precision, or "YYYY" for year-only. Do NOT put narrative prose in proposedValue for keyDate claims; the human-readable label goes in displayHint.${
      entity.type === "organization"
        ? `
    * For product.* claims: proposedValue MUST be a single coherent sentence describing what the product is (its purpose, category, or capability) — not a launch-date claim, not a revenue/valuation claim, not a press-release excerpt. Aim for 8-25 words. Do NOT begin with "...", do NOT include mid-sentence ellipses, do NOT include trailing comma fragments. Date and revenue facts about the product belong in keyDate.* and factbase.* claims respectively. Good: "Claude is a family of large language models tuned for helpfulness, harmlessness, and honesty." Bad: "...exemplified by its Claude large-language model" (leading ellipsis fragment). Bad: "Claude Code was made available in May 2025 with run-rate revenue of $2.5 billion." (mixes launch-date + revenue — neither belongs in a product description).`
        : ""
    }
- displayHint: human label for new array entries (e.g. "Claude 3.5 Sonnet", "Dario Amodei", "Founded as Anthropic PBC", "Series G Funding Round").
- position (stakeholder claims ONLY): one of "support" | "oppose" | "reform" | "neutral", or null if the source does not support a confident classification. Apply these rules strictly:
    * "support"  — the stakeholder endorses, defends, advocates for, lobbies for, or formally votes in favor of the policy. Example: a senator who introduced/co-sponsored the bill, an industry group that filed a brief in its favor.
    * "oppose"   — the stakeholder challenges, litigates against, sues over, votes against, or publicly campaigns to repeal/strike down the policy. Example: ACLU suing the NSA over surveillance, a senator voting "no", a group filing an amicus brief against the law.
    * "reform"   — the stakeholder accepts the policy's existence but pushes for meaningful changes (sunset provisions, narrower scope, added safeguards, additional oversight) — NOT outright repeal. Example: a coalition urging stronger warrant requirements without seeking to abolish the program.
    * "neutral"  — the stakeholder has an oversight or implementation role with no public position, is described as merely "on-record" or "involved", or whose role is procedural. Example: a court that adjudicates cases under the policy, an executive agency that implements it.
- positionConfidence (stakeholder claims ONLY): a number from 0 to 1 reflecting how strongly the source language supports the classification.
    * ≥0.8 — the source uses unambiguous language ("ACLU sued", "voted in favor", "endorsed").
    * ${MIN_POSITION_CONFIDENCE.toFixed(1)}–0.8 — strong implication (filed an amicus, joined a coalition).
    * <${MIN_POSITION_CONFIDENCE.toFixed(1)} — return position: null. We will leave the position empty rather than guess.

CRITICAL:
- Only extract claims explicitly supported by the source.
- Do NOT fabricate data, positions, valuations, or vote tallies. If the source doesn't clearly state a stakeholder's stance, return position: null.
- The position word's stem must appear as a whole-word match in the source content for the classification to be valid. Required stems: "support" (matches support/supports/supporting), "oppos" (matches oppose/opposes/opposed/opposition), "reform" (matches reform/reforms/reformer), "neutral" (matches only the exact word neutral or neutrality — NOT neutralize/neutralized). If the required stem is missing, return position: null instead.
- Prefer paraphrased claims over exact quotes; the verifier will reject claims whose specific tokens aren't in the source.
- Return at most 8 claims per call.

Return ONLY a JSON array. No prose, no markdown fences.`;
}

async function extractGapClaims(
  entity: EntityWithType,
  gaps: Gap[],
  sourceUrl: string,
  sourceContent: string,
  tracker: CostTracker,
): Promise<{ claims: ExtractedClaim[]; cost: number }> {
  if (sourceContent.trim().length < 200) return { claims: [], cost: 0 };
  const prompt = buildExtractPrompt(entity, gaps, sourceUrl, sourceContent);
  let raw = "";
  let inT = 0;
  let outT = 0;
  try {
    const resp = await streamingCreate(
      llm(),
      {
        model: MODELS.haiku,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      },
      { tracker, label: "improve-entity:extract-claims" },
    );
    raw = extractText(resp);
    inT = resp.usage?.input_tokens ?? 0;
    outT = resp.usage?.output_tokens ?? 0;
  } catch (err) {
    console.warn(`[extract] Haiku failed: ${err instanceof Error ? err.message : String(err)}`);
    return { claims: [], cost: 0 };
  }

  const cost = (inT / 1_000_000) * HAIKU_PRICING.inputPerM + (outT / 1_000_000) * HAIKU_PRICING.outputPerM;
  return { claims: parseExtractedClaims(raw), cost };
}

/** Parse Haiku's JSON-array response into normalized {@link ExtractedClaim}s.
 *  Exported for testing — handles leading/trailing prose, malformed JSON,
 *  Zod-mismatched payloads, and the position normalization rules:
 *  - position fields on non-stakeholder claims are stripped (Haiku occasionally
 *    leaks them onto provision claims by mistake)
 *  - position is nulled when no confidence was provided (a position without
 *    any confidence signal is not useful downstream) */
export function parseExtractedClaims(raw: string): ExtractedClaim[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const result = ExtractedSchema.safeParse(parsed);
  if (!result.success) return [];
  return result.data.map((c) => {
    // Position only applies to stakeholder claims. Discard it for any other
    // targetField — Haiku occasionally returns it on provision claims by mistake.
    const isStakeholder = c.targetField.startsWith("stakeholder.");
    const rawPosition = isStakeholder ? c.position ?? null : null;
    const rawConfidence = isStakeholder ? c.positionConfidence ?? null : null;
    // Normalize: a position without any confidence signal is not useful
    // downstream. Carry sub-threshold confidence through — the apply step
    // owns the threshold gate so changing one place changes both.
    const position = rawConfidence == null && rawPosition != null ? null : rawPosition;
    return {
      targetField: c.targetField,
      claimText: c.claimText,
      proposedValue: c.proposedValue ?? null,
      displayHint: c.displayHint ?? null,
      position,
      positionConfidence: rawConfidence,
    };
  });
}

/** Exported for testing — see {@link parseExtractedClaims}. */
export { POSITION_STEM_PATTERNS };

// ──────────────────────────────────────────────────────────────────────────────
// One iteration of the loop
// ──────────────────────────────────────────────────────────────────────────────

async function runIteration(
  entity: EntityWithType,
  iter: number,
  budgetUsd: number,
  tracker: CostTracker,
): Promise<{ entity: EntityWithType; metrics: IterationMetrics; batch: SubmittedBatchInfo | null }> {
  // Floor at 0: callers throw on overage via checkBudgetOrThrow before
  // reaching the runResearch call, so a negative remaining is defensive only.
  const budgetRemainingUsd = Math.max(0, budgetUsd - tracker.totalCost);
  const t0 = Date.now();
  const m: IterationMetrics = {
    iter,
    gaps_identified: 0,
    sources_found: 0,
    claims_extracted: 0,
    claims_filtered_out: 0,
    claims_proposed: 0,
    claims_verified: 0,
    claims_partial: 0,
    claims_contradicted: 0,
    claims_unverifiable: 0,
    verified_rate: 0,
    applied_to_yaml: 0,
    cost_research_usd: 0,
    cost_extract_usd: 0,
    duration_s: 0,
  };

  // Guard before gapsFor so an aborted iter contributes no log noise.
  checkBudgetOrThrow(tracker, budgetUsd);

  const gaps = gapsFor(entity);
  m.gaps_identified = gaps.length;
  if (gaps.length === 0) {
    console.log(`[iter ${iter}] No gaps. Done.`);
    m.duration_s = (Date.now() - t0) / 1000;
    return { entity, metrics: m, batch: null };
  }
  console.log(`[iter ${iter}] gaps: ${gaps.map((g) => g.key).join(", ")}`);

  // 1. Discovery — focus on the top 3 gaps' research topics, joined.
  const topic = gaps.slice(0, 3).map((g) => g.researchTopic).join(" — ");
  const researchBudget = Math.min(0.5, budgetRemainingUsd * 0.2);
  console.log(`[iter ${iter}] research: "${topic.slice(0, 100)}" budget=$${researchBudget.toFixed(2)}`);
  const research = await runResearch({
    topic,
    pageContext: { title: entity.title ?? entity.id, type: entity.type, entityId: entity.id },
    config: {
      useExa: true,
      usePerplexity: true,
      useScry: false,
      useGitHub: false,
      useSemanticScholar: false,
      useFederalRegister: entity.type === "policy",
      maxResultsPerSource: 6,
      maxUrlsToFetch: 12,
      extractFacts: false,
    },
    budgetCap: researchBudget,
    tracker,
  });
  m.sources_found = research.sources.length;
  m.cost_research_usd = research.metadata.totalCost ?? 0;
  console.log(`[iter ${iter}] research: ${m.sources_found} sources, $${m.cost_research_usd.toFixed(4)}`);

  // 2. Resolve resourceIds for each source.
  const sourceUrls = research.sources.map((s) => s.url);
  const resourceIdByUrl = new Map<string, string>();
  if (sourceUrls.length > 0) {
    const r = await suggestResourcesApi({ urls: sourceUrls, entityId: entity.stableId ?? entity.id });
    if (r.ok) {
      for (const item of (r.data as { results: Array<{ url: string; resourceId: string }> }).results) {
        resourceIdByUrl.set(item.url, item.resourceId);
      }
    }
  }

  // 3. Extract claims from each source.
  const allClaims: Array<ExtractedClaim & { resourceId: string; sourceUrl: string }> = [];
  const contentByKey = new Map<string, string>();
  for (const src of research.sources) {
    const content = src.content ?? "";
    if (!content || content.length < 200) continue;
    const resourceId = resourceIdByUrl.get(src.url) ?? "";
    contentByKey.set(src.url, content);
    // If runResearch overshot its own budgetCap above, stop further
    // per-source extract spending.
    checkBudgetOrThrow(tracker, budgetUsd);
    const ex = await extractGapClaims(entity, gaps, src.url, content, tracker);
    m.cost_extract_usd += ex.cost;
    for (const c of ex.claims) {
      allClaims.push({ ...c, resourceId, sourceUrl: src.url });
    }
  }
  m.claims_extracted = allClaims.length;
  console.log(`[iter ${iter}] extracted ${allClaims.length} claims, extract cost $${m.cost_extract_usd.toFixed(4)}`);

  if (allClaims.length === 0) {
    m.duration_s = (Date.now() - t0) / 1000;
    return { entity, metrics: m, batch: null };
  }

  // 4. Pre-submission token filter — key by sourceUrl (not resourceId).
  const preFilterInput: PreFilterClaim[] = allClaims.map((c) => {
    // For stakeholder claims with a classified position, require the
    // position word's stem to appear in the source as a whole-word match
    // (e.g. `\boppos` for oppose). This catches cases where Haiku
    // synthesizes a position from context that doesn't actually use the
    // position word.
    const requiredPatterns =
      c.targetField.startsWith("stakeholder.") && c.position
        ? POSITION_STEM_PATTERNS[c.position]
        : undefined;
    return {
      claimText: c.claimText,
      proposedValue: c.proposedValue,
      // Stuff sourceUrl into the resourceId slot so preFilterBatch's content
      // lookup hits our contentByKey map (which keys on URL).
      resourceId: c.sourceUrl,
      sourceUrl: c.sourceUrl,
      realResourceId: c.resourceId,
      targetField: c.targetField,
      displayHint: c.displayHint,
      position: c.position,
      positionConfidence: c.positionConfidence,
      requiredPatterns,
    };
  });
  const filterResult = preFilterBatch(preFilterInput, contentByKey);
  m.claims_filtered_out = filterResult.dropped.length;
  console.log(`[iter ${iter}] pre-filter: kept ${filterResult.kept.length}, dropped ${filterResult.dropped.length}`);

  if (filterResult.kept.length === 0) {
    m.duration_s = (Date.now() - t0) / 1000;
    return { entity, metrics: m, batch: null };
  }

  // 5. Submit claims (one batch). Cap at 50 to respect API limits.
  const toSubmit = filterResult.kept.slice(0, 50).map((c) => {
    const realRes = (c as { realResourceId?: string }).realResourceId;
    return {
      claimText: String(c.claimText).slice(0, 5000),
      targetField: String(c.targetField).slice(0, 200),
      proposedValue: c.proposedValue ? String(c.proposedValue).slice(0, 5000) : undefined,
      resourceId: realRes ? String(realRes) : undefined,
      sourceUrl: String(c.sourceUrl),
      agentEvidence: undefined,
    };
  });
  const proposeResult = await proposeClaims({
    entityId: entity.stableId ?? entity.id,
    targetTable: "entities",
    claims: toSubmit,
  });
  if (!proposeResult.ok) {
    console.warn(`[iter ${iter}] proposeClaims failed: ${proposeResult.error ?? proposeResult.message}`);
    m.duration_s = (Date.now() - t0) / 1000;
    return { entity, metrics: m, batch: null };
  }
  const data = proposeResult.data as {
    batchId: string;
    claims: Array<{ id: number; status: string }>;
  };
  m.claims_proposed = data.claims.length;
  console.log(`[iter ${iter}] submitted batch ${data.batchId} (${m.claims_proposed} claims)`);

  // 6. Poll until settled.
  let settled = false;
  let rounds = 0;
  const MAX_POLL_ROUNDS = 60;
  let lastVerdicts: ClaimVerdictRow[] = [];
  while (!settled && rounds < MAX_POLL_ROUNDS) {
    await new Promise((r) => setTimeout(r, 30000));
    const sr = await getClaimStatus(data.batchId);
    if (!sr.ok) break;
    const sd = sr.data as unknown as { allSettled: boolean; claims: ClaimVerdictRow[] };
    lastVerdicts = sd.claims;
    settled = sd.allSettled;
    rounds++;
    const counts: Record<string, number> = {};
    for (const c of sd.claims) counts[c.status] = (counts[c.status] ?? 0) + 1;
    console.log(`[iter ${iter}] poll ${rounds}: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (settled) break;
  }

  // 7. Apply verified+partial to YAML. Build a SubmittedBatchInfo so the
  //    outer loop can drain pending claims later if `--wait-for-settle` is set.
  const batch: SubmittedBatchInfo = {
    iter,
    batchId: data.batchId,
    submittedByOrder: filterResult.kept,
    claimIds: data.claims.map((c) => c?.id),
    settled,
    appliedClaimIds: new Set<number>(),
    lastVerdicts,
  };
  const built = buildVerifiedVerdictsFromBatch(batch, /*onlyNew*/ false);
  m.claims_verified = built.counts.verified;
  m.claims_partial = built.counts.partial;
  m.claims_contradicted = built.counts.contradicted;
  m.claims_unverifiable = built.counts.unverifiable;
  m.verified_rate = m.claims_proposed > 0 ? (m.claims_verified + m.claims_partial) / m.claims_proposed : 0;

  const apply = await applyVerdictsToEntity(entity, built.verdicts);
  m.applied_to_yaml = apply.applied.filter((a) => a.action === "added" || a.action === "updated").length;
  console.log(`[iter ${iter}] applied ${m.applied_to_yaml} new facts to YAML`);
  if (apply.warnings.length > 0) {
    for (const w of apply.warnings) console.warn(`[iter ${iter}] warning: ${w}`);
  }

  // Mark every verified/partial claim ID as applied. The drain phase uses
  // this set to skip already-applied verdicts and only count NEW verifieds.
  markAppliedFromLastVerdicts(batch);

  m.duration_s = (Date.now() - t0) / 1000;
  return { entity: apply.entity, metrics: m, batch };
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the closed-loop improvement on a single entity.
 *
 * Throws if the entity is missing from `data/entities/*.yaml` or if its type
 * is not yet supported by the loop. The caller (CLI or suite runner) is
 * responsible for catching and surfacing these as user-facing errors.
 */
export async function improveSingleEntity(opts: ImproveOptions): Promise<ImproveResult> {
  const slug = opts.slug.trim();
  if (!slug) throw new Error("improveSingleEntity: slug is required");
  const target = opts.target ?? 12;
  const maxIters = opts.maxIters ?? 1;
  const budgetUsd = opts.budgetUsd ?? 2.0;
  if (!Number.isInteger(target) || target <= 0) {
    throw new Error(`improveSingleEntity: target must be a positive integer; got ${opts.target}`);
  }
  if (!Number.isInteger(maxIters) || maxIters <= 0) {
    throw new Error(`improveSingleEntity: maxIters must be a positive integer; got ${opts.maxIters}`);
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error(`improveSingleEntity: budgetUsd must be a positive number; got ${opts.budgetUsd}`);
  }
  const noWrite = !!opts.dryRun;

  const found = findEntity(slug);
  if (!found) throw new Error(`Entity not found in data/entities/*.yaml: ${slug}`);
  if (!SUPPORTED_TYPES.has(found.entity.type)) {
    throw new Error(
      `Unsupported entity type "${found.entity.type}" for ${slug}. Supported: ${[...SUPPORTED_TYPES].join(", ")}.`,
    );
  }

  // QUA-1032 single-instance mutex: refuse to start if any family-member run
  // (single or suite) is already in flight. Runs *before* `withPipelineRun`
  // so this run's own `improve-entity` row hasn't been inserted yet, avoiding
  // self-detection. Suite per-entity calls pass `force: true` because the
  // suite's outer `withPipelineRun` already owns the family lock.
  await assertNoImproveEntityMutexConflict({
    force: opts.force,
    mutexCheckOverrides: opts.mutexCheckOverrides,
  });

  // Pull the active agent_session_id (primed by crux.mjs at startup) so the
  // pipeline_runs row links back to the agent that triggered the run.
  // `getCachedAuditSessionId` returns a string; agent_sessions.id is bigint
  // — coerce to number, falling back to null on missing or non-numeric.
  const runOptions = buildImproveEntityRunOptions(
    found.entity,
    parseAgentSessionId(getCachedAuditSessionId()),
  );

  return withPipelineRun(runOptions, async (ctx) => {
    const result = await doImproveSingleEntity({
      found,
      slug,
      target,
      maxIters,
      budgetUsd,
      noWrite,
      opts,
    });
    // Budget-exhausted runs persist any applied facts to YAML (saveEntity
    // runs unconditionally) but the pipeline_runs row records the truncation
    // so dashboards can distinguish budget-aborts from successful runs.
    if (result.reason === BUDGET_EXHAUSTED_REASON) {
      ctx.markStatus("aborted", {
        reason: BUDGET_EXHAUSTED_REASON,
        errorCode: BUDGET_EXHAUSTED_REASON,
      });
    }
    return result;
  });
}

/**
 * Construct `WithPipelineRunOptions` for the improve-entity pipeline. Pure
 * helper — exported so the wiring shape is unit-testable without driving
 * the full closed-loop body. Phase 1 (QUA-957) of QUA-943.
 *
 * `allowOffline: true` so dev sessions without wiki-server creds can keep
 * iterating against YAML; the helper still logs a visible warning when
 * `/start` fails. Phase 2 may tighten this once the body performs real
 * machine-writes that demand a mandatory audit trail.
 */
export function buildImproveEntityRunOptions(
  entity: EntityWithType,
  agentSessionId: number | null,
): WithPipelineRunOptions {
  return {
    pipelineName: IMPROVE_ENTITY_PIPELINE_NAME,
    entityId: entity.stableId ?? entity.id,
    shape: entity.type,
    agentSessionId,
    allowOffline: true,
  };
}

/**
 * Inner body of `improveSingleEntity` — runs inside `withPipelineRun` so the
 * entire iteration loop, drain, and write are scoped to a single
 * `pipeline_runs` lifecycle. Phase 1 establishes the run record; Phase 2
 * will additionally invoke the typed sync client from inside this body.
 */
async function doImproveSingleEntity(args: {
  found: { entity: EntityWithType; filePath: string };
  slug: string;
  target: number;
  maxIters: number;
  budgetUsd: number;
  noWrite: boolean;
  opts: ImproveOptions;
}): Promise<ImproveResult> {
  const { found, slug, target, maxIters, budgetUsd, noWrite, opts } = args;
  let entity = found.entity;
  const t0 = Date.now();
  const iterations: IterationMetrics[] = [];
  const submittedBatches: SubmittedBatchInfo[] = [];
  const tracker = new CostTracker();
  let hitTarget = false;
  let reason: ImproveReason = "max-iters";

  for (let i = 1; i <= maxIters; i++) {
    // No pre-iter short-circuit: runIteration's first action is
    // checkBudgetOrThrow, so a guard here would race the same condition.
    let out: Awaited<ReturnType<typeof runIteration>>;
    try {
      out = await runIteration(entity, i, budgetUsd, tracker);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        console.warn(
          `[iter ${i}] budget exhausted: ${err.message}. Stopping after this iteration's partial work.`,
        );
        reason = BUDGET_EXHAUSTED_REASON;
        break;
      }
      throw err;
    }
    entity = out.entity;
    iterations.push(out.metrics);
    if (out.batch) submittedBatches.push(out.batch);
    const budgetRemaining = Math.max(0, budgetUsd - tracker.totalCost);
    const cov = coverageFor(entity);
    console.log(
      `[iter ${i}] coverage=${cov.score}, facts=${JSON.stringify(cov.facts_in_yaml)}, ` +
        `spent=$${tracker.totalCost.toFixed(4)}, remaining=$${budgetRemaining.toFixed(2)}`,
    );
    if (out.metrics.applied_to_yaml === 0 && i > 1) {
      reason = "no-progress";
      break;
    }
    if (progressMetric(entity) >= target) {
      reason = "target-hit";
      hitTarget = true;
      break;
    }
  }

  // Wait-for-settle drain (QUA-939). Only runs when the flag is set; without
  // it, behavior matches today (exits as soon as target/iters/budget fires).
  let pendingAtTargetHit: number | undefined;
  let verifiedAfterDrain: number | undefined;
  if (opts.waitForSettle && submittedBatches.length > 0) {
    const pending = countPending(submittedBatches);
    pendingAtTargetHit = pending;
    if (pending > 0 || submittedBatches.some((b) => !b.settled)) {
      console.log(
        `[drain] ${pending} pending claim(s) across ${submittedBatches.length} batch(es); polling until settled`,
      );
      const drainResult = await drainPendingBatches(entity, submittedBatches);
      entity = drainResult.entity;
      verifiedAfterDrain = drainResult.verifiedAfterDrain + drainResult.partialAfterDrain;
      console.log(
        `[drain] complete: +${verifiedAfterDrain} verified, +${drainResult.appliedAfterDrain} applied to YAML` +
          (drainResult.timedOut ? " (timed out)" : ""),
      );
    } else {
      verifiedAfterDrain = 0;
      console.log(`[drain] all ${submittedBatches.length} batch(es) already settled — no-op`);
    }
  }

  if (!noWrite) saveEntity(found.filePath, slug, entity);
  const finalCov = coverageFor(entity);
  const result: ImproveResult = {
    entity_slug: slug,
    entity_id: entity.stableId ?? entity.id,
    entity_type: entity.type,
    iterations,
    final_coverage: finalCov.score,
    final_facts: finalCov.facts_in_yaml,
    // Source from the live CostTracker rather than summing per-iteration
    // metrics: an iter aborting via BudgetExhaustedError never reaches
    // `iterations.push(out.metrics)`, so the per-iter sum would undercount
    // pre-throw spend.
    total_cost_usd: tracker.totalCost,
    total_duration_s: (Date.now() - t0) / 1000,
    hit_target: hitTarget,
    reason,
    ...(pendingAtTargetHit !== undefined ? { pending_at_target_hit: pendingAtTargetHit } : {}),
    ...(verifiedAfterDrain !== undefined ? { verified_after_drain: verifiedAfterDrain } : {}),
  };

  // Persist per-entity run snapshot.
  fs.mkdirSync(path.join(SNAPSHOTS, slug), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(SNAPSHOTS, slug, `${stamp}.json`), JSON.stringify(result, null, 2) + "\n");

  if (!opts.quiet) {
    console.log("\n=== improve-entity result ===");
    console.log(JSON.stringify(result, null, 2));
  }
  return result;
}

export async function run(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const slug = (args[0] || "").trim();
  if (!slug) {
    return { output: "Usage: crux tb improve-entity <slug> [--inspect | --target=N --budget=N --max-iters=N --wait-for-settle --force]", exitCode: 1 };
  }

  // --inspect short-circuits BEFORE any LLM client creation, mutex check,
  // or pipeline_runs row insertion. True dry-run with zero Anthropic spend.
  if (options.inspect) {
    const found = findEntity(slug);
    if (!found) {
      return { output: `Entity not found in data/entities/*.yaml: ${slug}`, exitCode: 1 };
    }
    if (!SUPPORTED_TYPES.has(found.entity.type)) {
      return {
        output: `Unsupported entity type "${found.entity.type}" for ${slug}. Supported: ${[...SUPPORTED_TYPES].join(", ")}.`,
        exitCode: 1,
      };
    }
    const runs = await fetchHistoricalRuns();
    const report = buildInspectionReport(found.entity, runs);
    const out =
      `inspect: ${slug} (${found.entity.type}) — zero LLM calls\n` +
      formatInspectionLine(report);
    return { output: out, exitCode: 0 };
  }

  const target = options.target != null ? parseInt(options.target as string, 10) : 12;
  const maxIters = options.maxIters != null ? parseInt(options.maxIters as string, 10) : 1;
  const budgetUsd = options.budget != null ? parseFloat(options.budget as string) : 2.0;
  const noWrite = !!options.dryRun;
  const waitForSettle = !!options.waitForSettle;
  const force = !!options.force;

  let result: ImproveResult;
  try {
    result = await improveSingleEntity({ slug, target, maxIters, budgetUsd, dryRun: noWrite, waitForSettle, force });
  } catch (err) {
    // QUA-1032: mutex conflicts use exit code 2 to distinguish "another run
    // is in flight" from a generic failure (exit 1). The message is already
    // formatted by `formatMutexError` — surface it as-is.
    if (err instanceof ImproveEntityMutexError) {
      return { output: err.message, exitCode: 2 };
    }
    return { output: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }
  return { output: "", exitCode: result.hit_target ? 0 : 2 };
}

export function help(): CommandResult {
  return {
    output: `crux tb improve-entity <slug> [--inspect | --target=N --budget=N --max-iters=N --wait-for-settle --force]

Closed-loop iterative entity improver. Discovers sources via runResearch,
extracts gap-targeted claims with Haiku, pre-filters by token presence,
submits via the claims-first pipeline, and applies verified+partial verdicts
to the entity's source YAML file under data/entities/.

Supported entity types: policy, organization.

Options:
  --inspect            ZERO-COST PRE-FLIGHT (QUA-1034). Loads the entity, runs
                       the gap analyzer locally, and prints what WOULD be
                       improved at what estimated cost — making zero LLM calls.
                       Use this before --dry-run to confirm what the loop will
                       target. Cost is estimated from prior pipeline_runs for
                       the same entity (median), or a type-based fallback when
                       no history exists. Short-circuits before mutex / pipeline
                       row insertion. Distinct from --dry-run: --inspect = no
                       LLM, --dry-run = full LLM cost but no YAML writeback.
  --target=N           Stop when (provisions+stakeholders for policy, products+keyPeople+keyDates for org) ≥ N (default: 12)
  --budget=N           Max LLM spend in USD — HARD cap, enforced by a live
                       CostTracker before every streamingCreate call. When the
                       tracker reaches this number mid-iteration, the loop
                       throws BudgetExhaustedError, exits with reason
                       "budget-exhausted", and the pipeline_runs row is marked
                       aborted with errorCode=budget_exhausted (default: 2.0).
  --max-iters=N        Max iterations (default: 1, lowered from 3 in QUA-1033 — most policies converge in 1)
  --dry-run            Skip writing YAML changes back to data/entities/. NOTE:
                       still runs the FULL LLM pipeline at full cost — use
                       --inspect for a true zero-cost pre-flight.
  --wait-for-settle    After the main loop exits (target/iters/budget), keep
                       polling any unsettled batches until all claims reach a
                       terminal status, applying any newly-verified verdicts
                       (capped at 30 min). Recommended for CI gate / suite runs
                       so per-run results aren't sensitive to worker timing.
  --force              Skip the QUA-1032 single-instance mutex check. By
                       default, refuses to start (exit 2) if another
                       improve-entity run is already in flight. Use only for
                       explicit takeover after a crashed run.
`,
    exitCode: 0,
  };
}

export const commands = { default: run, help };
export const getHelp = () => help().output;
