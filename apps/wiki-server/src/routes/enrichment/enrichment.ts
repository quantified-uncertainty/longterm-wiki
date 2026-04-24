/**
 * QUA-632 Phase 1 — `POST /api/enrichment/propose`.
 *
 * Defensive enrichment gate.  Produces a server-validated sourcing verdict
 * from the tier rules and delegates the row write to the existing sync-handler
 * pipeline, which atomically writes (row + evidence + verdict) inside a
 * single transaction via `writeInlineVerdicts`.
 *
 *   tier     gate                                       verdict source
 *   ─────    ────────────────────────────────────────   ────────────────────
 *   T1       sourceUrl must match T1 authority          `confirmed`  (fixed)
 *   T2       caller-supplied verdict, strict gate       caller's verdict-LLM
 *   T3       T2 rules + reject homepage URLs            caller's verdict-LLM
 *
 * Atomicity scope: the (row + evidence + verdict) triple is atomic inside
 * the sync handler's tx.  The best-effort `enrichment_runs` ledger update
 * that follows is intentionally outside that tx (it must never block a
 * successful write).  If propose crashes after the inner sync succeeded
 * but before the ledger row lands, the row is safely written and the
 * ledger counter is under-counted — never over-counted.
 *
 * Strict gate = only `verdict === "confirmed"` is accepted (QUA-635
 * calibration: Haiku at 0 % false-confirm with confirmed-only rule).
 * `partial` etc. must be routed to a separate triage queue by the caller.
 */

import { Hono } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { logger } from "../../logger.js";
import { parseJsonBody, validationError, invalidJsonError } from "../shared/utils.js";
import type { InlineSourcing } from "../tablebase/sourcing-schema.js";
import { grantsRoute } from "../tablebase/grants.js";
import { personnelRoute } from "../tablebase/personnel.js";
import { fundingRoundsRoute } from "../tablebase/funding-rounds.js";
import { benchmarkResultsRoute } from "../tablebase/benchmark-results.js";
import { checkT1Authority } from "./t1-allowlist.js";
import { isHomepageUrl } from "./homepage-detector.js";

// ── Constants ────────────────────────────────────────────────────────────

/** Strict-gate accepted verdicts.  Keep in sync with QUA-635 calibration. */
const ACCEPTED_VERDICTS = new Set(["confirmed"]);

/** Minimum length of a T2/T3 verbatim quote.  Calibration showed shorter
 *  quotes correlate with paraphrase and hallucination. */
const MIN_QUOTE_CHARS = 40;

/** Maximum size of inlined source content the caller can ship for verbatim
 *  quote-verification (≈200 kB).  Caller is expected to pre-trim. */
const MAX_SOURCE_CONTENT_CHARS = 200_000;

// ── Supported record types ──────────────────────────────────────────────

/**
 * Adding a new supported record type requires: (a) importing the sync subapp,
 * (b) appending the name to `SUPPORTED_RECORD_TYPES`, (c) adding a
 * `RECORD_TYPE_ROUTES` entry with the correct `sourceUrlField`, (d) extending
 * `t1-allowlist.ts` entries that name it.
 *
 * Names MUST match the sync-route mount names in
 * `apps/wiki-server/src/routes/tablebase/mount-registry.ts` so readers,
 * dashboards, and import pipelines all use the same string.
 */
const SUPPORTED_RECORD_TYPES = [
  "grants",
  "personnel",
  "funding-rounds",
  "benchmark-results",
] as const;
type SupportedRecordType = (typeof SUPPORTED_RECORD_TYPES)[number];

interface RecordTypeRoute {
  /** The sync handler's Hono sub-app.  Hono's `fetch` can return either
   *  `Response` or `Promise<Response>`, so we type it loosely here. */
  subApp: { fetch: (req: Request) => Response | Promise<Response> };
  /** Path within the sub-app that accepts the sync POST. */
  syncPath: string;
  /**
   * Name of the row field that carries the evidence URL.  Different sync
   * schemas use different column names:
   *   - grants / funding-rounds / personnel: `source`
   *   - benchmark-results: `sourceUrl`
   * The propose endpoint overwrites this field with `req.sourceUrl` to keep
   * the gate-validated URL canonical; callers mustn't smuggle a different
   * one in the row payload.
   */
  sourceUrlField: "source" | "sourceUrl";
}

const RECORD_TYPE_ROUTES: Record<SupportedRecordType, RecordTypeRoute> = {
  grants: { subApp: grantsRoute, syncPath: "/sync", sourceUrlField: "source" },
  personnel: {
    subApp: personnelRoute,
    syncPath: "/sync",
    sourceUrlField: "source",
  },
  "funding-rounds": {
    subApp: fundingRoundsRoute,
    syncPath: "/sync",
    sourceUrlField: "source",
  },
  "benchmark-results": {
    subApp: benchmarkResultsRoute,
    syncPath: "/sync",
    sourceUrlField: "sourceUrl",
  },
};

// ── Request schema ──────────────────────────────────────────────────────

const VERDICT_VALUES = [
  "confirmed",
  "contradicted",
  "outdated",
  "partial",
  "unverifiable",
] as const;

const ProposeRequestSchema = z
  .object({
    tier: z.enum(["T1", "T2", "T3"]),
    recordType: z.enum(SUPPORTED_RECORD_TYPES),
    /** The record payload (shape per recordType — validated by the sync
     *  handler's own Zod schema).  Must include the record's `id`. */
    row: z.record(z.unknown()),
    sourceUrl: z.string().url().max(2000),
    /** Optional hash of the API response / page content — recorded in
     *  evidence for replayability. */
    sourceContentHash: z.string().max(100).optional(),

    // ─── T2 / T3 inputs (required for those tiers; ignored for T1) ───
    /** The verdict the caller's verdict-LLM produced.  Only "confirmed" is
     *  accepted by the gate; others are rejected for the caller to triage. */
    verdict: z.enum(VERDICT_VALUES).optional(),
    confidence: z.number().min(0).max(1).optional(),
    /** Verbatim quote from the source content supporting the claim.
     *  Must be a substring of `sourceContent` when that is provided. */
    quotedText: z.string().max(5000).optional(),
    reasoning: z.string().max(5000).optional(),
    /** Source content for verbatim-quote verification.  If omitted the
     *  verbatim check is skipped (trust-the-caller mode). */
    sourceContent: z.string().max(MAX_SOURCE_CONTENT_CHARS).optional(),
    /** Model used by the verdict-LLM.  Recorded as evidence.checker_model. */
    checkerModel: z.string().max(200).optional(),

    // ─── Optional metadata ────
    runId: z.string().max(64).optional(),
    /**
     * Optional USD cost the caller paid for the verdict-LLM step on this
     * proposal. Accumulates into `enrichment_runs.cost_usd` when a runId is
     * supplied. Feeds the spend watchdog (QUA-643): the watchdog polls that
     * column over a time window and kills a run if $/hour exceeds a cap.
     * Callers who don't track per-call cost (e.g. T1 importers, subscription-
     * mode where billing is flat) can omit it; the watchdog will simply see
     * zero spend.
     */
    costUsd: z.number().nonnegative().max(1000).optional(),
    /**
     * Per-field verdicts are NOT supported in Phase 1.  `writeInlineVerdicts`
     * hardcodes `field_name = NULL`, so accepting a non-null `fieldName` here
     * would gate the T1 field-restriction correctly but then write a
     * row-level verdict anyway — a silent correctness bug.  Reject explicitly
     * until Phase 2 extends `InlineSourcing` + the sync pipeline to carry
     * field_name through.
     *
     * Schema-side: accept `null` and `undefined` only.  The runtime gate
     * below double-checks this.
     */
    fieldName: z.null().optional(),
  })
  .strict();

type ProposeRequest = z.infer<typeof ProposeRequestSchema>;

// ── QUA-643: targets upsert schema ──────────────────────────────────────
//
// The acceptance-reopener reads denominators from `enrichment_targets`. This
// endpoint lets the seed CLI (crux enrichment sync-targets) upsert rows
// from the QUA-634 denominator estimates doc. Single-row POSTs are cheap
// enough that we don't need a bulk path.

const TargetsUpsertSchema = z
  .object({
    targets: z
      .array(
        z.object({
          entityId: z.string().min(1).max(200),
          recordType: z.string().min(1).max(64),
          estimatedTotal: z.number().int().nonnegative().max(1_000_000),
          targetPct: z.number().min(0).max(1).optional(),
          basis: z.string().max(500).optional(),
          confidence: z.enum(["high", "medium", "low"]).optional(),
        }),
      )
      .max(500),
  })
  .strict();

// ── Route ───────────────────────────────────────────────────────────────

const enrichmentApp = new Hono()
  .post("/propose", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = ProposeRequestSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);
    const req = parsed.data;

    const fieldName = req.fieldName ?? null;
    const route = RECORD_TYPE_ROUTES[req.recordType];

    // ── Tier gate ────────────────────────────────────────────────────
    const gate = computeSourcingForTier(req, fieldName);
    if (!gate.accepted) {
      await logRunResult({
        runId: req.runId,
        tier: req.tier,
        accepted: false,
        rejectionReason: gate.rejectionReason,
        costUsd: req.costUsd,
      });
      logger.info(
        {
          recordType: req.recordType,
          tier: req.tier,
          rejectionReason: gate.rejectionReason,
        },
        "enrichment.propose: rejected at tier gate",
      );
      return c.json(
        {
          status: "rejected" as const,
          tier: req.tier,
          rejectionReason: gate.rejectionReason,
          verdict: null,
        },
        400,
      );
    }

    // ── Delegate to the sync handler with sourcing attached ──────────
    // The record-type's sync schema names its source-URL field either
    // `source` (grants, funding-rounds, personnel) or `sourceUrl`
    // (benchmark-results).  Overriding is intentional: the gate validated
    // this exact URL, callers mustn't smuggle a different one in the row
    // payload.  The opposite field (if present) is also scrubbed so a caller
    // can't round-trip one through the unused column on a per-record-type
    // schema that strips extras silently.
    const { source: _src, sourceUrl: _srcUrl, ...rowWithoutSourceFields } =
      req.row;
    const itemWithSourcing = {
      ...rowWithoutSourceFields,
      [route.sourceUrlField]: req.sourceUrl,
      sourcing: gate.sourcing,
    };

    // Intentionally no query string on the inner request: the sync
    // handler's `requireSourcing` / `forceSkipSourcing` / `skipEntityValidation`
    // escape hatches must NOT be reachable through /propose — the whole point
    // of the gate is to enforce sourcing + entity refs uniformly.
    const innerReq = new Request(`http://wiki-server-internal${route.syncPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [itemWithSourcing] }),
    });

    const innerRes = await Promise.resolve(route.subApp.fetch(innerReq));
    const innerText = await innerRes.text();
    let innerBody: Record<string, unknown>;
    try {
      innerBody = JSON.parse(innerText);
    } catch {
      innerBody = { raw: innerText };
    }

    if (innerRes.status >= 400) {
      const reason =
        typeof innerBody.message === "string"
          ? `sync/${req.recordType}: ${innerBody.message}`
          : `sync/${req.recordType}: HTTP ${innerRes.status}`;
      await logRunResult({
        runId: req.runId,
        tier: req.tier,
        accepted: false,
        rejectionReason: reason.slice(0, 500),
        costUsd: req.costUsd,
      });
      logger.warn(
        {
          recordType: req.recordType,
          tier: req.tier,
          innerStatus: innerRes.status,
          innerBody,
        },
        "enrichment.propose: downstream sync rejected",
      );
      return c.json(
        {
          status: "rejected" as const,
          tier: req.tier,
          rejectionReason: reason.slice(0, 500),
          verdict: null,
          innerStatus: innerRes.status,
        },
        400,
      );
    }

    const recordId =
      typeof req.row.id === "string" && req.row.id.length > 0 ? req.row.id : null;

    await logRunResult({
      runId: req.runId,
      tier: req.tier,
      accepted: true,
      verdict: gate.sourcing.verdict,
      costUsd: req.costUsd,
    });

    return c.json({
      status: "accepted" as const,
      tier: req.tier,
      recordId,
      verdict: gate.sourcing.verdict,
      confidence: gate.sourcing.confidence ?? null,
      checkerModel: gate.sourcing.checkedBy ?? null,
      innerStatus: innerRes.status,
    });
  })

  // ── QUA-643: targets + coverage for the acceptance reopener ─────────────
  //
  // `enrichment_targets` is the denominator: estimated_total × target_pct =
  // target accepted rows for this (entity, record_type). The coverage
  // endpoint joins that against the actual confirmed-verdict count from the
  // tablebase so the reopener (crux enrichment acceptance-report) can
  // decide which orgs missed the burst target.
  //
  // No auth required — coverage is derived from already-public data and the
  // reopener runs from agent slots that can't easily hold an API key.
  .post("/targets", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = TargetsUpsertSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);
    const { targets } = parsed.data;
    if (targets.length === 0) return c.json({ upserted: 0 });

    try {
      const db = getDrizzleDb();
      // One parameterized INSERT per row keeps the generated SQL small and
      // lets ON CONFLICT take the natural-key path for updates.
      let upserted = 0;
      for (const t of targets) {
        await db.execute(sql`
          INSERT INTO enrichment_targets (
            entity_id, record_type, estimated_total, target_pct, basis, confidence, estimated_at
          ) VALUES (
            ${t.entityId}, ${t.recordType}, ${t.estimatedTotal},
            ${t.targetPct ?? 0.7}, ${t.basis ?? null}, ${t.confidence ?? null}, NOW()
          )
          ON CONFLICT (entity_id, record_type) DO UPDATE SET
            estimated_total = EXCLUDED.estimated_total,
            target_pct = EXCLUDED.target_pct,
            basis = COALESCE(EXCLUDED.basis, enrichment_targets.basis),
            confidence = COALESCE(EXCLUDED.confidence, enrichment_targets.confidence),
            estimated_at = NOW(),
            updated_at = NOW()
        `);
        upserted += 1;
      }
      return c.json({ upserted });
    } catch (e: unknown) {
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        "enrichment.targets: upsert failed",
      );
      return c.json({ error: "database error" }, 500);
    }
  })
  .get("/targets", async (c) => {
    const recordType = c.req.query("recordType");
    const entityId = c.req.query("entityId");
    try {
      const db = getDrizzleDb();
      // Drizzle's dynamic WHERE builder is overkill for two optional filters;
      // the COALESCE-on-NULL pattern compiles cleanly under postgres.js.
      const rows = await db.execute<{
        entity_id: string;
        record_type: string;
        estimated_total: number;
        target_pct: number;
        basis: string | null;
        confidence: string | null;
        estimated_at: string;
      }>(sql`
        SELECT entity_id, record_type, estimated_total, target_pct, basis, confidence, estimated_at
        FROM enrichment_targets
        WHERE (${recordType ?? null}::text IS NULL OR record_type = ${recordType ?? null})
          AND (${entityId ?? null}::text IS NULL OR entity_id = ${entityId ?? null})
        ORDER BY record_type, entity_id
      `);
      return c.json({
        targets: rows.map((r) => ({
          entityId: r.entity_id,
          recordType: r.record_type,
          estimatedTotal: r.estimated_total,
          targetPct: r.target_pct,
          basis: r.basis,
          confidence: r.confidence,
          estimatedAt: r.estimated_at,
        })),
      });
    } catch (e: unknown) {
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        "enrichment.targets: query failed",
      );
      return c.json({ error: "database error" }, 500);
    }
  })
  .get("/coverage", async (c) => {
    const recordType = c.req.query("recordType");
    const entityId = c.req.query("entityId");
    try {
      const db = getDrizzleDb();
      // Count confirmed verdicts per (entity, record_type) by joining each
      // supported record-type's tablebase table into source_check_verdicts.
      // Only record types we currently sourcing-verify have entries in
      // the confirmed_by_entity CTE — other record_types in enrichment_targets
      // (e.g. 'publications', 'divisions') fall through to actual_accepted=0,
      // which is the honest answer: we have no verdict signal for them yet.
      //
      // Keeping this per-record-type in SQL (vs. a generic `entity_id` column
      // on the verdict) avoids denormalizing entity FKs onto the verdict
      // table — which would duplicate what the tablebase tables already know.
      const rows = await db.execute<{
        entity_id: string;
        record_type: string;
        estimated_total: number;
        target_pct: number;
        target_accepted: number;
        actual_accepted: number;
      }>(sql`
        WITH confirmed_by_entity AS (
          SELECT 'personnel'::text AS record_type, p.organization_id AS entity_id, COUNT(*)::int AS cnt
          FROM personnel p
          JOIN source_check_verdicts v
            ON v.record_id = p.id
           AND v.record_type = 'personnel'
           AND v.verdict = 'confirmed'
          GROUP BY p.organization_id
          UNION ALL
          SELECT 'grants'::text, g.organization_id, COUNT(*)::int
          FROM grants g
          JOIN source_check_verdicts v
            ON v.record_id = g.id
           AND v.record_type = 'grants'
           AND v.verdict = 'confirmed'
          GROUP BY g.organization_id
          UNION ALL
          SELECT 'funding-rounds'::text, fr.company_id, COUNT(*)::int
          FROM funding_rounds fr
          JOIN source_check_verdicts v
            ON v.record_id = fr.id
           AND v.record_type = 'funding-rounds'
           AND v.verdict = 'confirmed'
          GROUP BY fr.company_id
          UNION ALL
          SELECT 'benchmark-results'::text, br.model_id, COUNT(*)::int
          FROM benchmark_results br
          JOIN source_check_verdicts v
            ON v.record_id = br.id
           AND v.record_type = 'benchmark-results'
           AND v.verdict = 'confirmed'
          GROUP BY br.model_id
        )
        SELECT
          et.entity_id,
          et.record_type,
          et.estimated_total,
          et.target_pct,
          CEIL(et.estimated_total::real * et.target_pct)::int AS target_accepted,
          COALESCE(c.cnt, 0) AS actual_accepted
        FROM enrichment_targets et
        LEFT JOIN confirmed_by_entity c
          ON c.entity_id = et.entity_id
         AND c.record_type = et.record_type
        WHERE (${recordType ?? null}::text IS NULL OR et.record_type = ${recordType ?? null})
          AND (${entityId ?? null}::text IS NULL OR et.entity_id = ${entityId ?? null})
        ORDER BY
          (CEIL(et.estimated_total::real * et.target_pct)::int - COALESCE(c.cnt, 0)) DESC,
          et.record_type
      `);
      return c.json({
        coverage: rows.map((r) => {
          const gap = Math.max(0, r.target_accepted - r.actual_accepted);
          const gapPct = r.target_accepted > 0 ? gap / r.target_accepted : 0;
          return {
            entityId: r.entity_id,
            recordType: r.record_type,
            estimatedTotal: r.estimated_total,
            targetPct: r.target_pct,
            targetAcceptedCount: r.target_accepted,
            actualAcceptedCount: r.actual_accepted,
            gapCount: gap,
            gapPct,
            meetsTarget: gap === 0,
          };
        }),
      });
    } catch (e: unknown) {
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        "enrichment.coverage: query failed",
      );
      return c.json({ error: "database error" }, 500);
    }
  })
  .get("/runs", async (c) => {
    // Minimal listing endpoint for the watchdog. Returns recent runs
    // ordered by started_at descending. No pagination — the watchdog only
    // needs the most recent activity window and 50 rows is plenty.
    const sinceIso = c.req.query("since"); // ISO timestamp lower bound
    try {
      const db = getDrizzleDb();
      const rows = await db.execute<{
        id: string;
        label: string | null;
        tier: string | null;
        entity_id: string | null;
        record_type: string | null;
        started_at: string;
        finished_at: string | null;
        proposes_total: number;
        proposes_accepted: number;
        proposes_rejected: number;
        cost_usd: number;
        updated_at: string;
      }>(sql`
        SELECT id, label, tier, entity_id, record_type,
               started_at, finished_at,
               proposes_total, proposes_accepted, proposes_rejected,
               cost_usd, updated_at
        FROM enrichment_runs
        WHERE (${sinceIso ?? null}::timestamptz IS NULL OR updated_at >= ${sinceIso ?? null}::timestamptz)
        ORDER BY updated_at DESC
        LIMIT 50
      `);
      return c.json({
        runs: rows.map((r) => ({
          id: r.id,
          label: r.label,
          tier: r.tier,
          entityId: r.entity_id,
          recordType: r.record_type,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          proposesTotal: r.proposes_total,
          proposesAccepted: r.proposes_accepted,
          proposesRejected: r.proposes_rejected,
          costUsd: r.cost_usd,
          updatedAt: r.updated_at,
        })),
      });
    } catch (e: unknown) {
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        "enrichment.runs: query failed",
      );
      return c.json({ error: "database error" }, 500);
    }
  });

// ── Internals ────────────────────────────────────────────────────────────

type GateResult =
  | { accepted: true; sourcing: InlineSourcing }
  | { accepted: false; rejectionReason: string };

/**
 * Tier-gate decision.  Pure function (no IO) — easy to unit-test.
 */
export function computeSourcingForTier(
  req: ProposeRequest,
  fieldName: string | null,
): GateResult {
  if (req.tier === "T1") {
    const match = checkT1Authority(req.sourceUrl, req.recordType, fieldName);
    if (!match.matched) {
      return { accepted: false, rejectionReason: match.reason };
    }
    const s = match.source;
    const evidenceSummary = req.sourceContentHash
      ? `[T1: ${s.name}] response-hash=${req.sourceContentHash}`
      : `[T1: ${s.name}]`;
    return {
      accepted: true,
      sourcing: {
        verdict: "confirmed",
        confidence: 1.0,
        evidence: evidenceSummary,
        sourceContentHash: req.sourceContentHash,
        checkedBy: `t1-${s.id}`,
        checkedAt: new Date().toISOString(),
      },
    };
  }

  // T2 or T3 — caller-supplied verdict path.
  const missing: string[] = [];
  if (!req.verdict) missing.push("verdict");
  if (!req.quotedText) missing.push("quotedText");
  if (!req.checkerModel) missing.push("checkerModel");
  if (missing.length > 0) {
    return {
      accepted: false,
      rejectionReason: `${req.tier}: required field(s) missing: ${missing.join(", ")}`,
    };
  }
  // Type-guard now that we've checked.
  const verdict = req.verdict!;
  const quotedText = req.quotedText!;
  const checkerModel = req.checkerModel!;

  if (!ACCEPTED_VERDICTS.has(verdict)) {
    return {
      accepted: false,
      rejectionReason: `${req.tier}: verdict="${verdict}" rejected — only "confirmed" is accepted by the defensive gate (route partials/contradicted to triage queue)`,
    };
  }

  if (quotedText.length < MIN_QUOTE_CHARS) {
    return {
      accepted: false,
      rejectionReason: `${req.tier}: quotedText too short (${quotedText.length} chars, min ${MIN_QUOTE_CHARS})`,
    };
  }

  if (req.sourceContent && !sourceContainsQuote(req.sourceContent, quotedText)) {
    return {
      accepted: false,
      rejectionReason: `${req.tier}: quotedText is not a verbatim substring of sourceContent`,
    };
  }

  if (req.tier === "T3" && isHomepageUrl(req.sourceUrl)) {
    return {
      accepted: false,
      rejectionReason: `T3: sourceUrl is a homepage — pick a specific sub-page`,
    };
  }

  const evidenceBlob = req.reasoning
    ? `${quotedText}\n---\n${req.reasoning}`.slice(0, 5000)
    : quotedText.slice(0, 5000);

  return {
    accepted: true,
    sourcing: {
      verdict: "confirmed",
      confidence: req.confidence ?? 0.9,
      evidence: evidenceBlob,
      sourceContentHash: req.sourceContentHash,
      checkedBy: checkerModel,
      checkedAt: new Date().toISOString(),
    },
  };
}

/**
 * Whitespace-tolerant, case-insensitive substring check.  The verdict-LLM
 * preserves case reasonably well but collapses whitespace, so a naive strict
 * substring check rejects too many real quotes.
 */
function sourceContainsQuote(source: string, quote: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(source).includes(norm(quote));
}

/**
 * Best-effort counter update on `enrichment_runs`.  Never throws — a failure
 * to log counters must not block the propose call.  Rows are auto-created on
 * first hit (INSERT … ON CONFLICT DO UPDATE).
 */
interface LogRunArgs {
  runId: string | undefined;
  tier: "T1" | "T2" | "T3";
  accepted: boolean;
  rejectionReason?: string;
  verdict?: string;
  /** USD cost the caller paid for this proposal's verdict-LLM step. Accumulates
   *  into `enrichment_runs.cost_usd` for the watchdog (QUA-643). */
  costUsd?: number;
}

async function logRunResult(args: LogRunArgs): Promise<void> {
  if (!args.runId) return;

  // Precompute tier + verdict counter values so the SQL stays flat.
  // `tier` and `started_at` on the base row are advisory — they reflect the
  // FIRST writer's value and are intentionally not bumped in the UPDATE SET.
  const a = args.accepted ? 1 : 0;
  const r = args.accepted ? 0 : 1;
  const t1 = args.accepted && args.tier === "T1" ? 1 : 0;
  const t2 = args.accepted && args.tier === "T2" ? 1 : 0;
  const t3 = args.accepted && args.tier === "T3" ? 1 : 0;
  const vCo = args.accepted && args.verdict === "confirmed" ? 1 : 0;
  const vCn = args.accepted && args.verdict === "contradicted" ? 1 : 0;
  const vOu = args.accepted && args.verdict === "outdated" ? 1 : 0;
  const vPa = args.accepted && args.verdict === "partial" ? 1 : 0;
  const vUn = args.accepted && args.verdict === "unverifiable" ? 1 : 0;
  // Accumulate caller-reported cost. Rejected proposals still cost money (the
  // verdict LLM ran), so we bill both paths.
  const cost = typeof args.costUsd === "number" && args.costUsd >= 0 ? args.costUsd : 0;

  try {
    const db = getDrizzleDb();
    await db.execute(sql`
      INSERT INTO enrichment_runs (
        id, tier, started_at,
        proposes_total, proposes_accepted, proposes_rejected,
        accepted_t1, accepted_t2, accepted_t3,
        verdict_confirmed, verdict_contradicted, verdict_outdated, verdict_partial, verdict_unverifiable,
        cost_usd
      )
      VALUES (
        ${args.runId}, ${args.tier}, NOW(),
        1, ${a}, ${r},
        ${t1}, ${t2}, ${t3},
        ${vCo}, ${vCn}, ${vOu}, ${vPa}, ${vUn},
        ${cost}
      )
      ON CONFLICT (id) DO UPDATE SET
        proposes_total = enrichment_runs.proposes_total + 1,
        proposes_accepted = enrichment_runs.proposes_accepted + EXCLUDED.proposes_accepted,
        proposes_rejected = enrichment_runs.proposes_rejected + EXCLUDED.proposes_rejected,
        accepted_t1 = enrichment_runs.accepted_t1 + EXCLUDED.accepted_t1,
        accepted_t2 = enrichment_runs.accepted_t2 + EXCLUDED.accepted_t2,
        accepted_t3 = enrichment_runs.accepted_t3 + EXCLUDED.accepted_t3,
        verdict_confirmed = enrichment_runs.verdict_confirmed + EXCLUDED.verdict_confirmed,
        verdict_contradicted = enrichment_runs.verdict_contradicted + EXCLUDED.verdict_contradicted,
        verdict_outdated = enrichment_runs.verdict_outdated + EXCLUDED.verdict_outdated,
        verdict_partial = enrichment_runs.verdict_partial + EXCLUDED.verdict_partial,
        verdict_unverifiable = enrichment_runs.verdict_unverifiable + EXCLUDED.verdict_unverifiable,
        cost_usd = enrichment_runs.cost_usd + EXCLUDED.cost_usd,
        updated_at = NOW()
    `);
  } catch (e: unknown) {
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        runId: args.runId,
      },
      "enrichment.propose: enrichment_runs counter update failed — continuing",
    );
  }
}

export const enrichmentRoute = enrichmentApp;
export type EnrichmentRoute = typeof enrichmentApp;
