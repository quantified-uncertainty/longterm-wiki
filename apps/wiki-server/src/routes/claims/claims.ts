/**
 * Claims routes — claim verification status polling.
 *
 * Part of the claims-first verification architecture (#3253).
 * The `proposed_claims` table is created by a parallel migration task;
 * this route uses raw SQL via postgres.js since the Drizzle schema may
 * not include the table yet.
 */

import { Hono } from "hono";
import { getDb } from "../../db.js";
import { logger as rootLogger } from "../../logger.js";
import { notFoundError } from "../shared/utils.js";

const logger = rootLogger.child({ component: "claims" });

// ---------------------------------------------------------------------------
// Row types for raw SQL results
// ---------------------------------------------------------------------------

/** Shape of a row from the `proposed_claims` table (snake_case columns). */
interface ProposedClaimRow {
  id: number;
  batch_id: string;
  claim_text: string;
  status: string;
  verdict: string | null;
  confidence: number | null;
  reasoning: string | null;
  extracted_value: string | null;
}

/** Aggregated count per status. */
interface StatusCountRow {
  status: string;
  count: string; // postgres COUNT returns bigint as string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECONDS_PER_CLAIM_ESTIMATE = 3;

function formatClaim(row: ProposedClaimRow) {
  return {
    id: row.id,
    claimText: row.claim_text,
    status: row.status,
    ...(row.verdict != null && { verdict: row.verdict }),
    ...(row.confidence != null && { confidence: row.confidence }),
    ...(row.reasoning != null && { reasoning: row.reasoning }),
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

    // Fetch all claims for the batch
    const claims = await sql<ProposedClaimRow[]>`
      SELECT id, batch_id, claim_text, status, verdict, confidence, reasoning, extracted_value
      FROM proposed_claims
      WHERE batch_id = ${batchId}
      ORDER BY id ASC
    `;

    if (claims.length === 0) {
      return notFoundError(c, `No claims found for batch ${batchId}`);
    }

    // Aggregate counts by status
    const statusCounts = await sql<StatusCountRow[]>`
      SELECT status, COUNT(*)::text AS count
      FROM proposed_claims
      WHERE batch_id = ${batchId}
      GROUP BY status
    `;

    const byStatus: Record<string, number> = {
      pending: 0,
      verifying: 0,
      verified: 0,
      contradicted: 0,
      unverifiable: 0,
    };

    for (const row of statusCounts) {
      byStatus[row.status] = parseInt(row.count, 10);
    }

    const unsettledCount = (byStatus.pending ?? 0) + (byStatus.verifying ?? 0);
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
