/**
 * Regression tests for GET /api/sourcing/coverage (QUA-422).
 *
 * Before this fix, the endpoint counted distinct `record_id`s in
 * `source_check_verdicts` with no filter on live records, so orphan verdicts
 * (rows referencing records deleted from their source table) inflated the
 * "verified" count. In prod the consequence was >100% coverage ratios
 * (grant 100.22%, personnel 124.31%) until cleanup-orphans was run.
 *
 * These tests assert (a) the query shape uses the shared LIVE_RECORDS_CTE
 * + INNER JOIN pattern that /stats, /coverage-matrix, and /verdict-matrix
 * already use, and (b) the handler's arithmetic correctly pairs per-type
 * totals with per-type verified counts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { type SqlDispatcher, mockDbModule } from "./test-utils";

let capturedQueries: string[] = [];

// Canned query results. The /coverage handler runs exactly two SELECTs:
//   1. A big UNION ALL that totals rows per source table
//   2. A CTE+JOIN that counts distinct verified record_ids per type
let tableTotals: Array<{ table_name: string; total: number }> = [];
let verifiedCounts: Array<{ record_type: string; verified: number }> = [];

const dispatch: SqlDispatcher = (query, _params) => {
  capturedQueries.push(query);
  if (/UNION ALL/i.test(query) && /table_name/i.test(query)) {
    return tableTotals;
  }
  if (/live_records/i.test(query) && /record_type/i.test(query)) {
    return verifiedCounts;
  }
  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

interface CoverageResponse {
  coverage: Array<{
    recordType: string;
    total: number;
    verified: number;
    percentage: number;
    exempt: boolean;
  }>;
  exemptTypes: string[];
}

describe("GET /api/sourcing/coverage — QUA-422 orphan filter", () => {
  let app: Hono;

  beforeEach(() => {
    capturedQueries = [];
    tableTotals = [];
    verifiedCounts = [];
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("dispatches the verified-count query through LIVE_RECORDS_CTE + INNER JOIN", async () => {
    await app.request("/api/sourcing/coverage");

    const verifiedQuery = capturedQueries.find(
      (q) => /live_records/i.test(q) && /source_check_verdicts/i.test(q),
    );
    expect(
      verifiedQuery,
      "verified-count query must use the LIVE_RECORDS_CTE — this filters orphan verdicts",
    ).toBeDefined();

    expect(
      /WITH\s+\n?\s*live_records/i.test(verifiedQuery!),
      `expected CTE prefix:\n${verifiedQuery}`,
    ).toBe(true);
    expect(
      /INNER\s+JOIN\s+live_records/i.test(verifiedQuery!),
      `expected INNER JOIN to filter orphans:\n${verifiedQuery}`,
    ).toBe(true);
    expect(
      /count\s*\(\s*DISTINCT\s+v\.record_id\s*\)/i.test(verifiedQuery!),
      `expected DISTINCT record_id count:\n${verifiedQuery}`,
    ).toBe(true);
  });

  it("never reports verified > total for any record type", async () => {
    // Seed the mock with the kind of drift seen in prod pre-QUA-149:
    // grant has 5876 live records but 5889 verdict rows (51 orphans);
    // personnel has 975 live but 1212 verdict rows (237 orphans).
    // With the CTE filter applied, verifiedCounts is what the JOIN returns —
    // i.e. only the live ones. So we seed verifiedCounts at or below total.
    tableTotals = [
      { table_name: "grant", total: 5876 },
      { table_name: "personnel", total: 975 },
      { table_name: "wiki-page", total: 885 },
    ];
    verifiedCounts = [
      { record_type: "grant", verified: 5838 },
      { record_type: "personnel", verified: 832 },
      { record_type: "wiki-page", verified: 0 },
    ];

    const res = await app.request("/api/sourcing/coverage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CoverageResponse;

    for (const row of body.coverage) {
      expect(
        row.verified,
        `verified=${row.verified} exceeds total=${row.total} for ${row.recordType} — orphans leaking past CTE`,
      ).toBeLessThanOrEqual(row.total);
      expect(row.percentage).toBeLessThanOrEqual(100);
    }
  });

  it("returns zero percentage for types with total=0 (no divide-by-zero)", async () => {
    tableTotals = [{ table_name: "wiki-page", total: 0 }];
    verifiedCounts = [];

    const res = await app.request("/api/sourcing/coverage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CoverageResponse;

    const wikiPage = body.coverage.find((r) => r.recordType === "wiki-page");
    expect(wikiPage).toBeDefined();
    expect(wikiPage!.percentage).toBe(0);
    expect(wikiPage!.verified).toBe(0);
    expect(wikiPage!.total).toBe(0);
  });

  it("marks exempt types with exempt=true", async () => {
    tableTotals = [
      { table_name: "grant", total: 100 },
      { table_name: "citation", total: 50 }, // exempt
      { table_name: "benchmark-result", total: 20 }, // exempt
    ];
    verifiedCounts = [
      { record_type: "grant", verified: 90 },
      { record_type: "citation", verified: 45 },
    ];

    const res = await app.request("/api/sourcing/coverage");
    const body = (await res.json()) as CoverageResponse;

    const grant = body.coverage.find((r) => r.recordType === "grant");
    const citation = body.coverage.find((r) => r.recordType === "citation");
    const benchmark = body.coverage.find(
      (r) => r.recordType === "benchmark-result",
    );

    expect(grant?.exempt).toBe(false);
    expect(citation?.exempt).toBe(true);
    expect(benchmark?.exempt).toBe(true);
    expect(body.exemptTypes).toContain("citation");
    expect(body.exemptTypes).toContain("benchmark-result");
  });

  it("includes record types present only in verified counts (phantom types)", async () => {
    // Defensive: if a verdict exists for a record_type the UNION ALL
    // doesn't enumerate (unlikely post-orphan-filter, but possible
    // during a schema migration), the type should still appear in output
    // with total=0.
    tableTotals = [{ table_name: "grant", total: 100 }];
    verifiedCounts = [
      { record_type: "grant", verified: 80 },
      { record_type: "ghost-type", verified: 3 },
    ];

    const res = await app.request("/api/sourcing/coverage");
    const body = (await res.json()) as CoverageResponse;
    const ghost = body.coverage.find((r) => r.recordType === "ghost-type");
    expect(ghost).toBeDefined();
    expect(ghost!.total).toBe(0);
    expect(ghost!.verified).toBe(3);
    // percentage guarded against div-by-zero
    expect(ghost!.percentage).toBe(0);
  });

  it("returns all known types sorted by recordType alphabetically", async () => {
    tableTotals = [
      { table_name: "personnel", total: 10 },
      { table_name: "grant", total: 20 },
      { table_name: "division", total: 5 },
    ];
    verifiedCounts = [
      { record_type: "personnel", verified: 8 },
      { record_type: "grant", verified: 18 },
      { record_type: "division", verified: 4 },
    ];

    const res = await app.request("/api/sourcing/coverage");
    const body = (await res.json()) as CoverageResponse;
    const types = body.coverage.map((r) => r.recordType);
    const sorted = [...types].sort();
    expect(types).toEqual(sorted);
  });
});
