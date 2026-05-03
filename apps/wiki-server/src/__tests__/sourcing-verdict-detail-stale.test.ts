/**
 * Read-side integration test for QUA-991 stale-evidence handling.
 *
 * `recompute-verdict.test.ts` covers the write path (recomputeVerdict +
 * loadEvidenceRows). This file pins the OTHER aggregation site — the
 * `GET /verdicts/:recordType/:recordId` handler in `sourcing.ts:759` that
 * re-runs `aggregateEvidence` on read for the detail-page render. If a
 * future refactor drops `isStale: isStaleModel(...)` from the read-side
 * map-build, the public detail page would silently re-display the stuck
 * `partial` verdict even though the persisted row reads `confirmed` —
 * exactly the QUA-991 prod symptom returning by another path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, type SqlDispatcher } from "./test-utils.js";

const CURRENT = "claude-haiku-4-5-20251001";
const OLD = "claude-3-5-sonnet-20241022";

interface VerdictRow {
  record_type: string;
  record_id: string;
  field_name: string | null;
  entity_id: string | null;
  display_name: string | null;
  entity_display_name: string | null;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sources_checked: number;
  needs_recheck: boolean;
  next_check_due: Date | null;
  last_computed_at: Date;
  created_at: Date;
  updated_at: Date;
}

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
  relevance_score: number | null;
  is_primary_source: boolean;
  checker_model: string | null;
  notes: string | null;
  checked_at: Date | null;
}

let verdictStore: VerdictRow[] = [];
let evidenceStore: EvidenceRow[] = [];

const dispatch: SqlDispatcher = (query) => {
  const q = query.toLowerCase().trim();
  if (q.startsWith("select") && q.includes("from \"source_check_verdicts\"")) {
    return verdictStore;
  }
  if (q.startsWith("select") && q.includes("from \"source_check_evidence\"")) {
    return evidenceStore;
  }
  // Anything else (claim_provenance fetches, etc.) returns empty.
  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { sourcingRoute } = await import("../routes/sourcing/sourcing.js");

function buildApp(): Hono {
  const app = new Hono();
  app.route("/", sourcingRoute);
  return app;
}

describe("GET /verdicts/:recordType/:recordId — read-side stale handling (QUA-991)", () => {
  beforeEach(() => {
    verdictStore = [];
    evidenceStore = [];
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  function seedVerdict(over: Partial<VerdictRow> = {}): void {
    const now = new Date();
    verdictStore.push({
      record_type: "investment",
      record_id: "inv_test",
      field_name: null,
      entity_id: null,
      display_name: null,
      entity_display_name: null,
      verdict: "partial",
      confidence: 0.6,
      reasoning: "1 → confirmed; dissent: 1 → partial",
      sources_checked: 2,
      needs_recheck: false,
      next_check_due: null,
      last_computed_at: now,
      created_at: now,
      updated_at: now,
      ...over,
    });
  }

  function seedEvidence(over: Partial<EvidenceRow> = {}): void {
    const now = new Date();
    evidenceStore.push({
      id: evidenceStore.length + 1,
      record_type: "investment",
      record_id: "inv_test",
      field_name: null,
      entity_id: null,
      expected_value: null,
      resource_id: null,
      source_url: "https://example.com",
      extracted_value: null,
      extracted_quote: null,
      verdict: "confirmed",
      confidence: 0.95,
      relevance_score: 1.0,
      is_primary_source: false,
      checker_model: CURRENT,
      notes: null,
      checked_at: now,
      ...over,
    });
  }

  it("read-side aggregation drops stale rows when a fresh row is present", async () => {
    seedVerdict();
    seedEvidence({
      verdict: "confirmed",
      confidence: 0.95,
      checker_model: CURRENT,
      checked_at: new Date("2026-05-01T00:00:00Z"),
    });
    seedEvidence({
      verdict: "partial",
      confidence: 0.6,
      checker_model: OLD,
      checked_at: new Date("2026-04-21T00:00:00Z"),
    });

    const res = await buildApp().request("/verdicts/investment/inv_test");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      verdictAggregations: Record<
        string,
        { verdict: string; droppedStale: { verdict: string; rowCount: number }[] }
      >;
    };

    const aggregate = body.verdictAggregations[""];
    // Live aggregation reflects the QUA-991 fix even though the persisted
    // verdict row still says "partial" (it'll re-flip on the next recompute).
    expect(aggregate.verdict).toBe("confirmed");
    expect(aggregate.droppedStale).toHaveLength(1);
    expect(aggregate.droppedStale[0]).toMatchObject({
      verdict: "partial",
      rowCount: 1,
    });
  });

  it("read-side aggregation falls back to current behavior when every row is stale", async () => {
    seedVerdict();
    seedEvidence({
      verdict: "partial",
      checker_model: OLD,
      checked_at: new Date("2026-04-01T00:00:00Z"),
    });
    seedEvidence({
      verdict: "partial",
      checker_model: OLD,
      checked_at: new Date("2026-04-10T00:00:00Z"),
    });

    const res = await buildApp().request("/verdicts/investment/inv_test");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verdictAggregations: Record<
        string,
        { verdict: string; droppedStale: unknown[] }
      >;
    };

    expect(body.verdictAggregations[""].verdict).toBe("partial");
    expect(body.verdictAggregations[""].droppedStale).toEqual([]);
  });

  it("treats NULL checker_model as stale on the read side", async () => {
    seedVerdict();
    seedEvidence({
      verdict: "confirmed",
      checker_model: CURRENT,
      checked_at: new Date("2026-05-01T00:00:00Z"),
    });
    seedEvidence({
      verdict: "partial",
      checker_model: null,
      checked_at: new Date("2026-03-01T00:00:00Z"),
    });

    const res = await buildApp().request("/verdicts/investment/inv_test");
    const body = (await res.json()) as {
      verdictAggregations: Record<
        string,
        { verdict: string; droppedStale: { verdict: string }[] }
      >;
    };

    expect(body.verdictAggregations[""].verdict).toBe("confirmed");
    expect(body.verdictAggregations[""].droppedStale.map((c) => c.verdict)).toEqual([
      "partial",
    ]);
  });
});
