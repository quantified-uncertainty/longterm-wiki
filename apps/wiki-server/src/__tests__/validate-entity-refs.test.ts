import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores simulating Postgres ----

let entitiesStore: Map<string, Record<string, unknown>>;
let benchmarksStore: Map<string, Record<string, unknown>>;

function resetStores() {
  entitiesStore = new Map();
  benchmarksStore = new Map();
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- validate-entity-refs: unnest + entities check ---
  if (q.includes("unnest") && q.includes("from entities")) {
    return params
      .filter((p) => {
        const id = p as string;
        if (entitiesStore.has(id)) return true;
        for (const row of entitiesStore.values()) {
          if (row.stable_id === id) return true;
        }
        return false;
      })
      .map((p) => ({ ref: p }));
  }

  // --- benchmark-results validation: SELECT id FROM benchmarks WHERE id IN (...) ---
  if (q.includes("from benchmarks") && q.includes("where") && q.includes(" in ")) {
    return params
      .filter((p) => benchmarksStore.has(p as string))
      .map((p) => ({ id: p }));
  }

  // --- ref-check: SELECT id FROM entities WHERE id IN (...) ---
  if (q.includes("as id from") && q.includes("where") && q.includes(" in ")) {
    return params
      .filter((p) => entitiesStore.has(p as string))
      .map((p) => ({ id: p }));
  }

  // --- entities: INSERT ... ON CONFLICT DO UPDATE ---
  if (q.includes("insert into") && q.includes('"entities"')) {
    const COLS = 15;
    const numRows = params.length / COLS;
    const rows: Record<string, unknown>[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const id = params[o] as string;
      const row: Record<string, unknown> = {
        id,
        wiki_id: params[o + 1],
        stable_id: params[o + 2],
        entity_type: params[o + 3],
        title: params[o + 4],
        description: params[o + 5],
        website: params[o + 6],
        tags: params[o + 7],
        clusters: params[o + 8],
        status: params[o + 9],
        last_updated: params[o + 10],
        custom_fields: params[o + 11],
        related_entries: params[o + 12],
        sources: params[o + 13],
        metadata: params[o + 14],
        synced_at: now,
        created_at: now,
        updated_at: now,
      };
      entitiesStore.set(id, row);
      rows.push(row);
    }
    return rows;
  }

  // --- personnel: INSERT ... ON CONFLICT DO UPDATE ---
  if (q.includes("insert into") && q.includes('"personnel"')) {
    return [];
  }

  // --- investments: INSERT ... ON CONFLICT DO UPDATE ---
  if (q.includes("insert into") && q.includes('"investments"')) {
    return [];
  }

  // --- funding_rounds: INSERT ... ON CONFLICT DO UPDATE ---
  if (q.includes("insert into") && q.includes('"funding_rounds"')) {
    return [];
  }

  // --- benchmark_results: INSERT ... ON CONFLICT DO UPDATE ---
  if (q.includes("insert into") && q.includes('"benchmark_results"')) {
    return [];
  }

  // --- things: INSERT ---
  if (q.includes("insert into") && q.includes('"things"')) {
    return [];
  }

  return [];
}

// Mock the db module
vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Helpers ----

function seedEntity(id: string, stableId: string | null = null) {
  entitiesStore.set(id, {
    id,
    wiki_id: null,
    stable_id: stableId,
    entity_type: "organization",
    title: `Entity ${id}`,
    description: null,
    website: null,
    tags: null,
    clusters: null,
    status: null,
    last_updated: null,
    custom_fields: null,
    related_entries: null,
    sources: null,
    metadata: null,
    synced_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  });
}

function seedBenchmark(id: string) {
  benchmarksStore.set(id, { id, slug: id, name: `Benchmark ${id}` });
}

describe("Entity FK validation", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ---- Personnel sync ----

  describe("POST /api/personnel/sync", () => {
    it("rejects when personId does not exist in entities", async () => {
      seedEntity("org-acme", "acmeORG001");

      const res = await postJson(app, "/api/personnel/sync", {
        items: [
          {
            id: "P_12345678",
            personId: "johnPER001",
            organizationId: "acmeORG001",
            role: "CEO",
            roleType: "key-person",
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
      expect(body.message).toContain("personId");
      expect(body.message).toContain("johnPER001");
    });

    it("rejects when organizationId does not exist in entities", async () => {
      seedEntity("person-john", "johnPER001");

      const res = await postJson(app, "/api/personnel/sync", {
        items: [
          {
            id: "P_12345678",
            personId: "johnPER001",
            organizationId: "acmeORG001",
            role: "CEO",
            roleType: "key-person",
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
      expect(body.message).toContain("organizationId");
      expect(body.message).toContain("acmeORG001");
    });

    it("accepts when both personId and organizationId exist (by stableId)", async () => {
      seedEntity("person-john", "johnPER001");
      seedEntity("org-acme", "acmeORG001");

      const res = await postJson(app, "/api/personnel/sync", {
        items: [
          {
            id: "P_12345678",
            personId: "johnPER001",
            organizationId: "acmeORG001",
            role: "CEO",
            roleType: "key-person",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("accepts when IDs match by stableId", async () => {
      seedEntity("person-john", "johnPER001");
      seedEntity("org-acme", "acmeORG001");

      const res = await postJson(app, "/api/personnel/sync", {
        items: [
          {
            id: "P_12345678",
            personId: "johnPER001",
            organizationId: "acmeORG001",
            role: "CEO",
            roleType: "key-person",
          },
        ],
      });

      expect(res.status).toBe(200);
    });

    it("skips validation when skipEntityValidation=true", async () => {
      const res = await postJson(
        app,
        "/api/personnel/sync?skipEntityValidation=true",
        {
          items: [
            {
              id: "P_12345678",
              personId: "nxPerson01",
              organizationId: "nxOrgani01",
              role: "CEO",
              roleType: "key-person",
            },
          ],
        },
      );

      expect(res.status).toBe(200);
    });

    it("reports multiple missing fields in one error", async () => {
      const res = await postJson(app, "/api/personnel/sync", {
        items: [
          {
            id: "P_12345678",
            personId: "missPER001",
            organizationId: "missORG001",
            role: "CEO",
            roleType: "key-person",
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("personId");
      expect(body.message).toContain("missPER001");
      expect(body.message).toContain("organizationId");
      expect(body.message).toContain("missORG001");
    });
  });

  // ---- Investments sync ----

  describe("POST /api/investments/sync", () => {
    it("rejects when investorId does not exist", async () => {
      seedEntity("company-x", "stb_comp001");

      const res = await postJson(app, "/api/investments/sync", {
        items: [
          {
            id: "I_12345678",
            companyId: "company-x",
            investorId: "nonexistent-investor",
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("investorId");
      expect(body.message).toContain("nonexistent-investor");
    });

    it("accepts when both companyId and investorId exist", async () => {
      seedEntity("company-x", "stb_comp001");
      seedEntity("investor-y", "stb_inv001");

      const res = await postJson(app, "/api/investments/sync", {
        items: [
          {
            id: "I_12345678",
            companyId: "company-x",
            investorId: "investor-y",
          },
        ],
      });

      expect(res.status).toBe(200);
    });
  });

  // ---- Funding rounds sync ----

  describe("POST /api/funding-rounds/sync", () => {
    it("rejects when companyId does not exist", async () => {
      const res = await postJson(app, "/api/funding-rounds/sync", {
        items: [
          {
            id: "F_12345678",
            companyId: "nonexistent-company",
            name: "Series A",
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("companyId");
      expect(body.message).toContain("nonexistent-company");
    });

    it("accepts when companyId exists", async () => {
      seedEntity("company-z", "stb_compz01");

      const res = await postJson(app, "/api/funding-rounds/sync", {
        items: [
          {
            id: "F_12345678",
            companyId: "company-z",
            name: "Series A",
          },
        ],
      });

      expect(res.status).toBe(200);
    });
  });

  // ---- Benchmark results sync ----

  describe("POST /api/benchmark-results/sync", () => {
    it("rejects when benchmarkId does not exist in benchmarks table", async () => {
      seedEntity("model-gpt4", "stb_model01");
      // Note: NOT seeding a benchmark — should fail

      const res = await postJson(app, "/api/benchmark-results/sync", {
        items: [
          {
            id: "B_12345678",
            benchmarkId: "nonexistent-benchmark",
            modelId: "model-gpt4",
            score: 0.95,
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-benchmark");
    });

    it("accepts when benchmarkId exists in benchmarks table and modelId in entities", async () => {
      seedBenchmark("benchmark-mmlu"); // seed in benchmarks table
      seedEntity("model-gpt4", "stb_model01"); // seed in entities table

      const res = await postJson(app, "/api/benchmark-results/sync", {
        items: [
          {
            id: "B_12345678",
            benchmarkId: "benchmark-mmlu",
            modelId: "model-gpt4",
            score: 0.95,
          },
        ],
      });

      expect(res.status).toBe(200);
    });
  });
});
