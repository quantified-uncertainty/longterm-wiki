/**
 * Tests for the model_aliases sync handler — the canonical resolution table
 * used by Phase 2 ingesters (QUA-689).
 *
 * Two behaviors to lock in:
 *   1. Validation rejects mixed-case aliases — the column is meant to be
 *      lowercased before sync, so callers can do a single case-insensitive
 *      lookup. Catching mixed case at the schema layer prevents a class of
 *      "two rows for the same alias, different case" bugs.
 *   2. Intra-batch dedup catches the same alias submitted twice in one
 *      payload (e.g. an ingester reading two pages and stitching results
 *      without a final dedup pass).
 *
 * The sync-factory's downstream behavior (audit log, FK validation) is
 * covered by sync-factory.test.ts; these tests focus on the route-specific
 * shape.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

interface SqlEntry {
  q: string;
  params: unknown[];
}
const sqlLog: SqlEntry[] = [];

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();
  sqlLog.push({ q, params });

  // Pre-fetch select for audit log
  if (
    q.includes("select") &&
    q.includes('"model_aliases"') &&
    q.includes("where") &&
    !q.includes("update")
  ) {
    return [];
  }
  // INSERT or UPDATE on model_aliases / audit log
  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { modelAliasesRoute } = await import(
  "../routes/tablebase/model-aliases.js"
);

function buildApp(): Hono {
  const app = new Hono();
  app.route("/", modelAliasesRoute);
  return app;
}

describe("model_aliases /sync", () => {
  beforeEach(() => {
    sqlLog.length = 0;
  });

  it("accepts a lowercase alias and produces an INSERT", async () => {
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          alias: "claude-3-5-sonnet",
          modelStableId: "sid_AbCdEfGhIj",
          source: "yaml-seed",
          confidence: "exact",
        },
      ],
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { upserted: number };
    expect(body.upserted).toBe(1);

    const insertCount = sqlLog.filter(
      ({ q }) => q.includes("insert into") && q.includes('"model_aliases"'),
    ).length;
    expect(insertCount).toBeGreaterThan(0);
  });

  it("rejects a mixed-case alias", async () => {
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          alias: "Claude-3-5-Sonnet",
          modelStableId: "sid_AbCdEfGhIj",
        },
      ],
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error?: string; message?: string };
    const errMessage = body.message ?? body.error ?? "";
    expect(errMessage.toLowerCase()).toMatch(/lowercase/);

    // No INSERT should have been issued.
    const insertCount = sqlLog.filter(
      ({ q }) => q.includes("insert into") && q.includes('"model_aliases"'),
    ).length;
    expect(insertCount).toBe(0);
  });

  it("rejects duplicate aliases within a single batch (natural-key dedup)", async () => {
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          alias: "claude-3-5-sonnet",
          modelStableId: "sid_AbCdEfGhIj",
        },
        {
          alias: "claude-3-5-sonnet",
          modelStableId: "sid_DifferentMo",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid confidence value", async () => {
    const app = buildApp();
    const res = await postJson(app, "/sync", {
      items: [
        {
          alias: "claude-3-5-sonnet",
          modelStableId: "sid_AbCdEfGhIj",
          confidence: "guessed",
        },
      ],
    });
    expect(res.status).toBe(400);
  });
});
