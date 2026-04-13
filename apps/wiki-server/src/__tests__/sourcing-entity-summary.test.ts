import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { type SqlDispatcher, mockDbModule } from "./test-utils";

// Capture every SQL query the route dispatches so we can assert on its shape.
let capturedQueries: string[] = [];

const dispatch: SqlDispatcher = (query, _params) => {
  capturedQueries.push(query);
  // Entity-summary returns a list of rows; an empty array is a valid response.
  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

describe("GET /api/sourcing/entity-summary", () => {
  let app: Hono;

  beforeEach(() => {
    capturedQueries = [];
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("returns 200 with an empty summaries array when no rows exist", async () => {
    const res = await app.request("/api/sourcing/entity-summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summaries: unknown[] };
    expect(body).toEqual({ summaries: [] });
  });

  it("dispatches a syntactically valid CTE query (regression for QUA-327)", async () => {
    // QUA-327: the entity-summary handler had a SQL syntax error — a missing
    // comma between the `record_counts` and `all_entities` CTEs caused the
    // endpoint to 500 with a Postgres syntax error. Guard against the exact
    // pattern coming back.
    await app.request("/api/sourcing/entity-summary");

    const cteQueries = capturedQueries.filter(
      (q) => q.includes("verdict_counts") && q.includes("all_entities"),
    );
    expect(cteQueries.length).toBeGreaterThan(0);

    for (const q of cteQueries) {
      // The fix: the closing `)` of `record_counts` MUST be followed by a
      // comma before `all_entities AS (`, not directly by `all_entities`.
      expect(
        /\)\s+all_entities\s+AS\s*\(/i.test(q),
        `entity-summary query has a missing-comma bug between CTEs:\n${q}`,
      ).toBe(false);
      expect(
        /\)\s*,\s*all_entities\s+AS\s*\(/i.test(q),
        `entity-summary query is missing the comma before all_entities CTE:\n${q}`,
      ).toBe(true);
    }
  });
});
