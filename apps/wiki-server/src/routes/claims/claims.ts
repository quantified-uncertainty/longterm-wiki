/**
 * Claims routes — propose claims for sourcing + poll status.
 *
 * Part of the claims-first sourcing architecture (#3253).
 * Uses raw SQL via postgres.js for simplicity.
 */

import { Hono } from "hono";
import { randomBytes, randomInt } from "node:crypto";
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
  ClaimsAllQuery,
  ClaimsByEntityQuery,
} from "../../api-types.js";
import { resolveResourceIds } from "../shared/resolve-resource-id.js";

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
        return CHARS[randomInt(CHARS.length)];
      }
      return ch;
    })
    .join("");
}

/** Rough estimate of seconds per pending claim for polling UX. */
export const SECONDS_PER_CLAIM_ESTIMATE = 3;

/** Job priority for claim sourcing (higher than default page-improve). */
export const CLAIM_SOURCE_CHECK_JOB_PRIORITY = 10;

/** Maximum claims per sourcing job — the GET /by-ids endpoint rejects >200 IDs. */
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
 * Returns one entry per chunk — each becomes a sourcing job.
 */
export function groupAndChunkClaims(
  insertedClaims: Array<{ id: number; resource_id: string | null; source_url: string }>,
  maxPerJob: number = MAX_CLAIMS_PER_JOB,
): ClaimGroupEntry[] {
  if (maxPerJob <= 0) {
    throw new Error(`maxPerJob must be positive, got ${maxPerJob}`);
  }

  // Group by resource_id, falling back to \0url:<source_url> for null resource_id.
  // The \0 prefix prevents collision with legitimate resource_ids starting with "url:".
  const NO_RESOURCE_PREFIX = "\0url:";
  const claimsByResource = new Map<string, number[]>();
  for (const row of insertedClaims) {
    const key = row.resource_id ?? `${NO_RESOURCE_PREFIX}${row.source_url}`;
    const group = claimsByResource.get(key);
    if (group) group.push(row.id);
    else claimsByResource.set(key, [row.id]);
  }

  // Chunk each group
  const entries: ClaimGroupEntry[] = [];
  for (const [resourceKey, claimIds] of claimsByResource) {
    const resourceId = resourceKey.startsWith(NO_RESOURCE_PREFIX) ? null : resourceKey;
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

  // ---- POST /propose (submit claims for sourcing) ----

  .post("/propose", zv("json", ProposeClaimsSchema), async (c) => {
    const { entityId, targetTable, agentSessionId, claims } = c.req.valid("json");
    const sql = getDb();
    const batchId = generateBatchId();

    logger.info(
      { batchId, entityId, targetTable, claimCount: claims.length },
      "proposing claims for sourcing",
    );

    // Validate resource references exist (if provided) and canonicalise to
    // stable_id. Strict mode: any unresolved input is a 400; proposed_claims
    // must never persist a hex16 value (the FK points at resources.stable_id).
    const inputResourceIds = claims.map((cl) => cl.resourceId).filter(Boolean) as string[];
    const { resolve: resolveResourceId, missing } = await resolveResourceIds(
      sql,
      inputResourceIds,
    );
    if (missing.length > 0) {
      return validationError(
        c,
        `Resource IDs not found (or missing stable_id): ${missing.join(", ")}`,
      );
    }

    // 2-5. Insert claims, create jobs, and link them — all in a transaction
    //       so partial failures don't leave orphaned claims or jobs.
    let insertedClaims: InsertedClaimRow[] = [];
    const jobEntries: Array<{ claimIds: number[]; resourceId: string | null; jobId: number }> = [];

    await beginTransaction(async (tx) => {
      // 2. Insert all claims in a single batch
      // postgres.js returns bigserial id as string — coerce to number for
      // downstream job params (claim-sourcing handler expects number[]).
      const rawRows = await tx<InsertedClaimRow[]>`
        INSERT INTO proposed_claims (
          batch_id, claim_text, entity_id, target_table, target_field,
          proposed_value, proposed_data, resource_id, source_url,
          agent_evidence, status, submitted_by
        )
        SELECT * FROM unnest(
          ${claims.map(() => batchId)}::text[],
          ${claims.map((cl) => cl.claimText)}::text[],
          ${claims.map(() => entityId)}::text[],
          ${claims.map(() => targetTable)}::text[],
          ${claims.map((cl) => cl.targetField ?? null)}::text[],
          ${claims.map((cl) => cl.proposedValue ?? null)}::text[],
          ${claims.map((cl) => cl.proposedData ? JSON.stringify(cl.proposedData) : null)}::jsonb[],
          ${claims.map((cl) => (cl.resourceId ? resolveResourceId(cl.resourceId) : null))}::text[],
          ${claims.map((cl) => cl.sourceUrl)}::text[],
          ${claims.map((cl) => cl.agentEvidence ?? null)}::text[],
          ${claims.map(() => "pending")}::text[],
          ${claims.map(() => agentSessionId ?? null)}::text[]
        )
        RETURNING id, resource_id, source_url
      `;
      insertedClaims = rawRows.map((row) => ({
        ...row,
        id: Number(row.id),
      }));

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
          entityId,
        };

        const jobRows = await tx<InsertedJobRow[]>`
          INSERT INTO jobs (type, params, priority, max_retries)
          VALUES (
            'claim-sourcing',
            ${JSON.stringify(jobParams)}::jsonb,
            ${CLAIM_SOURCE_CHECK_JOB_PRIORITY},
            3
          )
          RETURNING id
        `;

        if (jobRows.length > 0) {
          jobEntries.push({ claimIds: chunk, resourceId, jobId: Number(jobRows[0].id) });
        }
      }

      // 5. Update claims with their sourcing job_id
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

    const estimatedSourcingTime = insertedClaims.length * SECONDS_PER_CLAIM_ESTIMATE;

    return c.json(
      {
        batchId,
        claims: insertedClaims.map((row) => ({
          id: row.id,
          status: "pending" as const,
          sourcingJobId: claimIdToJobId.get(row.id) ?? null,
        })),
        jobCount: jobEntries.length,
        estimatedSourcingTime,
      },
      201,
    );
  })

  // ---- POST /verdicts (batch update claim sourcing results) ----

  .post("/verdicts", zv("json", ClaimVerdictBatchSchema), async (c) => {
    const { verdicts } = c.req.valid("json");
    const sql = getDb();

    logger.info({ count: verdicts.length }, "recording claim verdicts");

    // Batch UPDATE via unnest — single SQL round-trip instead of N sequential updates.
    // The WHERE status IN ('pending', 'verifying') ensures idempotency on retry.
    interface UpdatedRow {
      id: number;
    }
    const result = await sql<UpdatedRow[]>`
      UPDATE proposed_claims AS pc
      SET
        status = v.status,
        verdict_confidence = v.confidence,
        verdict_reasoning = v.reasoning,
        extracted_value = v.extracted_value,
        checker_model = v.checker_model,
        verified_at = NOW(),
        updated_at = NOW()
      FROM unnest(
        ${verdicts.map((v) => v.claimId)}::bigint[],
        ${verdicts.map((v) => v.status)}::text[],
        ${verdicts.map((v) => v.confidence)}::real[],
        ${verdicts.map((v) => v.reasoning)}::text[],
        ${verdicts.map((v) => v.extractedValue ?? null)}::text[],
        ${verdicts.map((v) => v.checkerModel ?? null)}::text[]
      ) AS v(claim_id, status, confidence, reasoning, extracted_value, checker_model)
      WHERE pc.id = v.claim_id AND pc.status IN ('pending', 'verifying')
      RETURNING pc.id
    `;

    return c.json({ updated: result.length, total: verdicts.length });
  })

  // ---- GET /by-ids (fetch claims by ID list, used by sourcing worker) ----

  .get("/by-ids", async (c) => {
    const idsParam = c.req.query("ids");
    if (!idsParam) {
      return validationError(c, "Missing required query parameter: ids");
    }

    const ids = idsParam.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
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
      SELECT id::int, claim_text, source_url, target_table, target_field,
             proposed_value, agent_evidence, resource_id
      FROM proposed_claims
      WHERE id = ANY(${ids})
      ORDER BY id ASC
    `;

    return c.json({ claims });
  })

  // ---- GET /status/:batchId (poll sourcing progress) ----

  .get("/status/:batchId", async (c) => {
    const batchId = c.req.param("batchId");
    const sql = getDb();

    logger.debug({ batchId }, "polling claim status");

    const claims = await sql<ProposedClaimRow[]>`
      SELECT id::int, batch_id, claim_text, status, verdict_confidence, verdict_reasoning, extracted_value
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
  })

  // ---- GET /all (paginated list of all claims) ----

  .get("/all", zv("query", ClaimsAllQuery), async (c) => {
    const { limit, offset, status, target_table, entity_id } = c.req.valid("query");
    const db = getDb();

    interface ClaimListRow {
      id: number;
      batch_id: string;
      claim_text: string;
      entity_id: string | null;
      target_table: string;
      target_field: string | null;
      proposed_value: string | null;
      source_url: string;
      resource_id: string | null;
      status: string;
      verdict_confidence: number | null;
      verdict_reasoning: string | null;
      extracted_value: string | null;
      checker_model: string | null;
      verified_at: string | null;
      submitted_by: string | null;
      created_at: string;
    }

    // Build WHERE conditions dynamically
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 0;

    if (status) {
      conditions.push(`status = $${++paramIdx}`);
      params.push(status);
    }
    if (target_table) {
      conditions.push(`target_table = $${++paramIdx}`);
      params.push(target_table);
    }
    if (entity_id) {
      conditions.push(`entity_id = $${++paramIdx}`);
      params.push(entity_id);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    // Use tagged template for simple queries, unsafe() for dynamic WHERE
    const claims = await db.unsafe<ClaimListRow[]>(
      `SELECT id::int, batch_id, claim_text, entity_id, target_table, target_field,
              proposed_value, source_url, resource_id, status,
              verdict_confidence, verdict_reasoning, extracted_value,
              checker_model, verified_at, submitted_by, created_at
       FROM proposed_claims
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${++paramIdx} OFFSET $${++paramIdx}`,
      [...params, limit, offset],
    );

    const countResult = await db.unsafe<Array<{ cnt: string }>>(
      `SELECT COUNT(*)::text AS cnt FROM proposed_claims ${whereClause}`,
      params,
    );
    const total = parseInt(countResult[0]?.cnt ?? "0", 10);

    return c.json({
      claims: claims.map((row) => ({
        id: row.id,
        batchId: row.batch_id,
        claimText: row.claim_text,
        entityId: row.entity_id,
        targetTable: row.target_table,
        targetField: row.target_field,
        proposedValue: row.proposed_value,
        sourceUrl: row.source_url,
        resourceId: row.resource_id,
        status: row.status,
        confidence: row.verdict_confidence,
        reasoning: row.verdict_reasoning,
        extractedValue: row.extracted_value,
        checkerModel: row.checker_model,
        verifiedAt: row.verified_at,
        submittedBy: row.submitted_by,
        createdAt: row.created_at,
      })),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /stats (aggregate claim metrics) ----

  .get("/stats", async (c) => {
    const db = getDb();

    interface StatsRow {
      total: string;
      pending: string;
      verifying: string;
      verified: string;
      contradicted: string;
      unverifiable: string;
      expired: string;
      unique_entities: string;
      total_batches: string;
      avg_confidence: string;
    }

    const [stats] = await db<StatsRow[]>`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
        COUNT(*) FILTER (WHERE status = 'verifying')::text AS verifying,
        COUNT(*) FILTER (WHERE status = 'verified')::text AS verified,
        COUNT(*) FILTER (WHERE status = 'contradicted')::text AS contradicted,
        COUNT(*) FILTER (WHERE status = 'unverifiable')::text AS unverifiable,
        COUNT(*) FILTER (WHERE status = 'expired')::text AS expired,
        COUNT(DISTINCT entity_id)::text AS unique_entities,
        COUNT(DISTINCT batch_id)::text AS total_batches,
        COALESCE(AVG(verdict_confidence) FILTER (WHERE verdict_confidence IS NOT NULL), 0)::text AS avg_confidence
      FROM proposed_claims
    `;

    interface LinksRow {
      total_links: string;
      linked_claims: string;
    }

    const [links] = await db<LinksRow[]>`
      SELECT
        COUNT(*)::text AS total_links,
        COUNT(DISTINCT claim_id)::text AS linked_claims
      FROM claim_record_links
    `;

    return c.json({
      total: parseInt(stats?.total ?? "0", 10),
      pending: parseInt(stats?.pending ?? "0", 10),
      verifying: parseInt(stats?.verifying ?? "0", 10),
      verified: parseInt(stats?.verified ?? "0", 10),
      contradicted: parseInt(stats?.contradicted ?? "0", 10),
      unverifiable: parseInt(stats?.unverifiable ?? "0", 10),
      expired: parseInt(stats?.expired ?? "0", 10),
      uniqueEntities: parseInt(stats?.unique_entities ?? "0", 10),
      totalBatches: parseInt(stats?.total_batches ?? "0", 10),
      avgConfidence: parseFloat(stats?.avg_confidence ?? "0"),
      recordLinks: {
        totalLinks: parseInt(links?.total_links ?? "0", 10),
        linkedClaims: parseInt(links?.linked_claims ?? "0", 10),
      },
    });
  })

  // ---- GET /by-entity/:entityId (claims for a specific entity) ----

  .get("/by-entity/:entityId", zv("query", ClaimsByEntityQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDb();

    interface EntityClaimRow {
      id: number;
      batch_id: string;
      claim_text: string;
      target_table: string;
      target_field: string | null;
      proposed_value: string | null;
      source_url: string;
      resource_id: string | null;
      status: string;
      verdict_confidence: number | null;
      verdict_reasoning: string | null;
      extracted_value: string | null;
      checker_model: string | null;
      verified_at: string | null;
      created_at: string;
    }

    const claims = await db<EntityClaimRow[]>`
      SELECT id::int, batch_id, claim_text, target_table, target_field,
             proposed_value, source_url, resource_id, status,
             verdict_confidence, verdict_reasoning, extracted_value,
             checker_model, verified_at, created_at
      FROM proposed_claims
      WHERE entity_id = ${entityId}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [countRow] = await db<Array<{ cnt: string }>>`
      SELECT COUNT(*)::text AS cnt
      FROM proposed_claims
      WHERE entity_id = ${entityId}
    `;
    const total = parseInt(countRow?.cnt ?? "0", 10);

    interface RecordLinkRow {
      claim_id: number;
      record_type: string;
      record_id: string;
      match_verdict: string | null;
      match_confidence: number | null;
    }

    const recordLinks = await db<RecordLinkRow[]>`
      SELECT crl.claim_id::int, crl.record_type, crl.record_id,
             crl.match_verdict, crl.match_confidence
      FROM claim_record_links crl
      JOIN proposed_claims pc ON pc.id = crl.claim_id
      WHERE pc.entity_id = ${entityId}
      LIMIT 500
    `;

    return c.json({
      entityId,
      claims: claims.map((row) => ({
        id: row.id,
        batchId: row.batch_id,
        claimText: row.claim_text,
        targetTable: row.target_table,
        targetField: row.target_field,
        proposedValue: row.proposed_value,
        sourceUrl: row.source_url,
        resourceId: row.resource_id,
        status: row.status,
        confidence: row.verdict_confidence,
        reasoning: row.verdict_reasoning,
        extractedValue: row.extracted_value,
        checkerModel: row.checker_model,
        verifiedAt: row.verified_at,
        createdAt: row.created_at,
      })),
      total,
      recordLinks: recordLinks.map((r) => ({
        claimId: r.claim_id,
        recordType: r.record_type,
        recordId: r.record_id,
        matchVerdict: r.match_verdict,
        matchConfidence: r.match_confidence,
      })),
    });
  });

export const claimsRoute = claimsApp;
export type ClaimsRoute = typeof claimsApp;
