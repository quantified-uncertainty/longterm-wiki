/**
 * Tests for writeInlineVerdicts — row-level and per-field verdict writing.
 *
 * Uses a mock DB with Drizzle ORM to test that:
 *   1. Row-level verdicts are written for records with sourcing
 *   2. Per-field verdicts are written when fieldVerdicts is present
 *   3. Evidence rows are written when sourceUrl is present
 *   4. Records without sourcing are skipped
 *   5. Return counts are accurate
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDbModule } from "./test-utils.js";

// ---- In-memory stores ----

interface VerdictRow {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  verdict: string;
  confidence: number | null;
  reasoning: string;
}

interface EvidenceRow {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  sourceUrl: string;
  verdict: string;
  confidence: number | null;
}

let verdictStore: VerdictRow[];
let evidenceStore: EvidenceRow[];

function resetStores() {
  verdictStore = [];
  evidenceStore = [];
}

/**
 * Parse verdict rows from the Drizzle tagged-template params.
 *
 * The SQL template for row-level verdicts (field_name = NULL literal) produces:
 *   params = [recordType, recordId, entityId, verdict, confidence, reasoning]
 * 
 * The SQL template for field-level verdicts (field_name = $param) produces:
 *   params = [recordType, recordId, fieldName, entityId, verdict, confidence, reasoning]
 */
function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- source_check_verdicts: INSERT (upsert) ---
  if (q.includes("insert into source_check_verdicts")) {
    // Detect if this is a field-level verdict (has fieldName param) or row-level (NULL literal).
    // Row-level has 6 interpolated params; field-level has 7.
    // The key difference: row-level has NULL literal for field_name (not a param),
    // field-level has ${fieldName} as a param.
    const isFieldLevel = params.length >= 7;
    
    const row: VerdictRow = isFieldLevel
      ? {
          recordType: params[0] as string,
          recordId: params[1] as string,
          fieldName: params[2] as string | null,
          // params[3] = entityId (skipped)
          verdict: params[4] as string,
          confidence: params[5] as number | null,
          reasoning: params[6] as string,
        }
      : {
          recordType: params[0] as string,
          recordId: params[1] as string,
          fieldName: null,
          // params[2] = entityId (skipped)
          verdict: params[3] as string,
          confidence: params[4] as number | null,
          reasoning: params[5] as string,
        };

    // Simulate ON CONFLICT upsert
    const conflictKey = `${row.recordType}:${row.recordId}:${row.fieldName ?? ""}`;
    const existing = verdictStore.findIndex(
      (v) =>
        `${v.recordType}:${v.recordId}:${v.fieldName ?? ""}` === conflictKey,
    );
    if (existing >= 0) {
      verdictStore[existing] = row;
    } else {
      verdictStore.push(row);
    }
    return [];
  }

  // --- source_check_evidence: INSERT (upsert) ---
  // Params: [recordType, recordId, entityId, sourceUrl, verdict, confidence, evidence, checkerModel, ...]
  // (field_name is NULL literal, not a param)
  if (q.includes("insert into source_check_evidence")) {
    const row: EvidenceRow = {
      recordType: params[0] as string,
      recordId: params[1] as string,
      fieldName: null, // Always NULL for evidence rows
      sourceUrl: params[3] as string,
      verdict: params[4] as string,
      confidence: params[5] as number | null,
    };
    evidenceStore.push(row);
    return [];
  }

  return [];
}

// Mock the db module
vi.mock("../db.js", () => mockDbModule(dispatch));

const { writeInlineVerdicts } = await import(
  "../routes/tablebase/write-inline-verdicts.js"
);

// Get the Drizzle instance from the mock (supports tx.execute())
const dbModule = await import("../db.js");
const drizzleDb = (dbModule as any).getDrizzleDb();

// ---------------------------------------------------------------------------

describe("writeInlineVerdicts", () => {
  beforeEach(resetStores);

  it("returns zero counts when no records have sourcing", async () => {
    const result = await writeInlineVerdicts(drizzleDb, [
      { recordType: "grant", recordId: "g1" },
      { recordType: "grant", recordId: "g2", sourcing: null },
    ]);

    expect(result).toEqual({ written: 0, fieldVerdictsWritten: 0 });
    expect(verdictStore).toHaveLength(0);
    expect(evidenceStore).toHaveLength(0);
  });

  it("writes a row-level verdict for a record with sourcing", async () => {
    const result = await writeInlineVerdicts(drizzleDb, [
      {
        recordType: "grant",
        recordId: "g1",
        entityId: "ent1",
        sourcing: {
          verdict: "confirmed",
          confidence: 0.9,
          evidence: "Found matching grant data",
        },
      },
    ]);

    expect(result.written).toBe(1);
    expect(result.fieldVerdictsWritten).toBe(0);
    expect(verdictStore).toHaveLength(1);
    expect(verdictStore[0]).toMatchObject({
      recordType: "grant",
      recordId: "g1",
      fieldName: null,
      verdict: "confirmed",
      confidence: 0.9,
    });
    expect(verdictStore[0].reasoning).toContain("Inline source-check: confirmed");
    expect(verdictStore[0].reasoning).toContain("Found matching grant data");
  });

  it("writes per-field verdicts when fieldVerdicts is present", async () => {
    const result = await writeInlineVerdicts(drizzleDb, [
      {
        recordType: "grant",
        recordId: "g1",
        entityId: "ent1",
        sourcing: {
          verdict: "confirmed",
          confidence: 0.9,
          fieldVerdicts: {
            amount: { verdict: "confirmed", confidence: 0.95 },
            start_date: { verdict: "contradicted", confidence: 0.8 },
            grantee_id: { verdict: "unverifiable" },
          },
        },
      },
    ]);

    expect(result.written).toBe(1);
    expect(result.fieldVerdictsWritten).toBe(3);
    // 1 row-level + 3 field-level = 4 total verdict rows
    expect(verdictStore).toHaveLength(4);

    // Row-level verdict
    const rowLevel = verdictStore.find((v) => v.fieldName === null);
    expect(rowLevel).toBeDefined();
    expect(rowLevel!.verdict).toBe("confirmed");

    // Field-level verdicts
    const amountVerdict = verdictStore.find((v) => v.fieldName === "amount");
    expect(amountVerdict).toBeDefined();
    expect(amountVerdict!.verdict).toBe("confirmed");
    expect(amountVerdict!.confidence).toBe(0.95);
    expect(amountVerdict!.reasoning).toContain("amount");

    const dateVerdict = verdictStore.find(
      (v) => v.fieldName === "start_date",
    );
    expect(dateVerdict).toBeDefined();
    expect(dateVerdict!.verdict).toBe("contradicted");
    expect(dateVerdict!.confidence).toBe(0.8);

    const granteeVerdict = verdictStore.find(
      (v) => v.fieldName === "grantee_id",
    );
    expect(granteeVerdict).toBeDefined();
    expect(granteeVerdict!.verdict).toBe("unverifiable");
    expect(granteeVerdict!.confidence).toBeNull();
  });

  it("writes evidence row only at row level (not per-field)", async () => {
    const result = await writeInlineVerdicts(drizzleDb, [
      {
        recordType: "grant",
        recordId: "g1",
        sourceUrl: "https://example.com/grants",
        sourcing: {
          verdict: "confirmed",
          confidence: 0.9,
          evidence: "Found it",
          fieldVerdicts: {
            amount: { verdict: "confirmed", confidence: 0.95 },
          },
        },
      },
    ]);

    expect(result.written).toBe(1);
    expect(result.fieldVerdictsWritten).toBe(1);
    // Only 1 evidence row (row-level), not 2
    expect(evidenceStore).toHaveLength(1);
    expect(evidenceStore[0]).toMatchObject({
      recordType: "grant",
      recordId: "g1",
      fieldName: null,
      sourceUrl: "https://example.com/grants",
      verdict: "confirmed",
    });
  });

  it("skips evidence row when no sourceUrl", async () => {
    await writeInlineVerdicts(drizzleDb, [
      {
        recordType: "grant",
        recordId: "g1",
        sourcing: { verdict: "confirmed" },
      },
    ]);

    expect(evidenceStore).toHaveLength(0);
  });

  it("handles multiple records with mixed sourcing and field verdicts", async () => {
    const result = await writeInlineVerdicts(drizzleDb, [
      {
        recordType: "grant",
        recordId: "g1",
        sourcing: {
          verdict: "confirmed",
          fieldVerdicts: {
            amount: { verdict: "confirmed", confidence: 1.0 },
          },
        },
      },
      {
        recordType: "grant",
        recordId: "g2",
        sourcing: null,
      },
      {
        recordType: "grant",
        recordId: "g3",
        sourcing: {
          verdict: "partial",
          fieldVerdicts: {
            amount: { verdict: "confirmed" },
            recipient: { verdict: "outdated" },
          },
        },
      },
    ]);

    expect(result.written).toBe(2);
    expect(result.fieldVerdictsWritten).toBe(3);
    // 2 row-level + 3 field-level = 5
    expect(verdictStore).toHaveLength(5);
  });

  it("handles empty fieldVerdicts object", async () => {
    const result = await writeInlineVerdicts(drizzleDb, [
      {
        recordType: "grant",
        recordId: "g1",
        sourcing: {
          verdict: "confirmed",
          fieldVerdicts: {},
        },
      },
    ]);

    expect(result.written).toBe(1);
    expect(result.fieldVerdictsWritten).toBe(0);
    expect(verdictStore).toHaveLength(1);
  });

  it("upserts row-level verdict on conflict", async () => {
    // First write
    await writeInlineVerdicts(drizzleDb, [
      {
        recordType: "grant",
        recordId: "g1",
        sourcing: { verdict: "partial", confidence: 0.5 },
      },
    ]);
    expect(verdictStore).toHaveLength(1);
    expect(verdictStore[0].verdict).toBe("partial");

    // Second write (same record) — should upsert
    await writeInlineVerdicts(drizzleDb, [
      {
        recordType: "grant",
        recordId: "g1",
        sourcing: { verdict: "confirmed", confidence: 0.95 },
      },
    ]);
    expect(verdictStore).toHaveLength(1);
    expect(verdictStore[0].verdict).toBe("confirmed");
    expect(verdictStore[0].confidence).toBe(0.95);
  });
});
