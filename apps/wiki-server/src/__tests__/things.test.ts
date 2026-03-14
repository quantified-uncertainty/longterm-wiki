import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory store simulating Postgres things table ----

let thingsStore: Map<string, Record<string, unknown>>;
/** Index by (sourceTable, sourceId) for upsert conflict detection */
let sourceKeyIndex: Map<string, string>; // "table\0id" -> things.id

function resetStores() {
  thingsStore = new Map();
  sourceKeyIndex = new Map();
}

function makeThing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  return {
    id: "test-thing-1",
    thing_type: "entity",
    title: "Test Thing",
    parent_thing_id: null,
    source_table: "entities",
    source_id: "test-1",
    entity_type: null,
    description: null,
    source_url: null,
    numeric_id: null,
    verdict: null,
    verdict_confidence: null,
    verdict_at: null,
    created_at: now,
    updated_at: now,
    synced_at: now,
    ...overrides,
  };
}

/**
 * Apply WHERE clause filters for things queries.
 * Uses the WHERE part of the SQL and string params to filter the in-memory store.
 * The SQL SELECT clause always contains all column names, so we match the WHERE
 * clause specifically by checking for `"column_name" =` patterns.
 */
function applyThingsFilters(
  q: string,
  params: unknown[]
): Record<string, unknown>[] {
  let rows = Array.from(thingsStore.values());

  if (!q.includes("where")) return rows;

  // Extract the WHERE clause portion to check filters
  const whereIdx = q.indexOf("where");
  const whereClause = q.substring(whereIdx);

  // String params are filter values; numeric params are limit/offset
  const stringParams = params.filter((p) => typeof p === "string") as string[];

  // Check which columns appear in WHERE (using the pattern `"column" =`)
  let paramIdx = 0;

  if (whereClause.includes('"thing_type" =')) {
    const filterVal = stringParams[paramIdx++];
    if (filterVal) {
      rows = rows.filter((r) => r.thing_type === filterVal);
    }
  }

  if (whereClause.includes('"entity_type" =')) {
    const filterVal = stringParams[paramIdx++];
    if (filterVal) {
      rows = rows.filter((r) => r.entity_type === filterVal);
    }
  }

  if (whereClause.includes('"parent_thing_id" =')) {
    const filterVal = stringParams[paramIdx++];
    if (filterVal) {
      rows = rows.filter((r) => r.parent_thing_id === filterVal);
    }
  }

  if (whereClause.includes('"verdict" =')) {
    const filterVal = stringParams[paramIdx++];
    if (filterVal) {
      rows = rows.filter((r) => r.verdict === filterVal);
    }
  }

  // is not null / is null for verdict
  if (whereClause.includes("is not null") && whereClause.includes("verdict")) {
    rows = rows.filter((r) => r.verdict !== null);
  }
  if (
    whereClause.includes("is null") &&
    whereClause.includes("verdict") &&
    !whereClause.includes("is not null")
  ) {
    rows = rows.filter((r) => r.verdict === null);
  }

  return rows;
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- things: INSERT ... ON CONFLICT DO UPDATE ---
  if (q.includes("insert into") && q.includes('"things"')) {
    const COLS = 10; // id, thingType, title, parentThingId, sourceTable, sourceId, entityType, description, sourceUrl, numericId
    const numRows = params.length / COLS;
    const rows: Record<string, unknown>[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const id = params[o] as string;
      const sourceTable = params[o + 4] as string;
      const sourceId = params[o + 5] as string;
      const sourceKey = `${sourceTable}\0${sourceId}`;

      // Check if source key already exists (upsert)
      const existingId = sourceKeyIndex.get(sourceKey);
      const existing = existingId ? thingsStore.get(existingId) : undefined;

      const row = makeThing({
        id: existing ? (existing.id as string) : id,
        thing_type: params[o + 1],
        title: params[o + 2],
        parent_thing_id: params[o + 3],
        source_table: sourceTable,
        source_id: sourceId,
        entity_type: params[o + 6],
        description: params[o + 7],
        source_url: params[o + 8],
        numeric_id: params[o + 9],
        created_at: existing?.created_at ?? now,
        updated_at: now,
        synced_at: now,
      });

      const finalId = row.id as string;
      thingsStore.set(finalId, row);
      sourceKeyIndex.set(sourceKey, finalId);
      rows.push(row);
    }
    return rows;
  }

  // --- things: search_vector / plainto_tsquery (FTS search) ---
  if (q.includes('"things"') && q.includes("plainto_tsquery")) {
    // FTS: return empty to trigger ILIKE fallback (simulates no tsvector in memory)
    return [];
  }

  // --- things: ILIKE search (fallback) ---
  if (q.includes('"things"') && q.includes("ilike")) {
    const pattern = params[0] as string;
    const searchTerm = pattern.replace(/%/g, "").toLowerCase();
    const limitParam = params.find(
      (p, i) => i >= 3 && typeof p === "number"
    ) as number | undefined;
    const limit = limitParam ?? 20;
    const results: Record<string, unknown>[] = [];
    for (const row of thingsStore.values()) {
      const title = ((row.title as string) || "").toLowerCase();
      const id = ((row.id as string) || "").toLowerCase();
      const desc = ((row.description as string) || "").toLowerCase();
      if (
        title.includes(searchTerm) ||
        id.includes(searchTerm) ||
        desc.includes(searchTerm)
      ) {
        results.push(row);
      }
    }
    return results.slice(0, limit);
  }

  // --- things: COUNT with GROUP BY (stats by type / verdict / entity_type) ---
  if (q.includes('"things"') && q.includes("group by")) {
    // Determine which column is being grouped
    if (q.includes("coalesce") && q.includes("verdict")) {
      // GROUP BY verdict (with COALESCE for null -> 'unverified')
      const byVerdict = new Map<string, number>();
      for (const row of thingsStore.values()) {
        const v = (row.verdict as string) || "unverified";
        byVerdict.set(v, (byVerdict.get(v) || 0) + 1);
      }
      return [...byVerdict.entries()].map(([verdict, count]) => ({
        verdict,
        count,
      }));
    }

    if (q.includes("entity_type")) {
      // GROUP BY entity_type (with is not null filter)
      const byEntityType = new Map<string, number>();
      for (const row of thingsStore.values()) {
        if (row.entity_type) {
          const et = row.entity_type as string;
          byEntityType.set(et, (byEntityType.get(et) || 0) + 1);
        }
      }
      return [...byEntityType.entries()].map(([entity_type, count]) => ({
        entity_type,
        count,
      }));
    }

    if (q.includes("thing_type")) {
      // GROUP BY thing_type
      const byType = new Map<string, number>();
      for (const row of thingsStore.values()) {
        const t = row.thing_type as string;
        byType.set(t, (byType.get(t) || 0) + 1);
      }
      return [...byType.entries()].map(([thing_type, count]) => ({
        thing_type,
        count,
      }));
    }

    return [];
  }

  // --- things: COUNT(*) without GROUP BY ---
  if (q.includes("count(") && q.includes('"things"') && !q.includes("group by")) {
    const filtered = applyThingsFilters(q, params);
    return [{ count: filtered.length }];
  }

  // --- things: SELECT by id (single thing lookup) ---
  // Matches: WHERE "id" = $1 LIMIT — no ORDER BY, no ILIKE, no FTS
  if (
    q.includes('"things"') &&
    q.includes("where") &&
    q.includes("limit") &&
    !q.includes("order by") &&
    !q.includes("count(") &&
    !q.includes("ilike") &&
    !q.includes("plainto_tsquery") &&
    !q.includes("group by")
  ) {
    const id = params[0] as string;
    const row = thingsStore.get(id);
    return row ? [row] : [];
  }

  // --- things: SELECT with ORDER BY + LIMIT (paginated listing) ---
  if (
    q.includes('"things"') &&
    q.includes("order by") &&
    q.includes("limit") &&
    !q.includes("count(") &&
    !q.includes("ilike") &&
    !q.includes("plainto_tsquery") &&
    !q.includes("group by")
  ) {
    const filtered = applyThingsFilters(q, params);

    filtered.sort((a, b) =>
      (a.title as string).localeCompare(b.title as string)
    );

    // Last two numeric params are limit and offset
    const numericParams = params.filter((p) => typeof p === "number") as number[];
    const limit = numericParams.length >= 2 ? numericParams[numericParams.length - 2] : (numericParams.length === 1 ? numericParams[0] : 50);
    const offset = numericParams.length >= 2 ? numericParams[numericParams.length - 1] : 0;
    return filtered.slice(offset, offset + limit);
  }

  // --- thing_resource_verifications ---
  if (q.includes("thing_resource_verifications")) {
    return [];
  }

  // --- thing_verdicts ---
  if (q.includes("thing_verdicts")) {
    return [];
  }

  // --- entity_ids: COUNT (for health check) ---
  if (q.includes("count(*)") && !q.includes('"things"')) {
    return [{ count: 0 }];
  }

  // --- sequence health check ---
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: true }];
  }

  return [];
}

// Mock the db module
vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Helpers ----

function seedThing(
  app: Hono,
  id: string,
  title: string,
  opts: Record<string, unknown> = {}
) {
  return postJson(app, "/api/things/sync", {
    things: [
      {
        id,
        thingType: opts.thingType ?? "entity",
        title,
        sourceTable: opts.sourceTable ?? "entities",
        sourceId: opts.sourceId ?? id,
        entityType: opts.entityType ?? undefined,
        description: opts.description ?? undefined,
        sourceUrl: opts.sourceUrl ?? undefined,
        numericId: opts.numericId ?? undefined,
        parentThingId: opts.parentThingId ?? undefined,
      },
    ],
  });
}

// ---- Tests ----

describe("Things API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ---- Sync ----

  describe("POST /api/things/sync", () => {
    it("creates new things from a batch", async () => {
      const res = await postJson(app, "/api/things/sync", {
        things: [
          {
            id: "thing-anthropic",
            thingType: "entity",
            title: "Anthropic",
            sourceTable: "entities",
            sourceId: "anthropic",
            entityType: "organization",
          },
          {
            id: "thing-openai",
            thingType: "entity",
            title: "OpenAI",
            sourceTable: "entities",
            sourceId: "openai",
            entityType: "organization",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(2);
    });

    it("rejects duplicate (sourceTable, sourceId) pairs within a batch", async () => {
      const res = await postJson(app, "/api/things/sync", {
        things: [
          {
            id: "thing-1",
            thingType: "entity",
            title: "First",
            sourceTable: "entities",
            sourceId: "same-id",
          },
          {
            id: "thing-2",
            thingType: "entity",
            title: "Second",
            sourceTable: "entities",
            sourceId: "same-id",
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("Duplicate source key");
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/things/sync", { things: [] });
      expect(res.status).toBe(400);
    });

    it("rejects batch exceeding MAX_SYNC_BATCH (200)", async () => {
      const items = Array.from({ length: 201 }, (_, i) => ({
        id: `thing-${i}`,
        thingType: "entity" as const,
        title: `Thing ${i}`,
        sourceTable: "entities",
        sourceId: `entity-${i}`,
      }));

      const res = await postJson(app, "/api/things/sync", { things: items });
      expect(res.status).toBe(400);
    });

    it("validates required fields (id, thingType, title, sourceTable, sourceId)", async () => {
      // Missing id
      let res = await postJson(app, "/api/things/sync", {
        things: [
          {
            thingType: "entity",
            title: "No ID",
            sourceTable: "entities",
            sourceId: "x",
          },
        ],
      });
      expect(res.status).toBe(400);

      // Missing thingType
      res = await postJson(app, "/api/things/sync", {
        things: [
          {
            id: "thing-1",
            title: "No Type",
            sourceTable: "entities",
            sourceId: "x",
          },
        ],
      });
      expect(res.status).toBe(400);

      // Missing title
      res = await postJson(app, "/api/things/sync", {
        things: [
          {
            id: "thing-1",
            thingType: "entity",
            sourceTable: "entities",
            sourceId: "x",
          },
        ],
      });
      expect(res.status).toBe(400);

      // Missing sourceTable
      res = await postJson(app, "/api/things/sync", {
        things: [
          {
            id: "thing-1",
            thingType: "entity",
            title: "No Source",
            sourceId: "x",
          },
        ],
      });
      expect(res.status).toBe(400);

      // Missing sourceId
      res = await postJson(app, "/api/things/sync", {
        things: [
          {
            id: "thing-1",
            thingType: "entity",
            title: "No Source ID",
            sourceTable: "entities",
          },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("validates thingType is from VALID_THING_TYPES enum", async () => {
      const res = await postJson(app, "/api/things/sync", {
        things: [
          {
            id: "thing-1",
            thingType: "invalid-type",
            title: "Bad Type",
            sourceTable: "entities",
            sourceId: "x",
          },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON", async () => {
      const res = await app.request("/api/things/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_json");
    });
  });

  // ---- Paginated Listing ----

  describe("GET /api/things/ (listing)", () => {
    it("returns paginated list with total count", async () => {
      await seedThing(app, "thing-a", "Alpha");
      await seedThing(app, "thing-b", "Beta", { sourceId: "beta-1" });
      await seedThing(app, "thing-c", "Gamma", { sourceId: "gamma-1" });

      const res = await app.request("/api/things?limit=2&offset=0");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.things).toHaveLength(2);
      expect(body.total).toBe(3);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    });

    it("filters by thing_type query param", async () => {
      await seedThing(app, "thing-entity", "Entity Thing", {
        thingType: "entity",
        sourceId: "e1",
      });
      await seedThing(app, "thing-fact", "Fact Thing", {
        thingType: "fact",
        sourceId: "f1",
      });

      const res = await app.request("/api/things?thing_type=entity");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.things.length).toBeGreaterThan(0);
      for (const t of body.things) {
        expect(t.thingType).toBe("entity");
      }
    });

    it("filters by entity_type query param", async () => {
      await seedThing(app, "thing-org", "Org Thing", {
        thingType: "entity",
        entityType: "organization",
        sourceId: "org-1",
      });
      await seedThing(app, "thing-risk", "Risk Thing", {
        thingType: "entity",
        entityType: "risk",
        sourceId: "risk-1",
      });

      const res = await app.request("/api/things?entity_type=organization");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.things.length).toBeGreaterThan(0);
      for (const t of body.things) {
        expect(t.entityType).toBe("organization");
      }
    });

    it("filters by has_verdict=true/false", async () => {
      // Seed a thing with verdict
      await seedThing(app, "thing-verified", "Verified Thing", {
        sourceId: "v1",
      });
      // Manually set verdict in the store
      const verifiedRow = thingsStore.get("thing-verified");
      if (verifiedRow) {
        verifiedRow.verdict = "confirmed";
        verifiedRow.verdict_confidence = 0.95;
      }

      await seedThing(app, "thing-unverified", "Unverified Thing", {
        sourceId: "uv1",
      });

      // has_verdict=true
      const res1 = await app.request("/api/things?has_verdict=true");
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.things.length).toBeGreaterThan(0);
      for (const t of body1.things) {
        expect(t.verdict).toBeTruthy();
      }

      // has_verdict=false
      const res2 = await app.request("/api/things?has_verdict=false");
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.things.length).toBeGreaterThan(0);
      for (const t of body2.things) {
        expect(t.verdict).toBeNull();
      }
    });

    it("returns empty list when no things", async () => {
      const res = await app.request("/api/things");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.things).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  // ---- Search ----

  describe("GET /api/things/search", () => {
    it("returns search results for a query", async () => {
      await seedThing(app, "thing-anthropic", "Anthropic", {
        sourceId: "anthropic-1",
        description: "AI safety company",
      });
      await seedThing(app, "thing-openai", "OpenAI", {
        sourceId: "openai-1",
        description: "AI research lab",
      });

      const res = await app.request("/api/things/search?q=anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.query).toBe("anthropic");
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0].title).toBe("Anthropic");
    });

    it("falls back to ILIKE when FTS returns no results", async () => {
      await seedThing(app, "thing-test", "Test Item", {
        sourceId: "test-1",
      });

      const res = await app.request("/api/things/search?q=test");
      expect(res.status).toBe(200);
      const body = await res.json();
      // FTS returns nothing in mock, so ILIKE fallback is used
      expect(body.searchMethod).toBe("ilike");
      expect(body.results.length).toBeGreaterThan(0);
    });

    it("requires q parameter", async () => {
      const res = await app.request("/api/things/search");
      expect(res.status).toBe(400);
    });
  });

  // ---- Get by ID ----

  describe("GET /api/things/:id", () => {
    it("returns thing by ID with childrenCount", async () => {
      await seedThing(app, "parent-thing", "Parent", {
        sourceId: "parent-1",
      });

      const res = await app.request("/api/things/parent-thing");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("parent-thing");
      expect(body.title).toBe("Parent");
      expect(body.childrenCount).toBeDefined();
    });

    it("returns 404 for non-existent thing", async () => {
      const res = await app.request("/api/things/nonexistent");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("not_found");
    });
  });

  // ---- Stats ----

  describe("GET /api/things/stats", () => {
    it("returns aggregate stats (total, byType, byVerdict, byEntityType)", async () => {
      await seedThing(app, "thing-e1", "Entity 1", {
        thingType: "entity",
        entityType: "organization",
        sourceId: "e1",
      });
      await seedThing(app, "thing-e2", "Entity 2", {
        thingType: "entity",
        entityType: "risk",
        sourceId: "e2",
      });
      await seedThing(app, "thing-f1", "Fact 1", {
        thingType: "fact",
        sourceId: "f1",
      });

      const res = await app.request("/api/things/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(3);
      expect(body.byType).toBeDefined();
      expect(body.byType.entity).toBe(2);
      expect(body.byType.fact).toBe(1);
      expect(body.byVerdict).toBeDefined();
      expect(body.byEntityType).toBeDefined();
      expect(body.byEntityType.organization).toBe(1);
      expect(body.byEntityType.risk).toBe(1);
    });
  });

  // ---- Auth ----

  describe("Bearer auth", () => {
    it("rejects unauthenticated sync when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      const authedApp = createApp();

      const res = await postJson(authedApp, "/api/things/sync", {
        things: [
          {
            id: "thing-1",
            thingType: "entity",
            title: "Test",
            sourceTable: "entities",
            sourceId: "x",
          },
        ],
      });

      expect(res.status).toBe(401);
    });

    it("accepts sync with correct Bearer token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      const authedApp = createApp();

      const res = await authedApp.request("/api/things/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-secret",
        },
        body: JSON.stringify({
          things: [
            {
              id: "thing-1",
              thingType: "entity",
              title: "Test",
              sourceTable: "entities",
              sourceId: "x",
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
    });
  });
});
