/**
 * Route test for the /api/third-party-evaluations/sync inline sourcing
 * block (QUA-727).
 *
 * Verifies that:
 *   - The route accepts `sourcing` on each item and writes to the
 *     source_check_verdicts + source_check_evidence tables.
 *   - Items without `sourcing` skip the verdict-write phase but still upsert
 *     the row (sourcing is optional — the table isn't in SOURCE_CHECK_REQUIRED).
 *   - The `sourcing` field is stripped from the row insert (it's not a
 *     column on `third_party_evaluations`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

let insertedRowKeys: string[][] = [];
let verdictInsertCount = 0;
let evidenceInsertCount = 0;

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // validate-entity-refs: every supplied entity ref resolves
  if (q.includes("unnest") && q.includes("from entities")) {
    return params.map((p) => ({ ref: p }));
  }

  // Capture the third_party_evaluations insert column list so we can assert
  // `sourcing` is NOT among them.
  if (q.includes("insert into") && q.includes("third_party_evaluations")) {
    const match = query.match(/insert into\s+"third_party_evaluations"\s*\(([^)]+)\)/i);
    if (match) {
      const cols = match[1]
        .split(",")
        .map((c) => c.trim().replace(/^"|"$/g, ""));
      insertedRowKeys.push(cols);
    }
    return [];
  }

  if (q.includes("insert into") && q.includes("source_check_verdicts")) {
    verdictInsertCount++;
    return [];
  }
  if (q.includes("insert into") && q.includes("source_check_evidence")) {
    evidenceInsertCount++;
    return [];
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { thirdPartyEvaluationsRoute } = await import(
  "../routes/tablebase/third-party-evaluations.js"
);

describe("third-party-evaluations /sync — inline sourcing (QUA-727)", () => {
  beforeEach(() => {
    insertedRowKeys = [];
    verdictInsertCount = 0;
    evidenceInsertCount = 0;
  });

  it("writes a source_check_verdicts row when sourcing is present", async () => {
    const app = new Hono().route("/", thirdPartyEvaluationsRoute);

    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "abcdef0001",
          evaluatorOrgId: "sid_pKeaWwP6sQ",
          reportUrl: "https://example.com/report.pdf",
          title: "Smoke-test report",
          riskDomain: ["cyber"],
          sourceSystem: "manual",
          sourcing: {
            verdict: "confirmed",
            confidence: 0.95,
            evidence: "Pre-deployment evaluation excerpt",
            checkedBy: "span-verify-v1",
            checkedAt: "2026-04-25T10:30:00.000Z",
            sourceContentHash: "deadbeef",
          },
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ upserted: 1, verdictsWritten: 1 });

    expect(verdictInsertCount).toBeGreaterThan(0);
    // Evidence row also written when sourceUrl is set (toVerdict passes reportUrl)
    expect(evidenceInsertCount).toBeGreaterThan(0);
  });

  it("strips sourcing from the row insert (it's not a third_party_evaluations column)", async () => {
    const app = new Hono().route("/", thirdPartyEvaluationsRoute);

    await postJson(app, "/sync", {
      items: [
        {
          id: "abcdef0002",
          evaluatorOrgId: "sid_pKeaWwP6sQ",
          reportUrl: "https://example.com/r2.pdf",
          title: "Test",
          riskDomain: ["cyber"],
          sourceSystem: "manual",
          sourcing: {
            verdict: "partial",
            confidence: 0.7,
            checkedBy: "span-verify-v1",
            checkedAt: "2026-04-25T10:30:00.000Z",
          },
        },
      ],
    });

    expect(insertedRowKeys.length).toBeGreaterThan(0);
    for (const cols of insertedRowKeys) {
      expect(cols).not.toContain("sourcing");
    }
  });

  it("skips verdict write when sourcing is absent", async () => {
    const app = new Hono().route("/", thirdPartyEvaluationsRoute);

    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "abcdef0003",
          evaluatorOrgId: "sid_pKeaWwP6sQ",
          reportUrl: "https://example.com/r3.pdf",
          title: "No sourcing",
          riskDomain: ["cyber"],
          sourceSystem: "manual",
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ upserted: 1, verdictsWritten: 0 });
    expect(verdictInsertCount).toBe(0);
  });

  it("rejects an invalid sourcing.verdict value", async () => {
    const app = new Hono().route("/", thirdPartyEvaluationsRoute);

    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "abcdef0004",
          evaluatorOrgId: "sid_pKeaWwP6sQ",
          reportUrl: "https://example.com/r4.pdf",
          title: "Bad verdict",
          riskDomain: ["cyber"],
          sourceSystem: "manual",
          sourcing: {
            verdict: "bogus" as unknown as "confirmed",
            confidence: 0.9,
          },
        },
      ],
    });

    expect(res.status).toBe(400);
  });
});
