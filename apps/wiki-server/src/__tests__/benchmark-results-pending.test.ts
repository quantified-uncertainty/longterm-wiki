/**
 * Tests for the benchmark_results_pending (quarantine) sync handler.
 *
 * QUA-689 — Phase 2 of the AI safety data layer.
 *
 * Locks in two route-specific behaviors:
 *   1. preValidate rejects unknown benchmarkIds with a clear error so
 *      ingesters can fix references before the quarantine row is written.
 *   2. Slug benchmarkId is auto-resolved to the 10-char ID — same shape
 *      as benchmark-results.ts so the two ingest pipelines stay aligned.
 *
 * Audit log + FK + factory machinery is covered by sync-factory.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

interface SqlEntry {
  q: string;
  params: unknown[];
}
const sqlLog: SqlEntry[] = [];

// Pretend benchmarks "mmlu" (slug) → "bench-mmlu1" (id) exists in prod.
const KNOWN_BENCHMARK_ROW = { id: "bench-mmlu1", slug: "mmlu" };

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();
  sqlLog.push({ q, params });

  // The preValidate hook does a SELECT id, slug FROM benchmarks WHERE id IN
  // (...) OR slug IN (...). Return the known row only when its identifiers
  // appear in the params list.
  if (
    q.includes("select") &&
    q.includes("from benchmarks") &&
    (q.includes("id in") || q.includes("slug in"))
  ) {
    const wanted = params.map((p) => String(p));
    if (
      wanted.includes(KNOWN_BENCHMARK_ROW.id) ||
      wanted.includes(KNOWN_BENCHMARK_ROW.slug)
    ) {
      return [KNOWN_BENCHMARK_ROW];
    }
    return [];
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { benchmarkResultsPendingRoute } = await import(
  "../routes/tablebase/benchmark-results-pending.js"
);

function buildApp(): Hono {
  const app = new Hono();
  app.route("/", benchmarkResultsPendingRoute);
  return app;
}

describe("benchmark_results_pending /sync", () => {
  beforeEach(() => {
    sqlLog.length = 0;
  });

  it("accepts a known benchmark slug and inserts the quarantine row", async () => {
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "brp_quarantine_1",
          benchmarkId: "mmlu", // slug — should resolve to bench-mmlu1
          rawModelName: "Claude 3.5 Sonnet (new)",
          score: 0.873,
          testedBy: "leaderboard",
          ingesterSource: "helm-safety",
          status: "pending",
        },
      ],
    });
    expect(res.status).toBe(200);

    const insertCount = sqlLog.filter(
      ({ q }) =>
        q.includes("insert into") &&
        q.includes('"benchmark_results_pending"'),
    ).length;
    expect(insertCount).toBeGreaterThan(0);
  });

  it("rejects an unknown benchmarkId with a descriptive message", async () => {
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "brp_quarantine_2",
          benchmarkId: "no-such-benchmark",
          rawModelName: "Some Model",
          ingesterSource: "fortress",
        },
      ],
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error?: string; message?: string };
    const errMessage = body.message ?? body.error ?? "";
    expect(errMessage).toMatch(/no-such-benchmark/);
    expect(errMessage.toLowerCase()).toMatch(/benchmark/);
  });

  it("rejects an invalid status value", async () => {
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "brp_quarantine_3",
          benchmarkId: "mmlu",
          rawModelName: "Some Model",
          ingesterSource: "fortress",
          status: "approved", // not in [pending, resolved, rejected]
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid testedBy value", async () => {
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "brp_quarantine_4",
          benchmarkId: "mmlu",
          rawModelName: "Some Model",
          testedBy: "guesswork", // not in the enum
          ingesterSource: "fortress",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects intra-batch duplicates on (ingesterSource, benchmarkId, lower(rawModelName), evaluationDate)", async () => {
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "brp_dup_1",
          benchmarkId: "mmlu",
          rawModelName: "Claude 3.5 Sonnet",
          ingesterSource: "fortress",
          evaluationDate: "2025-09-01",
        },
        {
          id: "brp_dup_2",
          benchmarkId: "mmlu",
          // Same source + benchmark + lowercased name + date — should collide.
          rawModelName: "claude 3.5 sonnet",
          ingesterSource: "fortress",
          evaluationDate: "2025-09-01",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects intra-batch duplicates AFTER slug resolution (post-resolution dedup)", async () => {
    // The factory's naturalKey runs BEFORE preValidate, so without the
    // post-resolution dedup added by QUA-689 the two items below would
    // pass intra-batch dedup (different `benchmarkId` values: "mmlu"
    // vs "bench-mmlu1") and only collide on PG's uq_brp_natural_key
    // with a confusing SQL-level duplicate-key error instead of a
    // clean 400. This test locks in the cleaner behavior.
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "brp_postdup_1",
          benchmarkId: "mmlu", // slug — preValidate rewrites to bench-mmlu1
          rawModelName: "Claude 3.5 Sonnet",
          ingesterSource: "helm-safety",
          evaluationDate: "2025-10-01",
        },
        {
          id: "brp_postdup_2",
          benchmarkId: "bench-mmlu1", // already canonical
          rawModelName: "Claude 3.5 Sonnet",
          ingesterSource: "helm-safety",
          evaluationDate: "2025-10-01",
        },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; message?: string };
    const errMessage = body.message ?? body.error ?? "";
    expect(errMessage.toLowerCase()).toMatch(/post slug-resolution|duplicate/);
  });
});
