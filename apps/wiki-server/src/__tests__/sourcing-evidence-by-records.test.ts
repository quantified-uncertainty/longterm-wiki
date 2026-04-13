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

function reset(): void {
  store = [];
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
  const q = query.toLowerCase().trim();

  // Only the evidence-by-records handler issues SELECTs against
  // source_check_evidence in this test suite.
  if (
    q.startsWith("select") &&
    q.includes("from") &&
    q.includes("source_check_evidence")
  ) {
    // Dispatcher reads parameters positionally. For the batch handler the
    // shape is: $1 = recordType, $2...$N = recordIds in `inArray`.
    const [recordType, ...recordIds] = params as [string, ...string[]];
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
    const res = await postJson(buildApp(), PATH, { records: [] });
    expect(res.status).toBe(400);
  });

  it("rejects missing records field", async () => {
    const res = await postJson(buildApp(), PATH, {});
    expect(res.status).toBe(400);
  });

  it("rejects batches over MAX_EVIDENCE_BY_RECORDS (1000)", async () => {
    const records = Array.from({ length: 1001 }, (_, i) => ({
      recordType: "fact",
      recordId: `F${i}`,
    }));
    const res = await postJson(buildApp(), PATH, { records });
    expect(res.status).toBe(400);
  });

  it("rejects oversized recordId", async () => {
    const res = await postJson(buildApp(), PATH, {
      records: [{ recordType: "fact", recordId: "x".repeat(501) }],
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid limitPerRecord (negative)", async () => {
    const res = await postJson(buildApp(), PATH, {
      records: [{ recordType: "fact", recordId: "F1" }],
      limitPerRecord: -1,
    });
    expect(res.status).toBe(400);
  });

  it("returns empty evidenceByKey when no records match", async () => {
    const res = await postJson(buildApp(), PATH, {
      records: [{ recordType: "fact", recordId: "does-not-exist" }],
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
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evidenceByKey: Record<string, unknown[]> };
    // Missing records are absent from the map — not empty arrays — so
    // callers can distinguish "no evidence" from "skipped".
    expect(Object.keys(body.evidenceByKey)).toEqual(["fact|F1"]);
    expect("fact|F-missing" in body.evidenceByKey).toBe(false);
  });

  it("deduplicates duplicate records in the request", async () => {
    seed({ record_type: "fact", record_id: "F1", source_url: "https://example.com/a" });

    const res = await postJson(buildApp(), PATH, {
      records: [
        { recordType: "fact", recordId: "F1" },
        { recordType: "fact", recordId: "F1" },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evidenceByKey: Record<string, Array<{ sourceUrl: string }>>;
    };
    // Single bucket, single evidence row — duplicates collapsed.
    expect(body.evidenceByKey["fact|F1"]).toHaveLength(1);
  });

  it("respects limitPerRecord cap across multiple evidence rows", async () => {
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

  it("handles multiple record types in one request (one IN query per type)", async () => {
    seed({ record_type: "fact", record_id: "F1", source_url: "https://example.com/fact1" });
    seed({ record_type: "grant", record_id: "G1", source_url: "https://example.com/grant1" });

    const res = await postJson(buildApp(), PATH, {
      records: [
        { recordType: "fact", recordId: "F1" },
        { recordType: "grant", recordId: "G1" },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evidenceByKey: Record<string, Array<{ sourceUrl: string }>>;
    };
    expect(body.evidenceByKey["fact|F1"][0].sourceUrl).toBe("https://example.com/fact1");
    expect(body.evidenceByKey["grant|G1"][0].sourceUrl).toBe("https://example.com/grant1");
  });

  it("returns isStale=true when checker_model differs from CURRENT_CHECKER_MODEL", async () => {
    seed({
      record_type: "fact",
      record_id: "F1",
      checker_model: "some-old-model",
    });
    const res = await postJson(buildApp(), PATH, {
      records: [{ recordType: "fact", recordId: "F1" }],
    });
    const body = (await res.json()) as {
      evidenceByKey: Record<string, Array<{ isStale: boolean }>>;
    };
    expect(body.evidenceByKey["fact|F1"][0].isStale).toBe(true);
  });
});
