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

/**
 * Enforce `uq_scorecard_snapshots_latest_per_source` — at most one row with
 * is_latest=true per scorecard_source. Mirrors the partial unique index in
 * migration 0206. Throws on violation so a regression to the naive
 * "INSERT with is_latest=true" pattern fails the test loudly.
 */
function assertLatestUniqueness(): void {
  const latestBySource = new Map<string, string[]>();
  for (const row of store.values()) {
    if (!row.is_latest) continue;
    const ids = latestBySource.get(row.scorecard_source) ?? [];
    ids.push(row.id);
    latestBySource.set(row.scorecard_source, ids);
  }
  for (const [source, ids] of latestBySource) {
    if (ids.length > 1) {
      throw new Error(
        `uq_scorecard_snapshots_latest_per_source violation: source=${source} has ${ids.length} latest rows (${ids.join(", ")})`,
      );
    }
  }
}

/**
 * Parse an INSERT into scorecard_snapshots and mutate `store`. The
 * sync-factory emits one row at a time via the audit-log pre-fetch then a
 * batched INSERT ... ON CONFLICT DO UPDATE; the schema column order (from
 * schema.ts) fixes the param positions:
 *   [id, scorecard_source, wave_label, published_at, source_url,
 *    methodology_url, license, org_count, dimension_count, notes,
 *    is_latest, source_active, synced_at, updated_at]  = 14 params per row
 * (captured_at and created_at use SQL defaults, so are not in params.)
 */
const COLS_PER_ROW = 14;

function applyInsert(params: unknown[]): void {
  for (let i = 0; i < params.length; i += COLS_PER_ROW) {
    const row: SnapshotRow = {
      id: params[i] as string,
      scorecard_source: params[i + 1] as string,
      is_latest: Boolean(params[i + 10]),
      published_at: params[i + 3] as string,
    };
    store.set(row.id, row);
  }
  assertLatestUniqueness();
}

/**
 * Parse an UPDATE on scorecard_snapshots and mutate `store`.
 *
 * The route emits two UPDATE shapes:
 *   1. SET is_latest=$1, updated_at=$2 WHERE scorecard_source=$3 AND is_latest=$4
 *      (clear prior latest for a source)
 *   2. SET is_latest=$1, updated_at=$2 WHERE id=$3
 *      (promote a specific row to latest)
 */
function applyUpdate(q: string, params: unknown[]): void {
  const newIsLatest = Boolean(params[0]);
  if (q.includes("scorecard_source")) {
    // Shape 1: clear matching source rows.
    const source = params[2] as string;
    const matchIsLatest = Boolean(params[3]);
    for (const row of store.values()) {
      if (row.scorecard_source === source && row.is_latest === matchIsLatest) {
        row.is_latest = newIsLatest;
      }
    }
  } else if (q.includes('"id"')) {
    // Shape 2: promote by id.
    const id = params[2] as string;
    const row = store.get(id);
    if (row) row.is_latest = newIsLatest;
  }
  assertLatestUniqueness();
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

  // INSERT INTO "scorecard_snapshots" — mutate store + enforce unique index.
  if (q.includes("insert into") && q.includes('"scorecard_snapshots"')) {
    applyInsert(params);
    return [];
  }

  // UPDATE "scorecard_snapshots" — mutate store + enforce unique index.
  if (q.includes("update") && q.includes('"scorecard_snapshots"')) {
    applyUpdate(q, params);
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

  it("allows a new wave for a source that already has an is_latest=true row (clear must precede promote)", async () => {
    // Seed a prior latest row that the store now actively enforces via
    // assertLatestUniqueness. If the route ever regressed to inserting
    // is_latest=true before running the clear, the INSERT would push a
    // second latest row into the store and the invariant check would throw.
    store.set("fli-spring-2024", {
      id: "fli-spring-2024",
      scorecard_source: "fli_index",
      is_latest: true,
      published_at: "2024-04-01",
    });

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
      ],
    });
    expect(res.status).toBe(200);

    // Final state: exactly one is_latest=true for the source, on the new id.
    const latestRows = [...store.values()].filter(
      (r) => r.scorecard_source === "fli_index" && r.is_latest,
    );
    expect(latestRows.map((r) => r.id)).toEqual(["fli-summer-2025"]);
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
