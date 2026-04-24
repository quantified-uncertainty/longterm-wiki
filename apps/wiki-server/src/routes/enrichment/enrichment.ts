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
 * Phase 1 shipped only `grants`. Phase 1.5 (QUA-665) extends this to the three
 * T1 importers shipped in QUA-640 (sec-edgar → funding-rounds,
 * github-contributors → personnel, hf-leaderboard → benchmark-results).
 *
 * Adding more record types = (a) import the sync subapp, (b) append the
 * recordType to `SUPPORTED_RECORD_TYPES`, (c) add a `RECORD_TYPE_ROUTES`
 * entry, (d) extend `t1-allowlist.ts` entries that name it (or add new ones).
 *
 * Record-type names MUST match the sync-route mount names in
 * `apps/wiki-server/src/routes/tablebase/mount-registry.ts` so the value
 * readers / dashboards / import pipelines all use the same string.
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
      req.row as Record<string, unknown>;
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

  try {
    const db = getDrizzleDb();
    await db.execute(sql`
      INSERT INTO enrichment_runs (
        id, tier, started_at,
        proposes_total, proposes_accepted, proposes_rejected,
        accepted_t1, accepted_t2, accepted_t3,
        verdict_confirmed, verdict_contradicted, verdict_outdated, verdict_partial, verdict_unverifiable
      )
      VALUES (
        ${args.runId}, ${args.tier}, NOW(),
        1, ${a}, ${r},
        ${t1}, ${t2}, ${t3},
        ${vCo}, ${vCn}, ${vOu}, ${vPa}, ${vUn}
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
