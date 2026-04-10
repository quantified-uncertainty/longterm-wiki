/**
 * Tests for source-check-join helpers — fetchFieldVerdicts.
 *
 * Uses a mock DB to verify that per-field verdicts are fetched and grouped correctly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDbModule, createQueryResult } from "./test-utils.js";

// ---- In-memory verdict store ----

interface MockVerdict {
  record_type: string;
  record_id: string;
  field_name: string | null;
  verdict: string;
  confidence: number | null;
  last_computed_at: Date | null;
}

let verdictRows: MockVerdict[];

function resetStores() {
  verdictRows = [];
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // Handle Drizzle query builder SELECT from source_check_verdicts
  if (q.includes("source_check_verdicts")) {
    // Filter by record_type and field_name IS NOT NULL
    return verdictRows
      .filter((r) => r.field_name !== null)
      .sort((a, b) => {
        const cmp = a.record_id.localeCompare(b.record_id);
        if (cmp !== 0) return cmp;
        return (a.field_name ?? "").localeCompare(b.field_name ?? "");
      });
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { fetchFieldVerdicts } = await import(
  "../routes/shared/source-check-join.js"
);

// ---------------------------------------------------------------------------

describe("fetchFieldVerdicts", () => {
  beforeEach(resetStores);

  it("returns empty map for empty recordIds", async () => {
    const result = await fetchFieldVerdicts("grant", []);
    expect(result.size).toBe(0);
  });

  it("returns per-field verdicts grouped by recordId", async () => {
    verdictRows = [
      {
        record_type: "grant",
        record_id: "g1",
        field_name: null,
        verdict: "confirmed",
        confidence: 0.9,
        last_computed_at: new Date("2025-01-01"),
      },
      {
        record_type: "grant",
        record_id: "g1",
        field_name: "amount",
        verdict: "confirmed",
        confidence: 0.95,
        last_computed_at: new Date("2025-01-01"),
      },
      {
        record_type: "grant",
        record_id: "g1",
        field_name: "start_date",
        verdict: "contradicted",
        confidence: 0.8,
        last_computed_at: new Date("2025-01-01"),
      },
      {
        record_type: "grant",
        record_id: "g2",
        field_name: "amount",
        verdict: "partial",
        confidence: 0.6,
        last_computed_at: new Date("2025-01-02"),
      },
    ];

    const result = await fetchFieldVerdicts("grant", ["g1", "g2"]);

    expect(result.size).toBe(2);

    const g1Fields = result.get("g1");
    expect(g1Fields).toBeDefined();
    expect(g1Fields).toHaveLength(2);
    expect(g1Fields![0].fieldName).toBe("amount");
    expect(g1Fields![0].verdict).toBe("confirmed");
    expect(g1Fields![0].confidence).toBe(0.95);
    expect(g1Fields![1].fieldName).toBe("start_date");
    expect(g1Fields![1].verdict).toBe("contradicted");

    const g2Fields = result.get("g2");
    expect(g2Fields).toBeDefined();
    expect(g2Fields).toHaveLength(1);
    expect(g2Fields![0].fieldName).toBe("amount");
    expect(g2Fields![0].verdict).toBe("partial");
  });

  it("excludes row-level verdicts (field_name IS NULL)", async () => {
    verdictRows = [
      {
        record_type: "grant",
        record_id: "g1",
        field_name: null,
        verdict: "confirmed",
        confidence: 0.9,
        last_computed_at: new Date("2025-01-01"),
      },
    ];

    const result = await fetchFieldVerdicts("grant", ["g1"]);
    expect(result.size).toBe(0);
  });
});
