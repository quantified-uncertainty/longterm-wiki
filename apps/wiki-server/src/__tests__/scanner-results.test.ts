/**
 * Tests for the scanner-results route.
 *
 * Validates:
 *   1. POST /sync inserts items and returns count
 *   2. Schema validation rejects invalid payloads
 *   3. Empty batch rejected (min 1 item)
 *   4. POST /run triggers server-side scan and persists results
 *   5. GET /latest returns empty when no data
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory store ----

let insertedRows: Record<string, unknown>[];
/** Known entity IDs — validateEntityRefs checks these exist */
let knownEntityIds: Set<string>;

function resetStores() {
  insertedRows = [];
  // Pre-populate with the entity IDs used in test fixtures
  knownEntityIds = new Set(["sid_abc1234567", "sid_def7654321"]);
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // validateEntityRefs: unnest + entities check
  if (q.includes("unnest") && q.includes("from entities")) {
    return params
      .filter((p) => knownEntityIds.has(p as string))
      .map((p) => ({ ref: p }));
  }

  // INSERT
  if (q.includes("insert into")) {
    insertedRows.push({ query: q, params });
    return [];
  }

  // SELECT count
  if (q.includes("count(")) {
    return [{ count: insertedRows.length }];
  }

  // Entity queries for the /run endpoint
  // organizations query
  if (q.includes('"entities"') && q.includes("organization")) {
    return [
      { stable_id: "sid_org001", title: "TestOrg", entity_type: "organization" },
    ];
  }

  // ai-model entities
  if (q.includes('"entities"') && q.includes("ai-model")) {
    return [
      { stable_id: "sid_model001", title: "TestModel", entity_type: "ai-model" },
    ];
  }

  // Grants grouped by org
  if (q.includes('"grants"')) {
    return [
      { entity_id: "sid_org001", entity_name: "TestOrg", total: "3", linked: "2" },
    ];
  }

  // Personnel grouped by org
  if (q.includes('"personnel"')) {
    return [
      { entity_id: "sid_org001", entity_name: "TestOrg", total: "10" },
    ];
  }

  // Funding rounds
  if (q.includes('"funding_rounds"')) {
    return [];
  }

  // Investments
  if (q.includes('"investments"')) {
    return [];
  }

  // Benchmark results
  if (q.includes('"benchmark_results"')) {
    return [
      { entity_id: "sid_model001", entity_name: "TestModel", total: "5" },
    ];
  }

  // Source check verdicts
  if (q.includes('"source_check_verdicts"')) {
    return [];
  }

  // SELECT for latest (generic select from tablebase_scanner_results)
  if (q.includes("select") && q.includes("from")) {
    return [];
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { scannerResultsRoute } = await import(
  "../routes/tablebase/scanner-results.js"
);

function buildApp() {
  return new Hono().route("/api/scanner-results", scannerResultsRoute);
}

describe("scanner-results route", () => {
  beforeEach(() => {
    resetStores();
  });

  it("POST /sync inserts valid items and returns upserted count", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/scanner-results/sync", {
      items: [
        {
          scanRunId: "test-run-001",
          recordType: "personnel",
          entityId: "sid_abc1234567",
          entityName: "Anthropic",
          entityType: "organization",
          totalRecords: 15,
          verifiedRecords: 11,
          completenessPct: 73.3,
          missingFields: ["deeper coverage needed"],
          entityImportance: 85.5,
        },
        {
          scanRunId: "test-run-001",
          recordType: "grants",
          entityId: "sid_def7654321",
          entityName: "OpenAI",
          entityType: "organization",
          totalRecords: 0,
          verifiedRecords: 0,
          completenessPct: 0,
          missingFields: ["no grant records"],
          entityImportance: null,
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toBe(2);
  });

  it("POST /sync rejects empty items array", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/scanner-results/sync", {
      items: [],
    });

    expect(res.status).toBe(400);
  });

  it("POST /sync rejects missing required fields", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/scanner-results/sync", {
      items: [
        {
          scanRunId: "test-run-001",
          // missing recordType, entityId, etc.
        },
      ],
    });

    expect(res.status).toBe(400);
  });

  it("POST /sync rejects completenessPct out of range", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/scanner-results/sync", {
      items: [
        {
          scanRunId: "test-run-001",
          recordType: "personnel",
          entityId: "sid_abc1234567",
          entityName: "Test",
          entityType: "organization",
          totalRecords: 10,
          verifiedRecords: 5,
          completenessPct: 150, // out of range
          missingFields: [],
        },
      ],
    });

    expect(res.status).toBe(400);
  });

  it("GET /latest returns empty when no data", async () => {
    const app = buildApp();
    const res = await app.request("/api/scanner-results/latest");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.scanRunId).toBeNull();
  });

  it("POST /run triggers server-side scan and returns summary", async () => {
    const app = buildApp();
    const res = await app.request("/api/scanner-results/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanRunId).toBeDefined();
    expect(typeof body.scanRunId).toBe("string");
    expect(body.scanRunId.length).toBeGreaterThan(0);
    expect(typeof body.inserted).toBe("number");
    expect(body.inserted).toBeGreaterThanOrEqual(0);
    expect(typeof body.tables).toBe("number");
    expect(body.scannedAt).toBeDefined();
  });
});
