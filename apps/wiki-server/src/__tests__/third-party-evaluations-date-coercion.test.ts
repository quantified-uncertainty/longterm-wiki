/**
 * Regression test for the /api/third-party-evaluations/upsert 500 error
 * (`value.toISOString is not a function`).
 *
 * Root cause: the Drizzle `extracted_at` column is `timestamp({ withTimezone:
 * true })` (mode: 'date'), so postgres-js calls `.toISOString()` on the value
 * during insert. The Zod schema accepts `extractedAt` as an ISO string on the
 * wire; without coercion in `toRow`, that string flows through to the driver
 * and explodes inside Drizzle's postgres-js adapter, surfacing as a
 * SyncPhaseError(500).
 *
 * Verified by reverting the toRow coercion: this exact test reproduces the
 * prod stack trace (`value.toISOString is not a function`) before the fix,
 * and passes with the fix applied. Same pattern exists in model-system-cards
 * and is fixed in the same PR.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

let dispatchCalls = 0;

function dispatch(query: string, _params: unknown[]): unknown[] {
  dispatchCalls++;
  const q = query.toLowerCase();

  // validate-entity-refs: pretend every supplied entity ref resolves
  if (q.includes("unnest") && q.includes("from entities")) {
    return _params.map((p) => ({ ref: p }));
  }

  // Everything else (insert, audit, things, fan-out, SELECT for audit
  // pre-fetch): permissive empty result so the route runs to completion.
  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { thirdPartyEvaluationsRoute } = await import(
  "../routes/tablebase/third-party-evaluations.js"
);

// ---------------------------------------------------------------------------

describe("third-party-evaluations /sync — date coercion (QUA-734)", () => {
  beforeEach(() => {
    dispatchCalls = 0;
  });

  it("accepts ISO string for extractedAt without throwing in postgres-js", async () => {
    // Pre-fix this returned 500 with `value.toISOString is not a function`
    // because postgres-js called .toISOString() on the raw string. The fix:
    // toRow coerces the string to a Date so postgres-js can serialize it.
    const app = new Hono().route("/", thirdPartyEvaluationsRoute);

    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "abcdef0123",
          evaluatorOrgId: "sid_pKeaWwP6sQ",
          reportUrl: "https://example.com/report.pdf",
          title: "Smoke-test report",
          riskDomain: ["cyber"],
          sourceSystem: "manual",
          extractedAt: "2026-04-25T10:30:00.000Z",
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ upserted: 1 });
  });

  it("accepts null extractedAt and stores null", async () => {
    const app = new Hono().route("/", thirdPartyEvaluationsRoute);

    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "abcdef0124",
          evaluatorOrgId: "sid_pKeaWwP6sQ",
          reportUrl: "https://example.com/other.pdf",
          title: "Smoke-test no extract",
          riskDomain: ["cyber"],
          sourceSystem: "manual",
          extractedAt: null,
        },
      ],
    });

    expect(res.status).toBe(200);
  });

  it("accepts omitted extractedAt", async () => {
    const app = new Hono().route("/", thirdPartyEvaluationsRoute);

    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "abcdef0125",
          evaluatorOrgId: "sid_pKeaWwP6sQ",
          reportUrl: "https://example.com/missing.pdf",
          title: "Smoke-test no field",
          riskDomain: ["cyber"],
          sourceSystem: "manual",
        },
      ],
    });

    expect(res.status).toBe(200);
  });
});
