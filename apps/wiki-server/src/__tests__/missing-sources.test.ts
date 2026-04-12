/**
 * Tests for the missing-sources endpoint.
 *
 * The endpoint queries 10 tables with complex JOINs and sql expressions.
 * Full integration testing is done via curl against the local dev DB.
 * These unit tests verify the route wiring and response shape using
 * a simplified mock that handles the facts table only.
 */
import { describe, it, expect, vi } from "vitest";
import { mockDbModule } from "./test-utils.js";

const ENTITIES = [
  { stable_id: "sid_abc", title: "Anthropic" },
  { stable_id: "sid_co", title: "Chris Olah" },
];

function dispatch(query: string, _params: unknown[]): unknown[] {
  const q = query.toLowerCase().trim();

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

  it("loads the route and returns 200", async () => {
    const { missingSourcesRoute } = await import(
      "../routes/sourcing/missing-sources.js"
    );
    const { Hono } = await import("hono");
    app = new Hono();
    app.route("/api/sourcing/missing-sources", missingSourcesRoute);

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
});
