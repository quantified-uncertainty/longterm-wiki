/**
 * Claims routes — propose claims for verification + poll status.
 *
 * Part of the claims-first verification architecture (#3253).
 * Uses raw SQL via postgres.js for simplicity.
 */

import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { getDb, beginTransaction } from "../../db.js";
import { logger as rootLogger } from "../../logger.js";
import {
  notFoundError,
  validationError,
  parseJsonBody,
  dbError,
  zv,
} from "../shared/utils.js";
import {
  ProposeClaimsSchema,
  ClaimVerdictBatchSchema,
  VALID_CLAIM_STATUSES,
} from "../../api-types.js";

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

interface InsertedClaimRow {
  id: number;
  resource_id: string | null;
  source_url: string;
}

interface InsertedJobRow {
  id: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a 10-character alphanumeric ID. Same pattern as ids.ts generateStableId(). */
function generateBatchId(): string {
  const CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
  const raw = randomBytes(7).toString("base64url").slice(0, 10);
  return raw
    .split("")
    .map((ch) => {
      if (ch === "-" || ch === "_") {
        const byte = randomBytes(1)[0];
        return CHARS[byte % CHARS.length];
      }
      return ch;
    })
    .join("");
}

/** Rough estimate of seconds per pending claim for polling UX. */
export const SECONDS_PER_CLAIM_ESTIMATE = 3;

/** Job priority for claim verification (higher than default page-improve). */
export const CLAIM_VERIFICATION_JOB_PRIORITY = 10;

/** Maximum claims per verification job — the GET /by-ids endpoint rejects >200 IDs. */
export const MAX_CLAIMS_PER_JOB = 200;

// ---------------------------------------------------------------------------
// Grouping + chunking (exported for testing)
// ---------------------------------------------------------------------------

export interface ClaimGroupEntry {
  resourceKey: string;
  resourceId: string | null;
  claimIds: number[];
}

/**
 * Group inserted claims by resource_id (or by source_url when resource_id is null),
 * then chunk each group into slices of maxPerJob.
 *
 * Returns one entry per chunk — each becomes a verification job.
 */
export function groupAndChunkClaims(
  insertedClaims: Array<{ id: number; resource_id: string | null; source_url: string }>,
  maxPerJob: number = MAX_CLAIMS_PER_JOB,
): ClaimGroupEntry[] {
  // Group by resource_id, falling back to url:<source_url> for null resource_id
  const claimsByResource = new Map<string, number[]>();
  for (const row of insertedClaims) {
    const key = row.resource_id ?? `url:${row.source_url}`;
    const group = claimsByResource.get(key);
    if (group) group.push(row.id);
    else claimsByResource.set(key, [row.id]);
  }

  // Chunk each group
  const entries: ClaimGroupEntry[] = [];
  for (const [resourceKey, claimIds] of claimsByResource) {
    const resourceId = resourceKey.startsWith("url:") ? null : resourceKey;
    for (let i = 0; i < claimIds.length; i += maxPerJob) {
      entries.push({
        resourceKey,
        resourceId,
        claimIds: claimIds.slice(i, i + maxPerJob),
      });
    }
  }

  return entries;
}

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

  // ---- POST /propose (submit claims for verification) ----

  .post("/propose", zv("json", ProposeClaimsSchema), async (c) => {
    const { entityId, targetTable, agentSessionId, claims } = c.req.valid("json");
    const sql = getDb();
    const batchId = generateBatchId();

    logger.info(
      { batchId, entityId, targetTable, claimCount: claims.length },
      "proposing claims for verification",
    );

    // 1. Validate resource references exist (if provided)
    const resourceIds = [
      ...new Set(claims.map((cl) => cl.resourceId).filter(Boolean) as string[]),
    ];
    if (resourceIds.length > 0) {
      const existing = await sql<{ id: string }[]>`
        SELECT id FROM resources WHERE id = ANY(${resourceIds})
      `;
      const existingSet = new Set(existing.map((r) => r.id));
      const missing = resourceIds.filter((id) => !existingSet.has(id));
      if (missing.length > 0) {
        return validationError(
          c,
          `Resource IDs not found: ${missing.join(", ")}`,
        );
      }
    }

    // 2-5. Insert claims, create jobs, and link them — all in a transaction
    //       so partial failures don't leave orphaned claims or jobs.
    let insertedClaims: InsertedClaimRow[] = [];
    const jobEntries: Array<{ claimIds: number[]; resourceId: string | null; jobId: number }> = [];

    await beginTransaction(async (tx) => {
      // 2. Insert all claims in a single batch
      insertedClaims = await tx<InsertedClaimRow[]>`
        INSERT INTO proposed_claims (
          batch_id, claim_text, entity_id, target_table, target_field,
          proposed_value, proposed_data, resource_id, source_url,
          agent_evidence, status, submitted_by
        )
        SELECT * FROM unnest(
          ${claims.map(() => batchId)}::text[],
          ${claims.map((cl) => cl.claimText)}::text[],
          ${claims.map(() => entityId ?? null)}::text[],
          ${claims.map(() => targetTable)}::text[],
          ${claims.map((cl) => cl.targetField ?? null)}::text[],
          ${claims.map((cl) => cl.proposedValue ?? null)}::text[],
          ${claims.map((cl) => cl.proposedData ? JSON.stringify(cl.proposedData) : null)}::jsonb[],
          ${claims.map((cl) => cl.resourceId ?? null)}::text[],
          ${claims.map((cl) => cl.sourceUrl)}::text[],
          ${claims.map((cl) => cl.agentEvidence ?? null)}::text[],
          ${claims.map(() => "pending")}::text[],
          ${claims.map(() => agentSessionId ?? null)}::text[]
        )
        RETURNING id, resource_id, source_url
      `;

      if (insertedClaims.length !== claims.length) {
        logger.error(
          { expected: claims.length, got: insertedClaims.length, batchId },
          "claim insertion count mismatch",
        );
      }

      // 3-4. Group claims by resource and chunk into job-sized batches
      const chunks = groupAndChunkClaims(insertedClaims, MAX_CLAIMS_PER_JOB);

      for (const { claimIds: chunk, resourceId } of chunks) {
          const jobParams = {
            claimIds: chunk,
            resourceId,
            batchId,
            entityId: entityId ?? null,
          };

          const jobRows = await tx<InsertedJobRow[]>`
            INSERT INTO jobs (type, params, priority, max_retries)
            VALUES (
              'claim-verification',
              ${JSON.stringify(jobParams)}::jsonb,
              ${CLAIM_VERIFICATION_JOB_PRIORITY},
              3
            )
            RETURNING id
          `;

          if (jobRows.length > 0) {
            jobEntries.push({ claimIds: chunk, resourceId, jobId: jobRows[0].id });
          }
      }

      // 5. Update claims with their verification_job_id
      for (const entry of jobEntries) {
        await tx`
          UPDATE proposed_claims
          SET verification_job_id = ${entry.jobId}
          WHERE id = ANY(${entry.claimIds})
        `;
      }
    });

    // 6. Build response
    const claimIdToJobId = new Map<number, number>();
    for (const entry of jobEntries) {
      for (const claimId of entry.claimIds) {
        claimIdToJobId.set(claimId, entry.jobId);
      }
    }

    const estimatedVerificationTime = insertedClaims.length * SECONDS_PER_CLAIM_ESTIMATE;

    return c.json(
      {
        batchId,
        claims: insertedClaims.map((row) => ({
          id: row.id,
          status: "pending" as const,
          verificationJobId: claimIdToJobId.get(row.id) ?? null,
        })),
        jobCount: jobEntries.length,
        estimatedVerificationTime,
      },
      201,
    );
  })

  // ---- POST /verdicts (batch update claim verification results) ----

  .post("/verdicts", zv("json", ClaimVerdictBatchSchema), async (c) => {
    const { verdicts } = c.req.valid("json");
    const sql = getDb();

    logger.info({ count: verdicts.length }, "recording claim verdicts");

    let updated = 0;
    for (const v of verdicts) {
      const result = await sql`
        UPDATE proposed_claims
        SET
          status = ${v.status},
          verdict_confidence = ${v.confidence},
          verdict_reasoning = ${v.reasoning},
          extracted_value = ${v.extractedValue ?? null},
          checker_model = ${v.checkerModel ?? null},
          verified_at = NOW(),
          updated_at = NOW()
        WHERE id = ${v.claimId} AND status IN ('pending', 'verifying')
        RETURNING id
      `;
      if (result.length > 0) updated++;
    }

    return c.json({ updated, total: verdicts.length });
  })

  // ---- GET /by-ids (fetch claims by ID list, used by verification worker) ----

  .get("/by-ids", async (c) => {
    const idsParam = c.req.query("ids");
    if (!idsParam) {
      return validationError(c, "Missing required query parameter: ids");
    }

    const ids = idsParam.split(",").map(Number).filter((n) => !isNaN(n) && n > 0);
    if (ids.length === 0) {
      return validationError(c, "No valid IDs provided");
    }
    if (ids.length > 200) {
      return validationError(c, "Maximum 200 IDs per request");
    }

    const sql = getDb();
    interface ClaimDetailRow {
      id: number;
      claim_text: string;
      source_url: string;
      target_table: string;
      target_field: string | null;
      proposed_value: string | null;
      agent_evidence: string | null;
      resource_id: string | null;
    }

    const claims = await sql<ClaimDetailRow[]>`
      SELECT id, claim_text, source_url, target_table, target_field,
             proposed_value, agent_evidence, resource_id
      FROM proposed_claims
      WHERE id = ANY(${ids})
      ORDER BY id ASC
    `;

    return c.json({ claims });
  })

  // ---- GET /status/:batchId (poll verification progress) ----

  .get("/status/:batchId", async (c) => {
    const batchId = c.req.param("batchId");
    const sql = getDb();

    logger.debug({ batchId }, "polling claim status");

    const claims = await sql<ProposedClaimRow[]>`
      SELECT id, batch_id, claim_text, status, verdict_confidence, verdict_reasoning, extracted_value
      FROM proposed_claims
      WHERE batch_id = ${batchId}
      ORDER BY id ASC
      LIMIT 1000
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

    // Compute settled as total minus known-terminal statuses, so unexpected
    // status values are treated as unsettled (fail-safe).
    const SETTLED_STATUSES = new Set(["verified", "contradicted", "unverifiable", "expired"]);
    const settledCount = claims.filter((r) => SETTLED_STATUSES.has(r.status)).length;
    const unsettledCount = claims.length - settledCount;
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
