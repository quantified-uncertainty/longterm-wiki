import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule } from "./test-utils.js";

// QUA-1040 — /bulk endpoints. End-to-end tests against a representative
// route (publications) to verify:
//   1. /bulk returns { <key>: rows, total } shape.
//   2. /bulk's row query carries NO LIMIT/OFFSET clause (the structural
//      property we just added — pagination is the wrong shape for the build-data
//      caller).
//   3. /bulk does NOT issue a separate COUNT(*) query.
//   4. Empty tables return rows: [], total: 0 cleanly.
//
// These are the regression contracts the rest of the build-data system
// depends on. If a future refactor reintroduces pagination behind /bulk,
// these tests fail loudly.

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

function dispatch(query: string, params: unknown[]): unknown[] {
  dispatchedQueries.push({ query, params: [...params] });
  const q = query.toLowerCase();

  if (q.startsWith("select") && q.includes("count(") && q.includes('"publications"')) {
    return [{ count: publicationsStore.length }];
  }

  if (q.startsWith("select") && q.includes('from "publications"')) {
    return [...publicationsStore];
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

interface DrizzlePubRow {
  id: string;
  entityId: string;
  publicationType: string;
}

describe("publications GET /bulk (QUA-1040)", () => {
  beforeEach(async () => {
    resetStores();
    vi.resetModules();
  });

  it("returns { publications: [...], total } shape", async () => {
    for (let i = 0; i < 10; i++) {
      publicationsStore.push(makePub({ id: `pub${i}` }));
    }

    const { publicationsRoute } = await import("../routes/tablebase/publications.js");
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request("/api/publications/bulk");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publications: DrizzlePubRow[];
      total: number;
    };
    expect(body.publications).toHaveLength(10);
    expect(body.total).toBe(10);
    // No "limit" / "offset" leaked into the response — those are paginated-route fields.
    expect(body).not.toHaveProperty("limit");
    expect(body).not.toHaveProperty("offset");
  });

  it("does NOT add LIMIT or OFFSET to the row query (the QUA-1040 structural fix)", async () => {
    publicationsStore.push(makePub({ id: "p1" }));
    publicationsStore.push(makePub({ id: "p2" }));

    const { publicationsRoute } = await import("../routes/tablebase/publications.js");
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request("/api/publications/bulk");
    expect(res.status).toBe(200);

    // Find the row query (SELECT ... FROM "publications" with no count())
    const rowQuery = dispatchedQueries.find(
      (d) =>
        d.query.toLowerCase().includes('from "publications"') &&
        !d.query.toLowerCase().includes("count("),
    );
    expect(rowQuery, "expected a row SELECT query against publications").toBeDefined();
    // Pagination is the wrong shape for /bulk — explicitly assert there's
    // no LIMIT/OFFSET. If a future change re-adds pagination, this fails loudly.
    expect(rowQuery!.query.toLowerCase()).not.toMatch(/\blimit\s+\$/);
    expect(rowQuery!.query.toLowerCase()).not.toMatch(/\boffset\s+\$/);
  });

  it("does NOT issue a separate COUNT(*) query (total comes from rows.length)", async () => {
    publicationsStore.push(makePub({ id: "p1" }));
    publicationsStore.push(makePub({ id: "p2" }));

    const { publicationsRoute } = await import("../routes/tablebase/publications.js");
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request("/api/publications/bulk");
    expect(res.status).toBe(200);

    const countQueries = dispatchedQueries.filter(
      (d) =>
        d.query.toLowerCase().includes("count(") &&
        d.query.toLowerCase().includes('"publications"'),
    );
    // /bulk should not issue a separate COUNT — `rows.length` is authoritative.
    expect(countQueries).toHaveLength(0);
  });

  it("returns empty result cleanly when the table is empty", async () => {
    const { publicationsRoute } = await import("../routes/tablebase/publications.js");
    const app = new Hono().route("/api/publications", publicationsRoute);

    const res = await app.request("/api/publications/bulk");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publications: DrizzlePubRow[];
      total: number;
    };
    expect(body.publications).toEqual([]);
    expect(body.total).toBe(0);
  });
});
