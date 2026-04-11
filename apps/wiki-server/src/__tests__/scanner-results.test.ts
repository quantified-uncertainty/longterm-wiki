/**
 * Tests for the scanner-results route.
 *
 * Validates:
 *   1. POST /sync inserts items and returns count
 *   2. Schema validation rejects invalid payloads
 *   3. Empty batch rejected (min 1 item)
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

  // SELECT for latest
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
});
