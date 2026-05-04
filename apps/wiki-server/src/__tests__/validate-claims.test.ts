import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDbModule, type SqlDispatcher } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Mock DB with in-memory proposed_claims store
// ---------------------------------------------------------------------------

interface MockClaim {
  id: number;
  status: string;
  entity_id: string | null;
}

let claimStore: MockClaim[] = [];
let capturedQueries: Array<{ query: string; params: unknown[] }> = [];

function resetStores() {
  claimStore = [];
  capturedQueries = [];
}

const dispatch: SqlDispatcher = (query, params) => {
  const q = query.toLowerCase();
  capturedQueries.push({ query, params });

  // SELECT id, status, entity_id FROM proposed_claims WHERE id = ANY(...)
  if (q.includes("proposed_claims") && q.includes("any")) {
    const ids = params[0] as number[];
    return claimStore.filter((c) => ids.includes(c.id));
  }

  // INSERT INTO claim_record_links
  if (q.includes("claim_record_links") && q.includes("insert")) {
    const claimIds = params[0] as number[];
    return [{ count: claimIds.length }];
  }

  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

// Import AFTER mock setup
const { validateClaimRefs, classifyClaims, linkClaimsToRecords } = await import(
  "../routes/shared/validate-claims.js"
);
const { getDb } = await import("../db.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateClaimRefs", () => {
  beforeEach(() => {
    resetStores();
  });

  it("returns null when all claim IDs exist and are verified", async () => {
    claimStore = [
      { id: 1, status: "verified", entity_id: "anthropic" },
      { id: 2, status: "verified", entity_id: "anthropic" },
      { id: 3, status: "verified", entity_id: null },
    ];

    const db = getDb();
    const result = await validateClaimRefs(db, [1, 2, 3]);
    expect(result).toBeNull();
  });

  it("returns null for empty claimIds array", async () => {
    const db = getDb();
    const result = await validateClaimRefs(db, []);
    expect(result).toBeNull();
  });

  it("returns error for missing claim IDs", async () => {
    claimStore = [
      { id: 1, status: "verified", entity_id: null },
    ];

    const db = getDb();
    const result = await validateClaimRefs(db, [1, 99, 100]);
    expect(result).not.toBeNull();
    expect(result).toContain("not found");
    expect(result).toContain("99");
    expect(result).toContain("100");
  });

  it("returns error for non-verified claims", async () => {
    claimStore = [
      { id: 1, status: "verified", entity_id: null },
      { id: 2, status: "pending", entity_id: null },
      { id: 3, status: "contradicted", entity_id: null },
    ];

    const db = getDb();
    const result = await validateClaimRefs(db, [1, 2, 3]);
    expect(result).not.toBeNull();
    expect(result).toContain("not verified");
    expect(result).toContain("2 (pending)");
    expect(result).toContain("3 (contradicted)");
  });

  it("deduplicates claim IDs", async () => {
    claimStore = [
      { id: 1, status: "verified", entity_id: null },
    ];

    const db = getDb();
    const result = await validateClaimRefs(db, [1, 1, 1]);
    expect(result).toBeNull();

    // The query should only receive unique IDs
    const selectQuery = capturedQueries.find(
      (q) => q.query.toLowerCase().includes("proposed_claims"),
    );
    expect(selectQuery).toBeDefined();
    expect(selectQuery!.params[0]).toEqual([1]);
  });

  it("uses ::bigint[] cast in SQL query for type safety", async () => {
    claimStore = [
      { id: 1, status: "verified", entity_id: null },
    ];

    const db = getDb();
    await validateClaimRefs(db, [1]);

    const selectQuery = capturedQueries.find(
      (q) => q.query.toLowerCase().includes("proposed_claims"),
    );
    expect(selectQuery).toBeDefined();
    // The SQL must include ::bigint[] cast to match bigserial column type.
    // Without this cast, postgres.js infers wrong type and returns 0 rows.
    expect(selectQuery!.query).toContain("::bigint[]");
  });
});

describe("classifyClaims", () => {
  beforeEach(() => {
    resetStores();
  });

  it("returns empty buckets for an empty claim list", async () => {
    const db = getDb();
    const result = await classifyClaims(db, []);
    expect(result).toEqual({ missing: [], nonVerified: [] });
  });

  it("returns empty buckets when every claim is verified", async () => {
    claimStore = [
      { id: 1, status: "verified", entity_id: null },
      { id: 2, status: "verified", entity_id: null },
    ];
    const db = getDb();
    const result = await classifyClaims(db, [1, 2]);
    expect(result).toEqual({ missing: [], nonVerified: [] });
  });

  it("identifies missing claims", async () => {
    claimStore = [{ id: 1, status: "verified", entity_id: null }];
    const db = getDb();
    const result = await classifyClaims(db, [1, 99, 100]);
    expect(result.missing).toEqual([99, 100]);
    expect(result.nonVerified).toEqual([]);
  });

  it("identifies non-verified claims with their statuses", async () => {
    claimStore = [
      { id: 1, status: "verified", entity_id: null },
      { id: 2, status: "pending", entity_id: null },
      { id: 3, status: "contradicted", entity_id: null },
    ];
    const db = getDb();
    const result = await classifyClaims(db, [1, 2, 3]);
    expect(result.missing).toEqual([]);
    expect(result.nonVerified).toEqual([
      { id: 2, status: "pending" },
      { id: 3, status: "contradicted" },
    ]);
  });

  it("can return both missing and non-verified buckets in one call", async () => {
    claimStore = [
      { id: 1, status: "verified", entity_id: null },
      { id: 2, status: "pending", entity_id: null },
    ];
    const db = getDb();
    const result = await classifyClaims(db, [1, 2, 99]);
    expect(result.missing).toEqual([99]);
    expect(result.nonVerified).toEqual([{ id: 2, status: "pending" }]);
  });

  it("deduplicates claim IDs before querying", async () => {
    claimStore = [{ id: 1, status: "verified", entity_id: null }];
    const db = getDb();
    await classifyClaims(db, [1, 1, 1]);
    const selectQuery = capturedQueries.find((q) =>
      q.query.toLowerCase().includes("proposed_claims"),
    );
    expect(selectQuery!.params[0]).toEqual([1]);
  });
});

describe("linkClaimsToRecords", () => {
  beforeEach(() => {
    resetStores();
  });

  it("creates links for records with claimIds", async () => {
    const db = getDb();
    const result = await linkClaimsToRecords(db, [
      { recordId: "rec-1", recordType: "personnel", claimIds: [10, 20] },
      { recordId: "rec-2", recordType: "personnel", claimIds: [30] },
    ]);

    expect(result.linked).toBe(3);
    expect(result.unverifiedCount).toBe(0);
  });

  it("counts records without claimIds as unverified", async () => {
    const db = getDb();
    const result = await linkClaimsToRecords(db, [
      { recordId: "rec-1", recordType: "personnel", claimIds: [10] },
      { recordId: "rec-2", recordType: "personnel", claimIds: null },
      { recordId: "rec-3", recordType: "personnel" },
    ]);

    expect(result.linked).toBe(1);
    expect(result.unverifiedCount).toBe(2);
  });

  it("returns zero counts when all records lack claimIds", async () => {
    const db = getDb();
    const result = await linkClaimsToRecords(db, [
      { recordId: "rec-1", recordType: "personnel" },
      { recordId: "rec-2", recordType: "personnel", claimIds: [] },
    ]);

    expect(result.linked).toBe(0);
    expect(result.unverifiedCount).toBe(2);
  });

  it("uses ::bigint[] cast in INSERT SQL", async () => {
    const db = getDb();
    await linkClaimsToRecords(db, [
      { recordId: "rec-1", recordType: "personnel", claimIds: [10] },
    ]);

    const insertQuery = capturedQueries.find(
      (q) => q.query.toLowerCase().includes("claim_record_links"),
    );
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.query).toContain("::bigint[]");
  });
});
