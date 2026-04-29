/**
 * Tests for the missing-sources endpoint.
 *
 * The endpoint queries 10 tables with complex JOINs and sql expressions.
 * Full integration testing is done via curl against the local dev DB.
 * These unit tests verify the route wiring and response shape using
 * a simplified mock that handles the facts table only.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { mockDbModule, postJson } from "./test-utils.js";

const ENTITIES = [
  { stable_id: "sid_abc", title: "Anthropic" },
  { stable_id: "sid_co", title: "Chris Olah" },
];

// Tracks UPDATE calls made to the mock, so the update-source tests can assert
// exactly which column was written and with what id/url.
const updateLog: Array<{ query: string; params: unknown[] }> = [];

// Tracks every SELECT issued by the missing-sources route so tests can
// assert the WHERE clause filters out unresolved/sid-leaked entity rows.
const selectLog: Array<{ query: string; params: unknown[] }> = [];

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase().trim();
  if (q.startsWith("select")) selectLog.push({ query: q, params });

  if (q.startsWith("update")) {
    updateLog.push({ query: q, params });
    // Return a single-row RETURNING so updateRows() reports 1.
    // Each UPDATE_BY_TABLE fn uses .returning({ id: ... }) so the row shape
    // doesn't matter beyond length.
    return [{ id: params[1] }];
  }

  // Count queries
  if (q.includes("count(")) {
    // Facts with NULL source (excluding website/description): 1 row
    if (q.includes('"facts"')) return [{ count: 1 }];
    return [{ count: 0 }];
  }

  // Facts data query — return a mock row with the expected column structure
  // Drizzle maps .select({ key: column }) to positional arrays via .values()
  // The mock returns objects which get mapped by createQueryResult
  if (q.includes('"facts"') && q.includes("limit")) {
    return [{
      record_id: "1",
      record_table: "facts",
      entity_id: "sid_abc",
      entity_name: "Anthropic",
      description: "Revenue = 1500000000",
      label: "Revenue",
      value: "1500000000",
      measure: "revenue",
      fact_id: "f1",
    }];
  }

  // Entity lookups for JOINs
  if (q.includes('"entities"')) return ENTITIES;

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

describe("GET /api/sourcing/missing-sources", () => {
  let app: InstanceType<typeof import("hono").Hono>;

  beforeAll(async () => {
    const { missingSourcesRoute } = await import(
      "../routes/sourcing/missing-sources/route.js"
    );
    const { Hono } = await import("hono");
    app = new Hono();
    app.route("/api/sourcing/missing-sources", missingSourcesRoute);
  });

  it("loads the route and returns 200", async () => {
    // Query just facts to avoid mock complexity for all 10 tables
    const res = await app.request("/api/sourcing/missing-sources?table=facts");
    expect(res.status).toBe(200);
  });

  it("returns facts with totals and records", async () => {
    const res = await app.request("/api/sourcing/missing-sources?table=facts");
    const body = await res.json();

    expect(body.totalMissing).toBe(1);
    expect(body.tables.facts).toBeDefined();
    expect(body.tables.facts.total).toBe(1);
    expect(body.tables.facts.records).toHaveLength(1);
  });

  it("facts records have the expected fields", async () => {
    const res = await app.request("/api/sourcing/missing-sources?table=facts");
    const body = await res.json();
    const record = body.tables.facts.records[0];

    expect(record.record_id).toBe("1");
    expect(record.record_table).toBe("facts");
    expect(record.entity_id).toBe("sid_abc");
    expect(record.entity_name).toBe("Anthropic");
    expect(record.description).toContain("Revenue");
    expect(record.label).toBe("Revenue");
    expect(record.fact_id).toBe("f1");
  });

  it("only returns the requested table when ?table= is set", async () => {
    const res = await app.request("/api/sourcing/missing-sources?table=facts");
    const body = await res.json();

    expect(body.tables.facts).toBeDefined();
    expect(body.tables.personnel).toBeUndefined();
    expect(body.tables.investments).toBeUndefined();
  });

  it("respects limit parameter", async () => {
    const res = await app.request("/api/sourcing/missing-sources?table=facts&limit=1");
    expect(res.status).toBe(200);
  });

  // Regression for QUA-764 (sid_* leak): every entity-joining query must
  // skip rows whose displayed entity name would be NULL/empty/sid_-prefixed.
  // Asserts the WHERE clause filters this at the SQL level so corrupt data
  // never reaches the backfill pipeline.
  it.each(["facts", "investments", "personnel", "equity_positions", "divisions", "funding_rounds", "funding_programs", "policy_stakeholders", "publications"])(
    "%s query filters out sid_-prefixed display names",
    async (table) => {
      selectLog.length = 0;
      const res = await app.request(`/api/sourcing/missing-sources?table=${table}`);
      expect(res.status).toBe(200);
      // Every SELECT against this table should embed the sid_* filter.
      const tableSelects = selectLog.filter((l) => l.query.includes(`"${table}"`));
      expect(tableSelects.length).toBeGreaterThan(0);
      for (const l of tableSelects) {
        expect(l.query).toContain("not like 'sid");
        expect(l.query).toContain("escape");
      }
    }
  );
});

describe("POST /api/sourcing/missing-sources/update-source", () => {
  let app: InstanceType<typeof import("hono").Hono>;

  beforeEach(async () => {
    updateLog.length = 0;
    const { missingSourcesRoute } = await import(
      "../routes/sourcing/missing-sources/route.js"
    );
    const { Hono } = await import("hono");
    app = new Hono();
    app.route("/api/sourcing/missing-sources", missingSourcesRoute);
  });

  it("rejects unknown table values", async () => {
    const res = await postJson(app, "/api/sourcing/missing-sources/update-source", {
      table: "nonsense",
      recordId: "1",
      url: "https://example.com/x",
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-URL url values", async () => {
    const res = await postJson(app, "/api/sourcing/missing-sources/update-source", {
      table: "personnel",
      recordId: "abc1234567",
      url: "not-a-url",
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-numeric recordId for facts", async () => {
    const res = await postJson(app, "/api/sourcing/missing-sources/update-source", {
      table: "facts",
      recordId: "not-a-number",
      url: "https://example.com/x",
    });
    expect(res.status).toBe(400);
    // No UPDATE should have been issued.
    expect(updateLog.filter((l) => l.query.includes('"facts"'))).toHaveLength(0);
  });

  it("facts UPDATE writes `source` column, not other fields", async () => {
    const res = await postJson(app, "/api/sourcing/missing-sources/update-source", {
      table: "facts",
      recordId: "42",
      url: "https://anthropic.com/revenue",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);

    const factsUpdate = updateLog.find((l) => l.query.includes('"facts"'));
    expect(factsUpdate).toBeDefined();
    expect(factsUpdate!.query).toContain('"source"');
    // Must NOT touch any of the 19 other fact columns
    expect(factsUpdate!.query).not.toContain('"label"');
    expect(factsUpdate!.query).not.toContain('"value"');
    expect(factsUpdate!.query).not.toContain('"numeric"');
    expect(factsUpdate!.query).not.toContain('"currency"');
    expect(factsUpdate!.query).not.toContain('"note"');
  });

  it("publications UPDATE writes `url` column, NOT `source`", async () => {
    // Regression for CRITICAL #3: publications has both url and source cols;
    // missing-sources filters on url, so we must write url back.
    const res = await postJson(app, "/api/sourcing/missing-sources/update-source", {
      table: "publications",
      recordId: "pub1234567",
      url: "https://arxiv.org/abs/2212.08073",
    });
    expect(res.status).toBe(200);

    const pubsUpdate = updateLog.find((l) => l.query.includes('"publications"'));
    expect(pubsUpdate).toBeDefined();
    expect(pubsUpdate!.query).toContain('"url"');
    // SET clause should not mention `source`
    const setClause = pubsUpdate!.query.split(" where ")[0];
    expect(setClause).not.toContain('"source"');
  });

  it("page_citations UPDATE writes `url` column", async () => {
    const res = await postJson(app, "/api/sourcing/missing-sources/update-source", {
      table: "page_citations",
      recordId: "99",
      url: "https://example.com/cite",
    });
    expect(res.status).toBe(200);

    const cit = updateLog.find((l) => l.query.includes('"page_citations"'));
    expect(cit).toBeDefined();
    expect(cit!.query).toContain('"url"');
  });

  it("divisions UPDATE writes only `source` (no required-field trip)", async () => {
    // Regression for CRITICAL #2: the old code POST'd to /sync which required
    // parentOrgId + name; sending {id, source} 400'd. The new endpoint
    // issues a direct UPDATE touching only `source`.
    const res = await postJson(app, "/api/sourcing/missing-sources/update-source", {
      table: "divisions",
      recordId: "div1234567",
      url: "https://example.com/div",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);

    const divUpdate = updateLog.find((l) => l.query.includes('"divisions"'));
    expect(divUpdate).toBeDefined();
    expect(divUpdate!.query).toContain('"source"');
    expect(divUpdate!.query).not.toContain('"parent_org_id"');
    expect(divUpdate!.query).not.toContain('"name"');
  });
});
