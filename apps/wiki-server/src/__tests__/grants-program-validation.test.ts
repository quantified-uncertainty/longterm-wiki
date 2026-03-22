import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores simulating Postgres ----

let fundingProgramsStore: Map<string, Record<string, unknown>>;
let grantsStore: Map<string, Record<string, unknown>>;
let entitiesStore: Map<string, Record<string, unknown>>;

function resetStores() {
  fundingProgramsStore = new Map();
  grantsStore = new Map();
  entitiesStore = new Map();
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- funding_programs: SELECT id FROM funding_programs WHERE id IN (...) ---
  // Drizzle generates: select "id" from "funding_programs" where "id" in ($1, $2, ...)
  if (
    q.includes('"funding_programs"') &&
    q.includes("select") &&
    q.includes("where") &&
    q.includes(" in ")
  ) {
    return params
      .filter((p) => fundingProgramsStore.has(p as string))
      .map((p) => ({ id: p }));
  }

  // --- grants: INSERT ... ON CONFLICT DO UPDATE ---
  if (q.includes("insert into") && q.includes('"grants"')) {
    return [];
  }

  // --- grants: UPDATE ... SET program_id ---
  if (q.includes("update") && q.includes("grants") && q.includes("program_id")) {
    return [];
  }

  // --- things: INSERT ---
  if (q.includes("insert into") && q.includes('"things"')) {
    return [];
  }

  // --- things: UPDATE (touch updatedAt) ---
  if (q.includes("update") && q.includes('"things"')) {
    return [];
  }

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

  return [];
}

// Mock the db module
vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Helpers ----

function seedFundingProgram(id: string) {
  fundingProgramsStore.set(id, {
    id,
    org_id: "org-test",
    name: `Program ${id}`,
    program_type: "grant-round",
    synced_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  });
}

function patchJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---- Tests ----

describe("Grants programId validation", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ---- POST /sync ----

  describe("POST /api/grants/sync", () => {
    it("accepts grants with null programId", async () => {
      const res = await postJson(app, "/api/grants/sync", {
        items: [
          {
            id: "G_12345678",
            organizationId: "org-test",
            name: "Test Grant",
            programId: null,
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("accepts grants when programId exists in funding_programs", async () => {
      seedFundingProgram("FP_ABC12345");

      const res = await postJson(app, "/api/grants/sync", {
        items: [
          {
            id: "G_12345678",
            organizationId: "org-test",
            name: "Test Grant",
            programId: "FP_ABC12345",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("rejects grants when programId does not exist in funding_programs", async () => {
      const res = await postJson(app, "/api/grants/sync", {
        items: [
          {
            id: "G_12345678",
            organizationId: "org-test",
            name: "Test Grant",
            programId: "NONEXIST01",
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
      expect(body.message).toContain("programId");
      expect(body.message).toContain("NONEXIST01");
    });

    it("reports all invalid programIds in one error", async () => {
      seedFundingProgram("FP_VALID001");

      const res = await postJson(app, "/api/grants/sync", {
        items: [
          {
            id: "G_00000001",
            organizationId: "org-test",
            name: "Grant 1",
            programId: "INVALID_01",
          },
          {
            id: "G_00000002",
            organizationId: "org-test",
            name: "Grant 2",
            programId: "FP_VALID001",
          },
          {
            id: "G_00000003",
            organizationId: "org-test",
            name: "Grant 3",
            programId: "INVALID_02",
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("INVALID_01");
      expect(body.message).toContain("INVALID_02");
      expect(body.message).not.toContain("FP_VALID001");
    });

    it("skips validation when skipEntityValidation=true", async () => {
      const res = await postJson(
        app,
        "/api/grants/sync?skipEntityValidation=true",
        {
          items: [
            {
              id: "G_12345678",
              organizationId: "org-test",
              name: "Test Grant",
              programId: "NONEXIST01",
            },
          ],
        },
      );

      expect(res.status).toBe(200);
    });

    it("accepts grants without programId field", async () => {
      const res = await postJson(app, "/api/grants/sync", {
        items: [
          {
            id: "G_12345678",
            organizationId: "org-test",
            name: "Test Grant",
          },
        ],
      });

      expect(res.status).toBe(200);
    });
  });

  // ---- PATCH /batch-update-program ----

  describe("PATCH /api/grants/batch-update-program", () => {
    it("accepts when all programIds exist in funding_programs", async () => {
      seedFundingProgram("FP_PROG0001");
      seedFundingProgram("FP_PROG0002");

      const res = await patchJson(app, "/api/grants/batch-update-program", {
        items: [
          { id: "G_00000001", programId: "FP_PROG0001" },
          { id: "G_00000002", programId: "FP_PROG0002" },
        ],
      });

      expect(res.status).toBe(200);
    });

    it("rejects when programId does not exist in funding_programs", async () => {
      seedFundingProgram("FP_PROG0001");

      const res = await patchJson(app, "/api/grants/batch-update-program", {
        items: [
          { id: "G_00000001", programId: "FP_PROG0001" },
          { id: "G_00000002", programId: "NONEXIST01" },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
      expect(body.message).toContain("NONEXIST01");
      expect(body.message).not.toContain("FP_PROG0001");
    });

    it("skips validation when skipEntityValidation=true", async () => {
      const res = await patchJson(
        app,
        "/api/grants/batch-update-program?skipEntityValidation=true",
        {
          items: [
            { id: "G_00000001", programId: "NONEXIST01" },
          ],
        },
      );

      expect(res.status).toBe(200);
    });

    it("deduplicates programIds for validation", async () => {
      seedFundingProgram("FP_PROG0001");

      const res = await patchJson(app, "/api/grants/batch-update-program", {
        items: [
          { id: "G_00000001", programId: "FP_PROG0001" },
          { id: "G_00000002", programId: "FP_PROG0001" },
          { id: "G_00000003", programId: "FP_PROG0001" },
        ],
      });

      expect(res.status).toBe(200);
    });
  });
});
