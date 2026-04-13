/**
 * Integration tests for POST /api/sourcing/cleanup-orphans (QUA-149).
 *
 * The handler runs up to 3 SQL statements per call:
 *  - dry-run:   3× `SELECT record_type, COUNT(*) ... GROUP BY record_type`
 *  - non-dry:   3× `DELETE ... RETURNING record_type` (inside a transaction)
 *
 * The mock dispatcher distinguishes these by query shape and routes to the
 * appropriate canned result set. Tests mutate the canned sets per-test to
 * model different database states.
 *
 * The dispatcher also records the `(query, params)` pairs it sees so tests
 * can assert on actual parameter values instead of matching substrings —
 * the previous version of these tests matched `/record_type\s*=/` which
 * hit the unrelated JOIN clauses and produced false-positive assertions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { type SqlDispatcher, mockDbModule, postJson } from "./test-utils";

interface CapturedCall {
  query: string;
  params: unknown[];
  insideTransaction: boolean;
}

let capturedCalls: CapturedCall[] = [];
let beginCallCount = 0;
let insideTransaction = false;

// Canned result sets per table. Tests mutate these in beforeEach.
// - `groupRows*` feed the dry-run GROUP BY SELECTs.
// - `deletedRows*` feed the non-dryRun DELETE ... RETURNING.
// When non-empty, deleted* wins if the query is a DELETE.
let groupRowsVerdicts: Array<{ record_type: string; cnt: number }> = [];
let groupRowsEvidence: Array<{ record_type: string; cnt: number }> = [];
let groupRowsSuggestions: Array<{ record_type: string; cnt: number }> = [];
let deletedRowsVerdicts: Array<{ record_type: string }> = [];
let deletedRowsEvidence: Array<{ record_type: string }> = [];
let deletedRowsSuggestions: Array<{ record_type: string }> = [];

function classifyQuery(query: string): {
  table: "verdicts" | "evidence" | "suggestions" | "other";
  kind: "delete" | "select" | "other";
} {
  const isDelete = /^\s*with[\s\S]+delete\s+from/i.test(query);
  const isSelect = !isDelete && /select/i.test(query);
  let table: "verdicts" | "evidence" | "suggestions" | "other" = "other";
  if (/source_check_verdicts/.test(query)) table = "verdicts";
  else if (/source_check_evidence/.test(query)) table = "evidence";
  else if (/sourcing_url_suggestions/.test(query)) table = "suggestions";
  return {
    table,
    kind: isDelete ? "delete" : isSelect ? "select" : "other",
  };
}

const dispatch: SqlDispatcher = (query, params) => {
  capturedCalls.push({ query, params, insideTransaction });
  const { table, kind } = classifyQuery(query);
  if (kind === "delete") {
    if (table === "verdicts") return deletedRowsVerdicts;
    if (table === "evidence") return deletedRowsEvidence;
    if (table === "suggestions") return deletedRowsSuggestions;
  }
  if (kind === "select") {
    if (table === "verdicts") return groupRowsVerdicts;
    if (table === "evidence") return groupRowsEvidence;
    if (table === "suggestions") return groupRowsSuggestions;
  }
  return [];
};

vi.mock("../db.js", () => {
  // Patch mockSql.begin so tests can verify the handler wraps all three
  // DELETEs in a single transaction. Each captured call records whether
  // it happened inside a begin()/end() window.
  return mockDbModule(dispatch).then((mod) => {
    const mockSql = mod.getDb();
    const origBegin = mockSql.begin.bind(mockSql);
    mockSql.begin = async (fn: (tx: typeof mockSql) => Promise<unknown>) => {
      beginCallCount += 1;
      insideTransaction = true;
      try {
        return await origBegin(fn);
      } finally {
        insideTransaction = false;
      }
    };
    return mod;
  });
});

const { createApp } = await import("../app.js");

function queriesForTable(
  table: "verdicts" | "evidence" | "suggestions",
  kind: "delete" | "select",
): CapturedCall[] {
  return capturedCalls.filter((c) => {
    const classified = classifyQuery(c.query);
    return classified.table === table && classified.kind === kind;
  });
}

describe("POST /api/sourcing/cleanup-orphans", () => {
  let app: Hono;

  beforeEach(() => {
    capturedCalls = [];
    beginCallCount = 0;
    insideTransaction = false;
    groupRowsVerdicts = [];
    groupRowsEvidence = [];
    groupRowsSuggestions = [];
    deletedRowsVerdicts = [];
    deletedRowsEvidence = [];
    deletedRowsSuggestions = [];
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ── dry-run path ──

  it("returns dryRun=true and zero counts when no orphans exist", async () => {
    const res = await postJson(app, "/api/sourcing/cleanup-orphans", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      deleted: { verdicts: number; evidence: number; suggestions: number };
      byType: Record<string, unknown>;
    };
    expect(body.dryRun).toBe(true);
    expect(body.deleted).toEqual({ verdicts: 0, evidence: 0, suggestions: 0 });
    expect(body.byType).toEqual({});
  });

  it("aggregates dry-run GROUP BY counts into byType and totals", async () => {
    groupRowsVerdicts = [
      { record_type: "personnel", cnt: 2 },
      { record_type: "grant", cnt: 1 },
    ];
    groupRowsEvidence = [
      { record_type: "personnel", cnt: 1 },
      { record_type: "grant", cnt: 1 },
    ];
    groupRowsSuggestions = [{ record_type: "personnel", cnt: 1 }];

    const res = await postJson(app, "/api/sourcing/cleanup-orphans", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      deleted: { verdicts: number; evidence: number; suggestions: number };
      byType: Record<
        string,
        { verdicts: number; evidence: number; suggestions: number }
      >;
    };
    expect(body.dryRun).toBe(true);
    expect(body.deleted).toEqual({ verdicts: 3, evidence: 2, suggestions: 1 });
    expect(body.byType.personnel).toEqual({
      verdicts: 2,
      evidence: 1,
      suggestions: 1,
    });
    expect(body.byType.grant).toEqual({
      verdicts: 1,
      evidence: 1,
      suggestions: 0,
    });
  });

  it("dry-run uses GROUP BY record_type — not a raw row scan", async () => {
    await postJson(app, "/api/sourcing/cleanup-orphans", {});
    // All three dry-run SELECTs must include `GROUP BY .record_type`.
    // This is the memory protection — without GROUP BY a million-orphan
    // result set would be materialized in Node.
    const groupByQueries = capturedCalls.filter((c) =>
      /group\s+by\s+\w+\.record_type/i.test(c.query),
    );
    expect(groupByQueries.length).toBe(3);
  });

  it("does NOT run DELETE statements in dry-run mode", async () => {
    await postJson(app, "/api/sourcing/cleanup-orphans", { dryRun: true });
    const deletes = capturedCalls.filter(
      (c) => classifyQuery(c.query).kind === "delete",
    );
    expect(deletes.length).toBe(0);
  });

  // ── non-dry-run path ──

  it("runs DELETE RETURNING statements when dryRun=false", async () => {
    deletedRowsVerdicts = [{ record_type: "personnel" }];
    const res = await postJson(app, "/api/sourcing/cleanup-orphans", {
      dryRun: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      deleted: { verdicts: number; evidence: number; suggestions: number };
    };
    expect(body.dryRun).toBe(false);
    expect(body.deleted.verdicts).toBe(1);

    expect(queriesForTable("verdicts", "delete").length).toBe(1);
    expect(queriesForTable("evidence", "delete").length).toBe(1);
    expect(queriesForTable("suggestions", "delete").length).toBe(1);
  });

  it("every DELETE statement includes `RETURNING record_type`", async () => {
    await postJson(app, "/api/sourcing/cleanup-orphans", { dryRun: false });
    const deletes = capturedCalls.filter(
      (c) => classifyQuery(c.query).kind === "delete",
    );
    expect(deletes.length).toBe(3);
    for (const d of deletes) {
      expect(
        /returning\s+\w+\.record_type/i.test(d.query),
        `DELETE missing RETURNING record_type:\n${d.query}`,
      ).toBe(true);
    }
  });

  it("aggregates non-dry-run byType from DELETE RETURNING rows", async () => {
    deletedRowsVerdicts = [
      { record_type: "personnel" },
      { record_type: "personnel" },
      { record_type: "grant" },
    ];
    deletedRowsEvidence = [{ record_type: "grant" }];
    deletedRowsSuggestions = [{ record_type: "personnel" }];

    const res = await postJson(app, "/api/sourcing/cleanup-orphans", {
      dryRun: false,
    });
    const body = (await res.json()) as {
      dryRun: boolean;
      deleted: { verdicts: number; evidence: number; suggestions: number };
      byType: Record<
        string,
        { verdicts: number; evidence: number; suggestions: number }
      >;
    };
    expect(body.dryRun).toBe(false);
    expect(body.deleted).toEqual({ verdicts: 3, evidence: 1, suggestions: 1 });
    expect(body.byType.personnel).toEqual({
      verdicts: 2,
      evidence: 0,
      suggestions: 1,
    });
    expect(body.byType.grant).toEqual({
      verdicts: 1,
      evidence: 1,
      suggestions: 0,
    });
  });

  it("wraps all three DELETEs in a single transaction", async () => {
    // Instrumented begin() spy flips `insideTransaction` for the duration
    // of the begin()/end() window. Every DELETE must record insideTransaction=true.
    // If a future refactor pulls a DELETE out of the transaction, that
    // DELETE will record insideTransaction=false and this test will fail.
    await postJson(app, "/api/sourcing/cleanup-orphans", { dryRun: false });
    expect(beginCallCount).toBe(1);
    const deletes = capturedCalls.filter(
      (c) => classifyQuery(c.query).kind === "delete",
    );
    expect(deletes.length).toBe(3);
    for (const d of deletes) {
      expect(
        d.insideTransaction,
        `DELETE ran outside transaction:\n${d.query}`,
      ).toBe(true);
    }
  });

  // ── recordType scoping ──

  it("passes recordType through as a bound SQL parameter (not interpolated)", async () => {
    await postJson(app, "/api/sourcing/cleanup-orphans", {
      recordType: "personnel",
    });
    // `personnel` must appear in the bound params array for each of the
    // three dry-run SELECTs — not in the query string. Drizzle emits
    // positional placeholders for interpolated values, so finding the
    // literal in params (not in query) is the correct assertion.
    const selectsPerTable = {
      verdicts: queriesForTable("verdicts", "select"),
      evidence: queriesForTable("evidence", "select"),
      suggestions: queriesForTable("suggestions", "select"),
    };
    for (const [, calls] of Object.entries(selectsPerTable)) {
      expect(calls.length).toBe(1);
      expect(calls[0].params).toContain("personnel");
    }
  });

  it("omits the recordType filter when recordType is not provided", async () => {
    await postJson(app, "/api/sourcing/cleanup-orphans", {});
    // Without recordType, the bound parameter list for each table's SELECT
    // should NOT contain a spurious type string.
    const allSelects = capturedCalls.filter(
      (c) => classifyQuery(c.query).kind === "select",
    );
    for (const call of allSelects) {
      expect(call.params).not.toContain("personnel");
    }
  });

  it("rejects empty-string recordType (would silently scan all types)", async () => {
    const res = await postJson(app, "/api/sourcing/cleanup-orphans", {
      recordType: "",
    });
    expect(res.status).toBe(400);
    expect(capturedCalls.length).toBe(0);
  });

  it("rejects oversized recordType", async () => {
    const res = await postJson(app, "/api/sourcing/cleanup-orphans", {
      recordType: "x".repeat(100),
    });
    expect(res.status).toBe(400);
    expect(capturedCalls.length).toBe(0);
  });

  // ── safety rails ──

  it("only touches record_types present in LIVE_RECORDS_CTE", async () => {
    await postJson(app, "/api/sourcing/cleanup-orphans", {});
    const queriesWithGuard = capturedCalls.filter((c) =>
      /record_type\s+in\s*\(\s*select\s+distinct\s+record_type\s+from\s+live_records/i.test(
        c.query,
      ),
    );
    expect(queriesWithGuard.length).toBeGreaterThanOrEqual(3);
  });

  it("uses NOT EXISTS against live_records to find orphans", async () => {
    await postJson(app, "/api/sourcing/cleanup-orphans", {});
    const notExistsQueries = capturedCalls.filter((c) =>
      /not\s+exists\s*\(\s*select\s+1\s+from\s+live_records/i.test(c.query),
    );
    expect(notExistsQueries.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects invalid JSON body", async () => {
    const res = await app.request("/api/sourcing/cleanup-orphans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-boolean dryRun", async () => {
    const res = await postJson(app, "/api/sourcing/cleanup-orphans", {
      dryRun: "maybe",
    });
    expect(res.status).toBe(400);
  });
});
