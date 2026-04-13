/**
 * Integration tests for POST /api/sourcing/cleanup-orphans (QUA-149).
 *
 * The handler runs up to 6 SQL statements depending on dryRun:
 *  - SELECT orphan verdicts
 *  - SELECT orphan evidence
 *  - SELECT orphan url-suggestions
 *  - (non-dryRun only) DELETE orphan verdicts
 *  - (non-dryRun only) DELETE orphan evidence
 *  - (non-dryRun only) DELETE orphan url-suggestions
 *
 * The mock dispatcher distinguishes these by query substring and returns
 * canned rows so we can assert on the counts the handler reports.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { type SqlDispatcher, mockDbModule, postJson } from "./test-utils";

let capturedQueries: string[] = [];

// Canned row sets per table. Tests can mutate these in beforeEach.
let verdictRows: Array<{ record_type: string; record_id: string; field_name: string | null }> = [];
let evidenceRows: Array<{ id: number; record_type: string }> = [];
let suggestionRows: Array<{ id: number; record_type: string }> = [];

const dispatch: SqlDispatcher = (query, _params) => {
  capturedQueries.push(query);
  // Route the query to the right canned result based on which table it reads/writes.
  // DELETE queries also match on table name.
  if (query.match(/from\s+source_check_verdicts/i) || query.match(/delete\s+from\s+source_check_verdicts/i)) {
    return verdictRows;
  }
  if (query.match(/from\s+source_check_evidence/i) || query.match(/delete\s+from\s+source_check_evidence/i)) {
    return evidenceRows;
  }
  if (query.match(/from\s+sourcing_url_suggestions/i) || query.match(/delete\s+from\s+sourcing_url_suggestions/i)) {
    return suggestionRows;
  }
  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

describe("POST /api/sourcing/cleanup-orphans", () => {
  let app: Hono;

  beforeEach(() => {
    capturedQueries = [];
    verdictRows = [];
    evidenceRows = [];
    suggestionRows = [];
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

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

  it("counts orphans across verdicts/evidence/suggestions in dry-run", async () => {
    verdictRows = [
      { record_type: "personnel", record_id: "p1", field_name: null },
      { record_type: "personnel", record_id: "p2", field_name: "role" },
      { record_type: "grant", record_id: "g1", field_name: null },
    ];
    evidenceRows = [
      { id: 10, record_type: "personnel" },
      { id: 11, record_type: "grant" },
    ];
    suggestionRows = [{ id: 20, record_type: "personnel" }];

    const res = await postJson(app, "/api/sourcing/cleanup-orphans", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      deleted: { verdicts: number; evidence: number; suggestions: number };
      byType: Record<string, { verdicts: number; evidence: number; suggestions: number }>;
    };
    expect(body.dryRun).toBe(true);
    expect(body.deleted).toEqual({ verdicts: 3, evidence: 2, suggestions: 1 });
    expect(body.byType.personnel).toEqual({ verdicts: 2, evidence: 1, suggestions: 1 });
    expect(body.byType.grant).toEqual({ verdicts: 1, evidence: 1, suggestions: 0 });
  });

  it("does NOT run DELETE statements in dry-run mode", async () => {
    verdictRows = [{ record_type: "personnel", record_id: "p1", field_name: null }];
    await postJson(app, "/api/sourcing/cleanup-orphans", { dryRun: true });
    const deletes = capturedQueries.filter((q) => /^\s*with[\s\S]+delete\s+from/i.test(q));
    expect(deletes.length).toBe(0);
  });

  it("runs DELETE statements when dryRun=false", async () => {
    verdictRows = [{ record_type: "personnel", record_id: "p1", field_name: null }];
    const res = await postJson(app, "/api/sourcing/cleanup-orphans", { dryRun: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean };
    expect(body.dryRun).toBe(false);

    // Expect one DELETE per table in the transaction.
    const deleteVerdicts = capturedQueries.filter((q) =>
      /delete\s+from\s+source_check_verdicts/i.test(q),
    );
    const deleteEvidence = capturedQueries.filter((q) =>
      /delete\s+from\s+source_check_evidence/i.test(q),
    );
    const deleteSuggestions = capturedQueries.filter((q) =>
      /delete\s+from\s+sourcing_url_suggestions/i.test(q),
    );
    expect(deleteVerdicts.length).toBe(1);
    expect(deleteEvidence.length).toBe(1);
    expect(deleteSuggestions.length).toBe(1);
  });

  it("scopes SELECTs by record_type when recordType is provided", async () => {
    await postJson(app, "/api/sourcing/cleanup-orphans", {
      recordType: "personnel",
    });
    // Every SELECT that touches the three target tables should include the
    // record_type filter. Check by substring since the mock stringifies
    // parameters as positional placeholders.
    const scopedSelects = capturedQueries.filter(
      (q) =>
        /from\s+(source_check_verdicts|source_check_evidence|sourcing_url_suggestions)/i.test(q) &&
        /record_type\s*=/i.test(q),
    );
    expect(scopedSelects.length).toBe(3);
  });

  it("only touches record_types present in LIVE_RECORDS_CTE", async () => {
    // Assert the handler constrains the delete/select set via
    // `record_type IN (SELECT DISTINCT record_type FROM live_records)`.
    // That's the protection against deleting unknown-type rows.
    await postJson(app, "/api/sourcing/cleanup-orphans", {});
    const queriesWithGuard = capturedQueries.filter(
      (q) =>
        /from\s+(source_check_verdicts|source_check_evidence|sourcing_url_suggestions)/i.test(q) &&
        /record_type\s+in\s*\(\s*select\s+distinct\s+record_type\s+from\s+live_records/i.test(q),
    );
    expect(queriesWithGuard.length).toBeGreaterThanOrEqual(3);
  });

  it("uses NOT EXISTS against live_records to find orphans", async () => {
    await postJson(app, "/api/sourcing/cleanup-orphans", {});
    const notExistsQueries = capturedQueries.filter(
      (q) =>
        /from\s+(source_check_verdicts|source_check_evidence|sourcing_url_suggestions)/i.test(q) &&
        /not\s+exists\s*\(\s*select\s+1\s+from\s+live_records/i.test(q),
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

  it("rejects oversized recordType", async () => {
    const res = await postJson(app, "/api/sourcing/cleanup-orphans", {
      recordType: "x".repeat(100),
    });
    expect(res.status).toBe(400);
  });
});
