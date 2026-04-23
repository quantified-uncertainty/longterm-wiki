import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule } from "./test-utils.js";

// QUA-622: publications GET /all and GET /by-entity/:entityId used to apply
// publicationType/flagshipOnly filters in post-query JS after .limit(), which
// meant `limit=100&flagshipOnly=true` could return 0 rows from a page of 100
// non-flagship publications, and `total` was the unfiltered count. The fix
// pushes both filters into the SQL WHERE clause and applies the same clause to
// the count query.
//
// These tests assert two things:
//   1. Filters appear in the dispatched SQL WHERE clause (not in JS).
//   2. The rows and total returned by the endpoint reflect the filter.

// ---- In-memory store ----

interface PubRow {
  id: string;
  entity_id: string;
  entity_display_name: string | null;
  resource_id: string | null;
  title: string;
  authors: string | null;
  url: string | null;
  venue: string | null;
  published_date: string | null;
  publication_type: string;
  citation_count: number | null;
  is_flagship: boolean;
  abstract: string | null;
  source: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

let publicationsStore: PubRow[];
let dispatchedQueries: Array<{ query: string; params: unknown[] }>;

function resetStores() {
  publicationsStore = [];
  dispatchedQueries = [];
}

function makePub(overrides: Partial<PubRow>): PubRow {
  const now = new Date();
  return {
    id: "a".repeat(10),
    entity_id: "sid_testentity",
    entity_display_name: null,
    resource_id: null,
    title: "Untitled",
    authors: null,
    url: null,
    venue: null,
    published_date: "2024-01",
    publication_type: "paper",
    citation_count: null,
    is_flagship: false,
    abstract: null,
    source: null,
    notes: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** Apply Drizzle-dispatched WHERE filters to the in-memory store using captured params. */
function applyFilters(query: string, params: unknown[]): PubRow[] {
  const q = query.toLowerCase();
  // Pick off known WHERE predicates in the order Drizzle emits them. The fix
  // adds predicates in this order: entity_id (if /by-entity), publication_type,
  // is_flagship. The test only needs to handle these three.
  let rows = [...publicationsStore];
  let i = 0;
  if (q.includes('"publications"."entity_id" =')) {
    rows = rows.filter((r) => r.entity_id === params[i]);
    i++;
  }
  if (q.includes('"publications"."publication_type" =')) {
    rows = rows.filter((r) => r.publication_type === params[i]);
    i++;
  }
  if (q.includes('"publications"."is_flagship" =')) {
    rows = rows.filter((r) => r.is_flagship === params[i]);
    i++;
  }
  return rows;
}

/**
 * Extract the (limit, offset) pair from a row SELECT query. Drizzle elides
 * `.offset(0)` (the default) so the OFFSET placeholder may be absent even when
 * the route called `.offset(...)`. Limit is always emitted when the route
 * called `.limit(...)`.
 */
function extractLimitOffset(
  query: string,
  params: unknown[],
): { limit: number; offset: number } {
  const q = query.toLowerCase();
  const hasOffset = / offset \$\d+/.test(q);
  if (hasOffset) {
    return {
      limit: params[params.length - 2] as number,
      offset: params[params.length - 1] as number,
    };
  }
  return { limit: params[params.length - 1] as number, offset: 0 };
}

function dispatch(query: string, params: unknown[]): unknown[] {
  dispatchedQueries.push({ query, params: [...params] });
  const q = query.toLowerCase();

  // resolveEntityStableId lookup: SELECT stable_id FROM entities WHERE id = ? LIMIT 1
  // For the test we assume entityId is always a sid_, so this never fires.

  // count query: SELECT count(*) FROM "publications" [WHERE ...]
  if (q.startsWith("select") && q.includes("count(") && q.includes('"publications"')) {
    const filtered = applyFilters(query, params);
    return [{ count: filtered.length }];
  }

  // row query: SELECT ... FROM "publications" [WHERE ...] ORDER BY ... LIMIT ? [OFFSET ?]
  if (q.startsWith("select") && q.includes('from "publications"')) {
    const filtered = applyFilters(query, params);
    const { limit, offset } = extractLimitOffset(query, params);
    return filtered.slice(offset, offset + limit);
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

/** Drizzle returns publications with camelCase property names (mapped from snake_case schema). */
interface DrizzlePubRow {
  id: string;
  entityId: string;
  publicationType: string;
  isFlagship: boolean;
}

describe("publications GET /all — filters are applied in SQL (QUA-622)", () => {
  beforeEach(async () => {
    resetStores();
    vi.resetModules();
  });

  it("pushes flagshipOnly into WHERE so rows and total reflect the filter", async () => {
    // Seed 5 non-flagship + 2 flagship rows. Page size 100 returns them all
    // post-filter → 2 rows, total=2. Pre-fix behaviour fetched 100 unfiltered
    // rows, JS-filtered to 2, but returned total=7 (the unfiltered count).
    for (let i = 0; i < 5; i++) {
      publicationsStore.push(makePub({ id: `nonflagsh${i}`, is_flagship: false }));
    }
    for (let i = 0; i < 2; i++) {
      publicationsStore.push(makePub({ id: `flagship-${i}`, is_flagship: true }));
    }

    const { publicationsRoute } = await import(
      "../routes/tablebase/publications.js"
    );
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request("/api/publications/all?flagshipOnly=true&limit=100");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publications: DrizzlePubRow[];
      total: number;
    };
    expect(body.publications).toHaveLength(2);
    expect(body.publications.every((r) => r.isFlagship)).toBe(true);
    expect(body.total).toBe(2);

    // Assert the SQL actually carried is_flagship in WHERE (both the row
    // query and the count query), which is the structural bug fix.
    const rowQuery = dispatchedQueries.find(
      (d) => d.query.toLowerCase().includes('from "publications"')
        && !d.query.toLowerCase().includes("count("),
    );
    const countQuery = dispatchedQueries.find(
      (d) => d.query.toLowerCase().includes("count(")
        && d.query.toLowerCase().includes('"publications"'),
    );
    expect(rowQuery?.query.toLowerCase()).toMatch(/where[\s\S]*is_flagship/);
    expect(countQuery?.query.toLowerCase()).toMatch(/where[\s\S]*is_flagship/);
  });

  it("pushes publicationType into WHERE", async () => {
    publicationsStore.push(makePub({ id: "paper1", publication_type: "paper" }));
    publicationsStore.push(makePub({ id: "report1", publication_type: "report" }));
    publicationsStore.push(makePub({ id: "paper2", publication_type: "paper" }));

    const { publicationsRoute } = await import(
      "../routes/tablebase/publications.js"
    );
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request("/api/publications/all?publicationType=paper");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publications: DrizzlePubRow[];
      total: number;
    };
    expect(body.publications.map((r) => r.publicationType)).toEqual(["paper", "paper"]);
    expect(body.total).toBe(2);
  });

  it("truncates by limit AFTER filtering (core QUA-622 regression)", async () => {
    // Seed 50 non-flagship + 5 flagship rows. With ?flagshipOnly=true&limit=3
    // the filtered set is 5, truncated to 3. Pre-fix behaviour: fetched first
    // 3 rows by date (likely 0 flagship), JS-filtered to 0, returned total=55.
    for (let i = 0; i < 50; i++) {
      publicationsStore.push(
        makePub({ id: `nonflagsh${i}`, is_flagship: false }),
      );
    }
    for (let i = 0; i < 5; i++) {
      publicationsStore.push(
        makePub({ id: `flagship-${i}`, is_flagship: true }),
      );
    }

    const { publicationsRoute } = await import(
      "../routes/tablebase/publications.js"
    );
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request(
      "/api/publications/all?flagshipOnly=true&limit=3",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publications: DrizzlePubRow[];
      total: number;
    };
    expect(body.publications).toHaveLength(3);
    expect(body.publications.every((r) => r.isFlagship)).toBe(true);
    // total is the filtered count, not the table total.
    expect(body.total).toBe(5);
  });

  it("combines publicationType and flagshipOnly in a single WHERE", async () => {
    publicationsStore.push(
      makePub({ id: "paper-nf", publication_type: "paper", is_flagship: false }),
    );
    publicationsStore.push(
      makePub({ id: "paper-fl", publication_type: "paper", is_flagship: true }),
    );
    publicationsStore.push(
      makePub({ id: "report-fl", publication_type: "report", is_flagship: true }),
    );

    const { publicationsRoute } = await import(
      "../routes/tablebase/publications.js"
    );
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request(
      "/api/publications/all?publicationType=paper&flagshipOnly=true",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publications: DrizzlePubRow[];
      total: number;
    };
    expect(body.publications.map((r) => r.id)).toEqual(["paper-fl"]);
    expect(body.total).toBe(1);
  });

  it("flagshipOnly=false returns all publications (QUA-651 regression)", async () => {
    // Before QUA-651: the schema used `z.coerce.boolean()`, which coerces the
    // literal string "false" to true. So ?flagshipOnly=false silently
    // filtered to flagship-only — the opposite of what the caller typed.
    // With qBool this is now a hard false and all rows should come through.
    for (let i = 0; i < 3; i++) {
      publicationsStore.push(
        makePub({ id: `nonflagsh${i}`, is_flagship: false }),
      );
    }
    for (let i = 0; i < 2; i++) {
      publicationsStore.push(
        makePub({ id: `flagship-${i}`, is_flagship: true }),
      );
    }

    const { publicationsRoute } = await import(
      "../routes/tablebase/publications.js"
    );
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request(
      "/api/publications/all?flagshipOnly=false&limit=100",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publications: DrizzlePubRow[];
      total: number;
    };
    expect(body.publications).toHaveLength(5);
    expect(body.total).toBe(5);

    // Double-check: the route skipped the is_flagship WHERE predicate entirely
    // (flagshipOnly=false means "no filter"), matching the `if (flagshipOnly)`
    // gate in publications.ts. Pre-fix it would have emitted is_flagship=true.
    const countQuery = dispatchedQueries.find(
      (d) => d.query.toLowerCase().includes("count(")
        && d.query.toLowerCase().includes('"publications"'),
    );
    expect(countQuery?.query.toLowerCase()).not.toMatch(/is_flagship/);
  });

  it("rejects flagshipOnly=FALSE (case-sensitive) with a 400 (QUA-651)", async () => {
    const { publicationsRoute } = await import(
      "../routes/tablebase/publications.js"
    );
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request(
      "/api/publications/all?flagshipOnly=FALSE",
    );
    expect(res.status).toBe(400);
  });

  it("rejects flagshipOnly=1 with a 400 (QUA-651)", async () => {
    const { publicationsRoute } = await import(
      "../routes/tablebase/publications.js"
    );
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request(
      "/api/publications/all?flagshipOnly=1",
    );
    expect(res.status).toBe(400);
  });

  it("passes no WHERE (filter columns absent) when no filters are supplied", async () => {
    publicationsStore.push(makePub({ id: "p1" }));
    publicationsStore.push(makePub({ id: "p2", is_flagship: true }));

    const { publicationsRoute } = await import(
      "../routes/tablebase/publications.js"
    );
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request("/api/publications/all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(2);

    const countQuery = dispatchedQueries.find(
      (d) => d.query.toLowerCase().includes("count(")
        && d.query.toLowerCase().includes('"publications"'),
    );
    expect(countQuery?.query.toLowerCase()).not.toMatch(/is_flagship|publication_type/);
  });
});

describe("publications GET /by-entity/:entityId — filters apply after entityId (QUA-622)", () => {
  beforeEach(async () => {
    resetStores();
    vi.resetModules();
  });

  it("returns all publications for an entity when no filters supplied", async () => {
    publicationsStore.push(
      makePub({ id: "other-ent", entity_id: "sid_otherentity" }),
    );
    publicationsStore.push(
      makePub({ id: "target1", entity_id: "sid_targetentity" }),
    );
    publicationsStore.push(
      makePub({ id: "target2", entity_id: "sid_targetentity" }),
    );

    const { publicationsRoute } = await import(
      "../routes/tablebase/publications.js"
    );
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request(
      "/api/publications/by-entity/sid_targetentity",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publications: DrizzlePubRow[];
      total: number;
    };
    expect(body.publications.map((r) => r.id).sort()).toEqual([
      "target1",
      "target2",
    ]);
    expect(body.total).toBe(2);
  });

  it("combines entity_id with publicationType", async () => {
    publicationsStore.push(
      makePub({ id: "target-paper", entity_id: "sid_targetentity", publication_type: "paper" }),
    );
    publicationsStore.push(
      makePub({ id: "target-report", entity_id: "sid_targetentity", publication_type: "report" }),
    );

    const { publicationsRoute } = await import(
      "../routes/tablebase/publications.js"
    );
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request(
      "/api/publications/by-entity/sid_targetentity?publicationType=paper",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publications: DrizzlePubRow[];
      total: number;
    };
    expect(body.publications.map((r) => r.id)).toEqual(["target-paper"]);
    expect(body.total).toBe(1);
  });

  it("combines entity_id with flagshipOnly in a single WHERE", async () => {
    publicationsStore.push(
      makePub({ id: "other-ent", entity_id: "sid_otherentity", is_flagship: true }),
    );
    publicationsStore.push(
      makePub({ id: "target1", entity_id: "sid_targetentity", is_flagship: false }),
    );
    publicationsStore.push(
      makePub({ id: "target2", entity_id: "sid_targetentity", is_flagship: true }),
    );

    const { publicationsRoute } = await import(
      "../routes/tablebase/publications.js"
    );
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request(
      "/api/publications/by-entity/sid_targetentity?flagshipOnly=true",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entityId: string;
      publications: DrizzlePubRow[];
      total: number;
    };
    expect(body.entityId).toBe("sid_targetentity");
    expect(body.publications.map((r) => r.id)).toEqual(["target2"]);
    expect(body.total).toBe(1);
  });
});
