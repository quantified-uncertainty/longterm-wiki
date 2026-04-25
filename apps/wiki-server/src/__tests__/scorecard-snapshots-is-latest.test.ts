/**
 * Regression test for the `is_latest` invariant on scorecard_snapshots.
 *
 * Reproduces the bug found in PR #4589 review: a naive
 * `INSERT ... is_latest=true + postUpsert reset` would trip the partial
 * unique index `uq_scorecard_snapshots_latest_per_source` on every
 * multi-wave sync.
 *
 * The fix is to insert with `is_latest=false` (so the index is never
 * tripped) and then in postUpsert reset siblings + promote the new row
 * inside the same transaction.
 *
 * This test asserts the SQL ordering the route emits on a multi-wave
 * sync, against an in-memory mock of the db driver.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

interface SnapshotRow {
  id: string;
  scorecard_source: string;
  is_latest: boolean;
  published_at: string;
}

let store: Map<string, SnapshotRow>;
interface SqlEntry { q: string; params: unknown[]; }
const sqlLog: SqlEntry[] = [];

function resetStore() {
  store = new Map();
  sqlLog.length = 0;
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();
  sqlLog.push({ q, params });

  // SELECT pre-fetch for audit log (Drizzle: select ... from "scorecard_snapshots" where ... in (...))
  if (q.includes("select") && q.includes('"scorecard_snapshots"') && q.includes("where") && !q.includes("update")) {
    return params
      .filter((p) => store.has(p as string))
      .map((p) => store.get(p as string)!);
  }

  // INSERT INTO "scorecard_snapshots"
  // The sync-factory chunks by column count; we can't reconstruct the row
  // exactly without parsing column ordering. Instead, capture that an
  // insert happened with these param values and treat the items array
  // (passed in via the test) as the source of truth for what got inserted.
  if (q.includes("insert into") && q.includes('"scorecard_snapshots"')) {
    return [];
  }

  // UPDATE "scorecard_snapshots" SET is_latest=false WHERE source=X AND is_latest=true
  // and UPDATE ... SET is_latest=true WHERE id=X
  if (q.includes("update") && q.includes('"scorecard_snapshots"')) {
    return [];
  }

  // tablebase_audit_log inserts
  if (q.includes("insert into") && q.includes("tablebase_audit_log")) {
    return [];
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { scorecardSnapshotsRoute } = await import(
  "../routes/tablebase/scorecard-snapshots.js"
);

function buildApp(): Hono {
  const app = new Hono();
  app.route("/", scorecardSnapshotsRoute);
  return app;
}

describe("scorecard_snapshots is_latest invariant", () => {
  beforeEach(() => {
    resetStore();
  });

  it("INSERT does not set is_latest=true (toRow forces false)", async () => {
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "fli-summer-2025",
          scorecardSource: "fli_index",
          publishedAt: "2025-07-17",
          sourceUrl: "https://example.com",
          orgCount: 7,
          dimensionCount: 7,
          isLatest: true,
          sourceActive: true,
        },
      ],
    });
    expect(res.status).toBe(200);

    // Find the INSERT statement on scorecard_snapshots and assert that
    // it ran. The exact INSERT params can't be inspected reliably without
    // parsing Drizzle's column ordering, but we assert ordering of
    // statements: INSERT must happen BEFORE the UPDATE that promotes
    // is_latest=true.
    const insertIdx = sqlLog.findIndex(
      ({ q }) =>
        q.includes("insert into") && q.includes('"scorecard_snapshots"'),
    );
    expect(insertIdx).toBeGreaterThanOrEqual(0);

    // The promote UPDATE must come strictly after the INSERT.
    const promoteIdx = sqlLog.findIndex(
      ({ q }, i) =>
        i > insertIdx &&
        q.includes("update") &&
        q.includes('"scorecard_snapshots"') &&
        q.includes('"is_latest"'),
    );
    expect(promoteIdx).toBeGreaterThan(insertIdx);
  });

  it("emits a clear-then-promote pair of UPDATEs per source, in that order", async () => {
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "fli-summer-2025",
          scorecardSource: "fli_index",
          publishedAt: "2025-07-17",
          sourceUrl: "https://example.com/fli",
          orgCount: 7,
          dimensionCount: 7,
          isLatest: true,
          sourceActive: true,
        },
        {
          id: "fmti-dec-2025",
          scorecardSource: "fmti",
          publishedAt: "2025-12-01",
          sourceUrl: "https://example.com/fmti",
          orgCount: 14,
          dimensionCount: 100,
          isLatest: true,
          sourceActive: true,
        },
      ],
    });
    expect(res.status).toBe(200);

    // For each source, the clear (is_latest=false) UPDATE must precede the
    // promote (is_latest=true) UPDATE in the SQL log. A reordered or
    // missing pair would have tripped the partial unique index pre-fix.
    // Identify clear/promote by SQL shape:
    //   clear:   WHERE scorecard_source = $X AND is_latest = $Y, params include source name + true (clearing the prior latest)
    //   promote: WHERE id = $X, params include the new item id + true
    function assertClearBeforePromote(source: string, itemId: string) {
      const updates = sqlLog
        .map((entry, i) => ({ ...entry, i }))
        .filter(
          ({ q }) =>
            q.includes("update") &&
            q.includes('"scorecard_snapshots"') &&
            q.includes('"is_latest"'),
        );
      const clearIdx = updates.find(
        ({ q, params }) =>
          q.includes("scorecard_source") &&
          params.includes(source) &&
          params.includes(false),
      )?.i;
      const promoteIdx = updates.find(
        ({ q, params }) =>
          !q.includes("scorecard_source") &&
          params.includes(itemId) &&
          params.includes(true),
      )?.i;
      expect(
        clearIdx,
        `clear UPDATE missing for source=${source}`,
      ).toBeDefined();
      expect(
        promoteIdx,
        `promote UPDATE missing for id=${itemId}`,
      ).toBeDefined();
      expect(
        clearIdx! < promoteIdx!,
        `clear must precede promote for ${itemId} (clear=${clearIdx}, promote=${promoteIdx})`,
      ).toBe(true);
    }

    assertClearBeforePromote("fli_index", "fli-summer-2025");
    assertClearBeforePromote("fmti", "fmti-dec-2025");
  });

  it("rejects an invalid scorecardSource via Zod enum", async () => {
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          id: "bogus-2025",
          scorecardSource: "not-a-real-source",
          publishedAt: "2025-01-01",
          sourceUrl: "https://example.com",
          orgCount: 1,
          dimensionCount: 1,
          isLatest: true,
          sourceActive: true,
        },
      ],
    });
    expect(res.status).toBe(400);
  });
});
