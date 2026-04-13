/**
 * Tests for /api/sourcing/url-suggestions route (QUA-64).
 *
 * The dispatcher parses the WHERE clause for column/param positions so that
 * filters are applied against the right columns, not whichever matches any
 * string param.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson, type SqlDispatcher } from "./test-utils.js";

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

// Per-row INSERT VALUES params count — mirrors the route's sql template.
const COLS_PER_ROW = 12;

let store: SuggestionRow[];
let nextId: number;

function reset() {
  store = [];
  nextId = 1;
}

function upsertRow(rowParams: unknown[]): void {
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
  ] = rowParams;

  const existing = store.find(
    (r) =>
      r.record_type === record_type &&
      r.record_id === record_id &&
      (r.field_name ?? "") === (field_name ?? "") &&
      r.suggested_url === suggested_url,
  );
  const now = new Date();
  if (existing) {
    // Preserve human decisions (non-pending status) through re-gen.
    if (existing.status === "pending") existing.status = String(status);
    existing.title = (title as string | null) ?? null;
    existing.snippet = (snippet as string | null) ?? null;
    existing.relevance_score = (relevance_score as number | null) ?? null;
    existing.source_provider = String(source_provider);
    existing.generator_model = (generator_model as string | null) ?? null;
    existing.entity_id = (entity_id as string | null) ?? null;
    if (notes != null) existing.notes = String(notes);
    existing.updated_at = now;
  } else {
    store.push({
      id: nextId++,
      record_type: String(record_type),
      record_id: String(record_id),
      field_name: (field_name as string | null) ?? null,
      entity_id: (entity_id as string | null) ?? null,
      suggested_url: String(suggested_url),
      title: (title as string | null) ?? null,
      snippet: (snippet as string | null) ?? null,
      relevance_score: (relevance_score as number | null) ?? null,
      source_provider: String(source_provider),
      generator_model: (generator_model as string | null) ?? null,
      status: String(status),
      notes: (notes as string | null) ?? null,
      reviewed_at: null,
      reviewed_by: null,
      created_at: now,
      updated_at: now,
    });
  }
}

/** Parse `"column" = $N` style pairs from a SQL WHERE clause into (col, 0-indexed param) pairs. */
function parseEqFilters(query: string): Array<{ col: string; paramIdx: number }> {
  const pairs: Array<{ col: string; paramIdx: number }> = [];
  // Match identifiers like "sourcing_url_suggestions"."record_type" = $3 or bare "record_type" = $3
  const re = /"([a-z_]+)"\s*=\s*\$(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    pairs.push({ col: m[1], paramIdx: Number(m[2]) - 1 });
  }
  return pairs;
}

const dispatch: SqlDispatcher = (query, params) => {
  const q = query.toLowerCase().trim();

  // --- INSERT ... ON CONFLICT (multi-row upsert path) ---
  if (q.startsWith("insert into sourcing_url_suggestions")) {
    // Params come in flat; chunk into COLS_PER_ROW groups per row.
    for (let i = 0; i < params.length; i += COLS_PER_ROW) {
      upsertRow(params.slice(i, i + COLS_PER_ROW));
    }
    return [];
  }

  // --- SELECT ... FROM sourcing_url_suggestions (the GET path) ---
  if (
    q.includes("from") &&
    q.includes("sourcing_url_suggestions") &&
    q.startsWith("select")
  ) {
    const filters = parseEqFilters(query);
    let rows = [...store];
    for (const f of filters) {
      const value = params[f.paramIdx];
      // Only apply string-equality filters over the known columns.
      rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[f.col] === value);
    }
    rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return rows;
  }

  // --- UPDATE ... SET ... WHERE id = $N (PATCH path) ---
  if (q.startsWith("update") && q.includes("sourcing_url_suggestions")) {
    // Find the id param via the WHERE clause (id = $N).
    const idFilter = parseEqFilters(query).find((f) => f.col === "id");
    const id = idFilter ? Number(params[idFilter.paramIdx]) : NaN;
    const row = store.find((r) => r.id === id);
    if (!row) return [];

    // Parse SET assignments: `"col" = $N`.
    const setMatches = [...query.matchAll(/"([a-z_]+)"\s*=\s*\$(\d+)/gi)];
    // First matches before the WHERE are SET targets. We don't have a clean
    // WHERE boundary here, so skip any with col === "id" (that's the WHERE).
    for (const m of setMatches) {
      const col = m[1];
      if (col === "id") continue;
      const val = params[Number(m[2]) - 1];
      if (col === "status") row.status = String(val);
      else if (col === "reviewed_by") row.reviewed_by = val as string | null;
      else if (col === "notes") row.notes = val as string | null;
      else if (col === "reviewed_at") row.reviewed_at = val as Date;
    }
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

// Helper to seed a suggestion directly into the store.
function seedSuggestion(overrides: Partial<SuggestionRow> = {}): SuggestionRow {
  const now = new Date();
  const row: SuggestionRow = {
    id: nextId++,
    record_type: "fact",
    record_id: "F1",
    field_name: null,
    entity_id: "anthropic",
    suggested_url: "https://example.com/seed",
    title: "seed",
    snippet: null,
    relevance_score: null,
    source_provider: "exa",
    generator_model: null,
    status: "pending",
    notes: null,
    reviewed_at: null,
    reviewed_by: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  store.push(row);
  return row;
}

describe("url-suggestions route — POST /", () => {
  beforeEach(() => reset());

  it("rejects invalid JSON", async () => {
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

  it("rejects batches over MAX_BATCH", async () => {
    const app = buildApp();
    const suggestions = Array.from({ length: 201 }, (_, i) => ({
      recordType: "fact",
      recordId: `F${i}`,
      suggestedUrl: `https://example.com/${i}`,
      sourceProvider: "exa",
    }));
    const res = await postJson(app, "/", { suggestions });
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
    expect(store[0].record_id).toBe("F1");
    expect(store[0].status).toBe("pending");
  });

  it("preserves non-pending status on re-generation", async () => {
    const seeded = seedSuggestion({
      record_type: "fact",
      record_id: "F1",
      field_name: null,
      suggested_url: "https://example.com/same",
      status: "approved",
      title: "old title",
    });

    const app = buildApp();
    const res = await postJson(app, "/", {
      suggestions: [
        {
          recordType: "fact",
          recordId: "F1",
          suggestedUrl: "https://example.com/same",
          sourceProvider: "perplexity",
          title: "new title",
          status: "pending",
        },
      ],
    });
    expect(res.status).toBe(200);
    const row = store.find((r) => r.id === seeded.id);
    expect(row).toBeDefined();
    // Status is preserved because it wasn't pending.
    expect(row!.status).toBe("approved");
    // Other fields do get refreshed.
    expect(row!.title).toBe("new title");
    expect(row!.source_provider).toBe("perplexity");
  });
});

describe("url-suggestions route — GET /", () => {
  beforeEach(() => reset());

  // Drizzle returns camelCase keys in query results.
  type ApiRow = { recordId: string; entityId: string | null; status: string };

  it("returns all rows when no filters given", async () => {
    seedSuggestion({ record_id: "F1" });
    seedSuggestion({ record_id: "F2", entity_id: "openai" });
    const app = buildApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: ApiRow[]; returned: number };
    expect(body.returned).toBe(2);
    expect(body.suggestions).toHaveLength(2);
  });

  it("filters by entityId (does not match a record_id with the same value)", async () => {
    seedSuggestion({ record_id: "anthropic", entity_id: null });
    seedSuggestion({ record_id: "F1", entity_id: "anthropic" });
    const app = buildApp();
    const res = await app.request("/?entityId=anthropic");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: ApiRow[] };
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].recordId).toBe("F1");
  });

  it("filters by status", async () => {
    seedSuggestion({ record_id: "A", status: "pending" });
    seedSuggestion({ record_id: "B", status: "approved" });
    const app = buildApp();
    const res = await app.request("/?status=approved");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: ApiRow[] };
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].recordId).toBe("B");
  });
});

describe("url-suggestions route — PATCH /:id", () => {
  beforeEach(() => reset());

  it("rejects non-numeric id", async () => {
    const app = buildApp();
    const res = await app.request("/abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    // Hono's regex route constraint returns 404 for a non-matching param.
    expect([400, 404]).toContain(res.status);
  });

  it("rejects invalid status", async () => {
    const app = buildApp();
    const res = await app.request("/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a missing id", async () => {
    const app = buildApp();
    const res = await app.request("/999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(404);
  });

  it("updates status successfully and stamps reviewedAt", async () => {
    const seeded = seedSuggestion({ status: "pending" });
    const app = buildApp();
    const res = await app.request(`/${seeded.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", reviewedBy: "agent-a4" }),
    });
    expect(res.status).toBe(200);
    const row = store.find((r) => r.id === seeded.id)!;
    expect(row.status).toBe("approved");
    expect(row.reviewed_by).toBe("agent-a4");
    // Drizzle serializes Date params as ISO strings before sending to postgres-js;
    // the dispatcher receives them as strings, so accept either.
    expect(row.reviewed_at).not.toBeNull();
  });

  it("does not touch notes when key omitted", async () => {
    const seeded = seedSuggestion({ notes: "keep me" });
    const app = buildApp();
    const res = await app.request(`/${seeded.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(200);
    const row = store.find((r) => r.id === seeded.id)!;
    expect(row.notes).toBe("keep me");
  });

  it("clears notes when key is explicitly null", async () => {
    const seeded = seedSuggestion({ notes: "erase me" });
    const app = buildApp();
    const res = await app.request(`/${seeded.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", notes: null }),
    });
    expect(res.status).toBe(200);
    const row = store.find((r) => r.id === seeded.id)!;
    expect(row.notes).toBeNull();
  });
});
