/**
 * Shared claim validation for TableBase sync endpoints.
 *
 * When records include `claimIds`, this utility:
 * 1. Validates all cited claim IDs exist and are verified
 * 2. Creates claim_record_links rows in the same transaction
 *
 * Part of the claims-first sourcing architecture (#3253, Component 5).
 */

import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { logger } from "../../logger.js";

type RawDb = ReturnType<typeof import("../../db.js").getDb>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaimValidationInput {
  recordId: string;
  recordType: string;
  claimIds: number[];
}

interface ClaimValidationResult {
  /** Number of claim_record_links created */
  linked: number;
  /** Number of records submitted without claimIds (logged for metrics) */
  unverifiedCount: number;
}

interface ClaimStatusRow {
  id: number;
  status: string;
  entity_id: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that all referenced claim IDs exist and are verified.
 * Returns an error message string if validation fails, or null if OK.
 */
export async function validateClaimRefs(
  db: RawDb,
  claimIds: number[],
): Promise<string | null> {
  if (claimIds.length === 0) return null;

  const status = await classifyClaims(db, claimIds);

  if (status.missing.length > 0) {
    return `Claim IDs not found: ${status.missing.join(", ")}`;
  }

  if (status.nonVerified.length > 0) {
    const details = status.nonVerified
      .map((r) => `${r.id} (${r.status})`)
      .join(", ");
    return `Claims not verified: ${details}. Only verified claims can be used to submit records.`;
  }

  return null;
}

/**
 * Classify a batch of claim IDs into missing / non-verified / verified sets.
 * Used internally by {@link validateClaimRefs}.
 */
export async function classifyClaims(
  db: RawDb,
  claimIds: number[],
): Promise<{
  missing: number[];
  nonVerified: Array<{ id: number; status: string }>;
}> {
  if (claimIds.length === 0) {
    return { missing: [], nonVerified: [] };
  }

  const unique = [...new Set(claimIds)];
  const rows = await db<ClaimStatusRow[]>`
    SELECT id::int, status, entity_id
    FROM proposed_claims
    WHERE id = ANY(${unique}::bigint[])
  `;

  // Cast to Number because postgres.js may return bigserial as string
  const foundIds = new Set(rows.map((r) => Number(r.id)));
  const missing = unique.filter((id) => !foundIds.has(id));
  const nonVerified = rows
    .filter((r) => r.status !== "verified")
    .map((r) => ({ id: Number(r.id), status: r.status }));

  return { missing, nonVerified };
}

// ---------------------------------------------------------------------------
// Link creation
// ---------------------------------------------------------------------------

/**
 * Create claim_record_links for records that cite verified claims.
 * Call this within the sync handler's transaction or after the upsert.
 *
 * Records without claimIds are counted as "unverified submissions" for metrics.
 */
export async function linkClaimsToRecords(
  db: RawDb,
  records: Array<{
    recordId: string;
    recordType: string;
    claimIds?: number[] | null;
  }>,
): Promise<ClaimValidationResult> {
  const withClaims = records.filter(
    (r) => r.claimIds && r.claimIds.length > 0,
  );
  const unverifiedCount = records.length - withClaims.length;

  if (withClaims.length === 0) {
    return { linked: 0, unverifiedCount };
  }

  // Build batch insert values
  const linkRows: Array<{ claimId: number; recordType: string; recordId: string }> = [];
  for (const record of withClaims) {
    for (const claimId of record.claimIds!) {
      linkRows.push({
        claimId,
        recordType: record.recordType,
        recordId: record.recordId,
      });
    }
  }

  if (linkRows.length > 0) {
    await db`
      INSERT INTO claim_record_links (claim_id, record_type, record_id)
      SELECT * FROM unnest(
        ${linkRows.map((r) => r.claimId)}::bigint[],
        ${linkRows.map((r) => r.recordType)}::text[],
        ${linkRows.map((r) => r.recordId)}::text[]
      )
      ON CONFLICT (claim_id, record_type, record_id) DO NOTHING
    `;
  }

  if (unverifiedCount > 0) {
    logger.info(
      { unverifiedCount, totalRecords: records.length, linkedRecords: withClaims.length },
      "sync: records submitted without claim sourcing",
    );
  }

  return { linked: linkRows.length, unverifiedCount };
}
