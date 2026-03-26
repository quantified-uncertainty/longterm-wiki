/**
 * Claims routes — claim verification status polling.
 *
 * Part of the claims-first verification architecture (#3253).
 * Uses raw SQL via postgres.js for simplicity (single-query read endpoint).
 */

import { Hono } from "hono";
import { getDb } from "../../db.js";
import { logger as rootLogger } from "../../logger.js";
import { notFoundError } from "../shared/utils.js";
import { VALID_CLAIM_STATUSES } from "../../api-types.js";

const logger = rootLogger.child({ component: "claims" });

// ---------------------------------------------------------------------------
// Row types for raw SQL results
// ---------------------------------------------------------------------------

interface ProposedClaimRow {
  id: number;
  batch_id: string;
  claim_text: string;
  status: string;
  verdict_confidence: number | null;
  verdict_reasoning: string | null;
  extracted_value: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough estimate of seconds per pending claim for polling UX. */
const SECONDS_PER_CLAIM_ESTIMATE = 3;

function formatClaim(row: ProposedClaimRow) {
  return {
    id: row.id,
    claimText: row.claim_text,
    status: row.status,
    ...(row.verdict_confidence != null && { confidence: row.verdict_confidence }),
    ...(row.verdict_reasoning != null && { reasoning: row.verdict_reasoning }),
    ...(row.extracted_value != null && { extractedValue: row.extracted_value }),
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const claimsApp = new Hono()

  .get("/status/:batchId", async (c) => {
    const batchId = c.req.param("batchId");
    const sql = getDb();

    logger.debug({ batchId }, "polling claim status");

    const claims = await sql<ProposedClaimRow[]>`
      SELECT id, batch_id, claim_text, status, verdict_confidence, verdict_reasoning, extracted_value
      FROM proposed_claims
      WHERE batch_id = ${batchId}
      ORDER BY id ASC
    `;

    if (claims.length === 0) {
      return notFoundError(c, `No claims found for batch ${batchId}`);
    }

    // Compute status counts from the already-fetched claims array
    const byStatus: Record<string, number> = Object.fromEntries(
      VALID_CLAIM_STATUSES.map((s) => [s, 0]),
    );
    for (const row of claims) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    }

    const unsettledCount = byStatus.pending + byStatus.verifying;
    const allSettled = unsettledCount === 0;
    const estimatedRemaining = unsettledCount * SECONDS_PER_CLAIM_ESTIMATE;

    return c.json({
      batchId,
      totalClaims: claims.length,
      byStatus,
      claims: claims.map(formatClaim),
      allSettled,
      estimatedRemaining,
    });
  });

export const claimsRoute = claimsApp;
export type ClaimsRoute = typeof claimsApp;
