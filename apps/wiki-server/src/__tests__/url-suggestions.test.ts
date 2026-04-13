/**
 * Tests for /api/sourcing/url-suggestions route (QUA-64).
 *
 * Focus: request validation + upsert tracking. The dispatcher is deliberately
 * minimal — this route is a thin CRUD wrapper and the interesting logic lives
 * in the generator (tested separately in crux/lib/sourcing/suggest-urls.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson, type SqlDispatcher } from "./test-utils.js";

// Minimal in-memory store.
interface SuggestionRow {
  id: number;
  record_type: string;
  record_id: string;
  field_name: string | null;
  entity_id: string | null;
  suggested_url: string;
  title: string | null;
  snippet: string | null;
  relevance_score: number | null;
  source_provider: string;
  generator_model: string | null;
  status: string;
  notes: string | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  created_at: Date;
  updated_at: Date;
}

let store: SuggestionRow[];
let nextId: number;

function reset() {
  store = [];
  nextId = 1;
}

const dispatch: SqlDispatcher = (query, params) => {
  const q = query.toLowerCase().trim();

  // --- INSERT ... ON CONFLICT (the upsert path) ---
  if (q.startsWith("insert into sourcing_url_suggestions")) {
    const [
      record_type,
      record_id,
      field_name,
      entity_id,
      suggested_url,
      title,
      snippet,
      relevance_score,
      source_provider,
      generator_model,
      status,
      notes,
    ] = params as (string | number | null)[];

    const key = (r: SuggestionRow) =>
      `${r.record_type}|${r.record_id}|${r.field_name ?? ""}|${r.suggested_url}`;
    const rowKey = `${record_type}|${record_id}|${field_name ?? ""}|${suggested_url}`;
    const existing = store.find((r) => key(r) === rowKey);
    const now = new Date();

    if (existing) {
      // Preserve status if not pending (human decisions survive re-gen).
      if (existing.status === "pending") existing.status = String(status);
      existing.title = title as string | null;
      existing.snippet = snippet as string | null;
      existing.relevance_score = relevance_score as number | null;
      existing.source_provider = String(source_provider);
      existing.generator_model = generator_model as string | null;
      existing.entity_id = entity_id as string | null;
      if (notes != null) existing.notes = String(notes);
      existing.updated_at = now;
    } else {
      store.push({
        id: nextId++,
        record_type: String(record_type),
        record_id: String(record_id),
        field_name: field_name as string | null,
        entity_id: entity_id as string | null,
        suggested_url: String(suggested_url),
        title: title as string | null,
        snippet: snippet as string | null,
        relevance_score: relevance_score as number | null,
        source_provider: String(source_provider),
        generator_model: generator_model as string | null,
        status: String(status),
        notes: notes as string | null,
        reviewed_at: null,
        reviewed_by: null,
        created_at: now,
        updated_at: now,
      });
    }
    return [];
  }

  // --- SELECT ... FROM sourcing_url_suggestions (the GET path) ---
  if (
    q.includes("from") &&
    q.includes("sourcing_url_suggestions") &&
    q.startsWith("select")
  ) {
    let rows = [...store];
    // Naive param matching: any string param may be a filter on any column.
    // Good enough — test only asserts on filtered results.
    for (const p of params) {
      if (typeof p !== "string") continue;
      rows = rows.filter(
        (r) =>
          r.record_type === p ||
          r.record_id === p ||
          r.entity_id === p ||
          r.status === p,
      );
    }
    rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return rows;
  }

  // --- UPDATE (PATCH path) ---
  if (q.startsWith("update") && q.includes("sourcing_url_suggestions")) {
    // Last param is the id in our route (eq filter).
    const id = Number(params[params.length - 1]);
    const row = store.find((r) => r.id === id);
    if (!row) return [];
    const newStatus = params[0] as string;
    const newReviewedBy = params[1] as string | null;
    row.status = newStatus;
    row.reviewed_by = newReviewedBy;
    row.reviewed_at = new Date();
    return [{ id: row.id }];
  }

  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { urlSuggestionsRoute } = await import(
  "../routes/sourcing/url-suggestions.js"
);

function buildApp() {
  const app = new Hono();
  app.route("/", urlSuggestionsRoute);
  return app;
}

describe("url-suggestions route", () => {
  beforeEach(() => {
    reset();
  });

  it("rejects invalid JSON on POST /", async () => {
    const app = buildApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  it("rejects empty suggestions array", async () => {
    const app = buildApp();
    const res = await postJson(app, "/", { suggestions: [] });
    expect(res.status).toBe(400);
  });

  it("rejects invalid URL in suggestedUrl", async () => {
    const app = buildApp();
    const res = await postJson(app, "/", {
      suggestions: [
        {
          recordType: "fact",
          recordId: "F1",
          suggestedUrl: "not-a-url",
          sourceProvider: "exa",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid status", async () => {
    const app = buildApp();
    const res = await postJson(app, "/", {
      suggestions: [
        {
          recordType: "fact",
          recordId: "F1",
          suggestedUrl: "https://example.com/a",
          sourceProvider: "exa",
          status: "bogus",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects relevanceScore out of range", async () => {
    const app = buildApp();
    const res = await postJson(app, "/", {
      suggestions: [
        {
          recordType: "fact",
          recordId: "F1",
          suggestedUrl: "https://example.com/a",
          sourceProvider: "exa",
          relevanceScore: 1.5,
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("accepts valid batch and returns upserted count", async () => {
    const app = buildApp();
    const res = await postJson(app, "/", {
      suggestions: [
        {
          recordType: "fact",
          recordId: "F1",
          fieldName: "employee_count",
          entityId: "anthropic",
          suggestedUrl: "https://example.com/a",
          title: "A",
          snippet: "a snippet",
          sourceProvider: "exa",
        },
        {
          recordType: "fact",
          recordId: "F1",
          fieldName: "employee_count",
          entityId: "anthropic",
          suggestedUrl: "https://example.com/b",
          title: "B",
          sourceProvider: "perplexity",
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { upserted: number };
    expect(body.upserted).toBe(2);
    expect(store).toHaveLength(2);
  });

  it("rejects PATCH with non-numeric id", async () => {
    const app = buildApp();
    const res = await app.request("/abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    // Hono's regex route constraint returns 404 for a non-matching param.
    expect([400, 404]).toContain(res.status);
  });

  it("rejects PATCH with invalid status", async () => {
    const app = buildApp();
    const res = await app.request("/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});
