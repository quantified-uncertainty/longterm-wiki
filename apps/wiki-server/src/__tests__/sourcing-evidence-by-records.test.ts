/**
 * Tests for POST /api/sourcing/evidence/by-records (QUA-331).
 *
 * Batch evidence lookup replaces N+1 HTTP calls in three crux commands
 * (sourcing-suggest-urls, sourcing-audit-urls, sourcing-recheck). The
 * endpoint groups requested records by recordType and issues one `IN (...)`
 * query per type.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson, type SqlDispatcher } from "./test-utils.js";

interface EvidenceRow {
  id: number;
  record_type: string;
  record_id: string;
  field_name: string | null;
  entity_id: string | null;
  expected_value: string | null;
  resource_id: string | null;
  source_url: string | null;
  extracted_value: string | null;
  extracted_quote: string | null;
  verdict: string;
  confidence: number | null;
  is_primary_source: boolean;
  checker_model: string | null;
  notes: string | null;
  checked_at: Date;
}

let store: EvidenceRow[];
/**
 * Every SQL query the route dispatches, with its parameter array.
 * Tests use this to assert on batching/dedup behavior at the SQL layer
 * (not just the response shape, which can mask bugs like missing dedup).
 */
let capturedQueries: Array<{ query: string; params: unknown[] }>;

function reset(): void {
  store = [];
  capturedQueries = [];
}

function seed(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  const now = new Date();
  const row: EvidenceRow = {
    id: store.length + 1,
    record_type: "fact",
    record_id: "F1",
    field_name: null,
    entity_id: "anthropic",
    expected_value: null,
    resource_id: null,
    source_url: "https://example.com/a",
    extracted_value: null,
    extracted_quote: null,
    verdict: "confirmed",
    confidence: 0.9,
    is_primary_source: false,
    checker_model: "claude-haiku-4-5-20251001",
    notes: null,
    checked_at: now,
    ...overrides,
  };
  store.push(row);
  return row;
}

const dispatch: SqlDispatcher = (query, params) => {
  capturedQueries.push({ query, params: [...params] });
  const q = query.toLowerCase().trim();

  // Only the evidence-by-records handler issues SELECTs against
  // source_check_evidence in this test suite.
  if (
    q.startsWith("select") &&
    q.includes("from") &&
    q.includes("source_check_evidence")
  ) {
    // Parse the WHERE clause to find which param positions correspond
    // to record_type and record_id. This is robust to Drizzle reordering
    // the clause under a refactor — the old positional `[type, ...ids]`
    // was fragile enough to mask bugs.
    //
    // Regex is anchored to the fully-qualified column
    // (`"source_check_evidence"."record_type"`) so a future JOIN that
    // introduces a same-named column on another table can't accidentally
    // match the wrong param slot.
    const recordTypeMatch = query.match(
      /"source_check_evidence"\."record_type"\s*=\s*\$(\d+)/,
    );
    const recordIdInMatch = query.match(
      /"source_check_evidence"\."record_id"\s+in\s*\(([\s\S]*?)\)/i,
    );
    if (!recordTypeMatch || !recordIdInMatch) return [];

    const recordType = String(params[Number(recordTypeMatch[1]) - 1]);
    const idParamIndices = [...recordIdInMatch[1].matchAll(/\$(\d+)/g)].map(
      (m) => Number(m[1]) - 1,
    );
    const recordIds = idParamIndices.map((i) => String(params[i]));

    return store
      .filter(
        (r) =>
          r.record_type === recordType &&
          recordIds.includes(r.record_id),
      )
      .sort((a, b) => {
        // sourceUrl ASC, checked_at DESC — matches the handler's orderBy.
        const urlA = a.source_url ?? "";
        const urlB = b.source_url ?? "";
        if (urlA !== urlB) return urlA < urlB ? -1 : 1;
        return b.checked_at.getTime() - a.checked_at.getTime();
      });
  }
  return [];
};

/**
 * Extract the recordId param values from the most recent
 * `SELECT ... FROM source_check_evidence` query. Used by dedup and
 * batching tests to assert on the SQL layer, not just the response.
 */
function lastSelectRecordIds(): string[] {
  for (let i = capturedQueries.length - 1; i >= 0; i--) {
    const { query, params } = capturedQueries[i];
    if (
      !query.toLowerCase().includes("from") ||
      !query.includes("source_check_evidence") ||
      !query.toLowerCase().startsWith("select")
    ) {
      continue;
    }
    const m = query.match(
      /"source_check_evidence"\."record_id"\s+in\s*\(([\s\S]*?)\)/i,
    );
    if (!m) continue;
    return [...m[1].matchAll(/\$(\d+)/g)].map((pm) =>
      String(params[Number(pm[1]) - 1]),
    );
  }
  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { sourcingRoute } = await import("../routes/sourcing/sourcing.js");

function buildApp(): Hono {
  const app = new Hono();
  app.route("/", sourcingRoute);
  return app;
}

const PATH = "/evidence/by-records";

describe("POST /api/sourcing/evidence/by-records (QUA-331)", () => {
  beforeEach(() => {
    reset();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  it("rejects invalid JSON", async () => {
    const res = await buildApp().request(PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  it("rejects empty records array", async () => {
    const res = await postJson(buildApp(), PATH, { records: [], limitPerRecord: 5 });
    expect(res.status).toBe(400);
  });

  it("rejects missing records field", async () => {
    const res = await postJson(buildApp(), PATH, { limitPerRecord: 5 });
    expect(res.status).toBe(400);
  });

  it("rejects missing limitPerRecord (required to avoid unbounded row fetches)", async () => {
    const res = await postJson(buildApp(), PATH, {
      records: [{ recordType: "fact", recordId: "F1" }],
    });
    expect(res.status).toBe(400);
  });

  it("rejects batches over MAX_EVIDENCE_BY_RECORDS (1000)", async () => {
    const records = Array.from({ length: 1001 }, (_, i) => ({
      recordType: "fact",
      recordId: `F${i}`,
    }));
    const res = await postJson(buildApp(), PATH, { records, limitPerRecord: 5 });
    expect(res.status).toBe(400);
  });

  it("rejects oversized recordId", async () => {
    const res = await postJson(buildApp(), PATH, {
      records: [{ recordType: "fact", recordId: "x".repeat(501) }],
      limitPerRecord: 5,
    });
    expect(res.status).toBe(400);
  });

  it("parameterizes SQL-injection-shaped recordIds (not string-interpolated)", async () => {
    // Adversarial recordId. Drizzle uses postgres.js parameter binding,
    // so this should show up as a literal param value, not inlined into
    // the query. Expect 200 + empty result (no matching row), not 500
    // (SQL parse error) or any row leakage.
    const payload = "'; DROP TABLE source_check_evidence; --";
    const res = await postJson(buildApp(), PATH, {
      records: [{ recordType: "fact", recordId: payload }],
      limitPerRecord: 5,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evidenceByKey: Record<string, unknown[]> };
    expect(body.evidenceByKey).toEqual({});

    // The payload must appear in params, NOT in the query text.
    const evSelect = capturedQueries.find(
      (c) =>
        c.query.toLowerCase().startsWith("select") &&
        c.query.includes("source_check_evidence"),
    );
    expect(evSelect).toBeDefined();
    expect(evSelect?.query.includes("DROP TABLE")).toBe(false);
    expect(evSelect?.params).toContain(payload);
  });

  it("rejects invalid limitPerRecord (negative)", async () => {
    const res = await postJson(buildApp(), PATH, {
      records: [{ recordType: "fact", recordId: "F1" }],
      limitPerRecord: -1,
    });
    expect(res.status).toBe(400);
  });

  it("rejects limitPerRecord over MAX_PAGE_SIZE (200)", async () => {
    const res = await postJson(buildApp(), PATH, {
      records: [{ recordType: "fact", recordId: "F1" }],
      limitPerRecord: 201,
    });
    expect(res.status).toBe(400);
  });

  it("returns empty evidenceByKey when no records match", async () => {
    const res = await postJson(buildApp(), PATH, {
      records: [{ recordType: "fact", recordId: "does-not-exist" }],
      limitPerRecord: 5,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evidenceByKey: Record<string, unknown[]>;
      currentCheckerModel: string;
    };
    expect(body.evidenceByKey).toEqual({});
    expect(body.currentCheckerModel).toBe("claude-haiku-4-5-20251001");
  });

  it("returns evidence keyed by `recordType|recordId` for matching records", async () => {
    seed({ record_type: "fact", record_id: "F1", source_url: "https://example.com/a" });
    seed({ record_type: "fact", record_id: "F2", source_url: "https://example.com/b" });

    const res = await postJson(buildApp(), PATH, {
      records: [
        { recordType: "fact", recordId: "F1" },
        { recordType: "fact", recordId: "F2" },
      ],
      limitPerRecord: 5,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evidenceByKey: Record<string, Array<{ sourceUrl: string }>>;
    };
    expect(Object.keys(body.evidenceByKey).sort()).toEqual(["fact|F1", "fact|F2"]);
    expect(body.evidenceByKey["fact|F1"][0].sourceUrl).toBe("https://example.com/a");
    expect(body.evidenceByKey["fact|F2"][0].sourceUrl).toBe("https://example.com/b");
  });

  it("returns partial matches when only some records have evidence", async () => {
    seed({ record_type: "fact", record_id: "F1", source_url: "https://example.com/a" });

    const res = await postJson(buildApp(), PATH, {
      records: [
        { recordType: "fact", recordId: "F1" },
        { recordType: "fact", recordId: "F-missing" },
      ],
      limitPerRecord: 5,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evidenceByKey: Record<string, unknown[]> };
    // Missing records are absent from the map — not empty arrays — so
    // callers can distinguish "no evidence" from "skipped".
    expect(Object.keys(body.evidenceByKey)).toEqual(["fact|F1"]);
    expect("fact|F-missing" in body.evidenceByKey).toBe(false);
  });

  it("deduplicates duplicate records at the SQL layer", async () => {
    seed({ record_type: "fact", record_id: "F1", source_url: "https://example.com/a" });

    const res = await postJson(buildApp(), PATH, {
      records: [
        { recordType: "fact", recordId: "F1" },
        { recordType: "fact", recordId: "F1" },
        { recordType: "fact", recordId: "F1" },
      ],
      limitPerRecord: 5,
    });
    expect(res.status).toBe(200);
    // Assert on the SQL layer: only ONE `F1` should be in the IN clause,
    // not three. A response-shape-only assertion would pass regardless of
    // whether dedup happened.
    expect(lastSelectRecordIds()).toEqual(["F1"]);
  });

  it("respects limitPerRecord cap for a single record", async () => {
    seed({ record_type: "fact", record_id: "F1", source_url: "https://example.com/a" });
    seed({ record_type: "fact", record_id: "F1", source_url: "https://example.com/b" });
    seed({ record_type: "fact", record_id: "F1", source_url: "https://example.com/c" });

    const res = await postJson(buildApp(), PATH, {
      records: [{ recordType: "fact", recordId: "F1" }],
      limitPerRecord: 2,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evidenceByKey: Record<string, Array<{ sourceUrl: string }>>;
    };
    expect(body.evidenceByKey["fact|F1"]).toHaveLength(2);
    // Ordered by sourceUrl ASC — first two are 'a' and 'b'.
    expect(body.evidenceByKey["fact|F1"].map((e) => e.sourceUrl)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("applies limitPerRecord PER RECORD, not globally, when rows are interleaved", async () => {
    // SQL orderBy is sourceUrl ASC, so rows come back in this order:
    // A-rec1, A-rec2, B-rec1, B-rec2, C-rec1, C-rec2. A global LIMIT of 1
    // would yield only A-rec1; a correct per-record cap yields A-rec1 +
    // A-rec2 (first row each). This test guards the explicit handler
    // comment about "cap is per (recordType, recordId)".
    seed({ record_type: "fact", record_id: "F1", source_url: "https://example.com/a" });
    seed({ record_type: "fact", record_id: "F2", source_url: "https://example.com/b" });
    seed({ record_type: "fact", record_id: "F1", source_url: "https://example.com/c" });
    seed({ record_type: "fact", record_id: "F2", source_url: "https://example.com/d" });

    const res = await postJson(buildApp(), PATH, {
      records: [
        { recordType: "fact", recordId: "F1" },
        { recordType: "fact", recordId: "F2" },
      ],
      limitPerRecord: 1,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evidenceByKey: Record<string, Array<{ sourceUrl: string }>>;
    };
    // Both records present; each has exactly 1 row (the first by
    // sourceUrl ASC, which is row 'a' for F1 and row 'b' for F2).
    expect(body.evidenceByKey["fact|F1"]).toHaveLength(1);
    expect(body.evidenceByKey["fact|F2"]).toHaveLength(1);
    expect(body.evidenceByKey["fact|F1"][0].sourceUrl).toBe("https://example.com/a");
    expect(body.evidenceByKey["fact|F2"][0].sourceUrl).toBe("https://example.com/b");
  });

  it("handles multiple record types in one request (one IN query per type)", async () => {
    seed({ record_type: "fact", record_id: "F1", source_url: "https://example.com/fact1" });
    seed({ record_type: "grant", record_id: "G1", source_url: "https://example.com/grant1" });

    const res = await postJson(buildApp(), PATH, {
      records: [
        { recordType: "fact", recordId: "F1" },
        { recordType: "grant", recordId: "G1" },
      ],
      limitPerRecord: 5,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evidenceByKey: Record<string, Array<{ sourceUrl: string }>>;
    };
    expect(body.evidenceByKey["fact|F1"][0].sourceUrl).toBe("https://example.com/fact1");
    expect(body.evidenceByKey["grant|G1"][0].sourceUrl).toBe("https://example.com/grant1");

    // SQL-layer assertion: one SELECT per recordType, not one massive IN.
    const selects = capturedQueries.filter(
      ({ query }) =>
        query.toLowerCase().startsWith("select") &&
        query.includes("source_check_evidence"),
    );
    expect(selects).toHaveLength(2);
  });

  it("sets isStale=true for stale checker_model and false for current", async () => {
    seed({
      record_type: "fact",
      record_id: "F1",
      checker_model: "some-old-model",
    });
    seed({
      record_type: "fact",
      record_id: "F2",
      checker_model: "claude-haiku-4-5-20251001",
    });
    const res = await postJson(buildApp(), PATH, {
      records: [
        { recordType: "fact", recordId: "F1" },
        { recordType: "fact", recordId: "F2" },
      ],
      limitPerRecord: 5,
    });
    const body = (await res.json()) as {
      evidenceByKey: Record<string, Array<{ isStale: boolean }>>;
    };
    expect(body.evidenceByKey["fact|F1"][0].isStale).toBe(true);
    expect(body.evidenceByKey["fact|F2"][0].isStale).toBe(false);
  });
});
