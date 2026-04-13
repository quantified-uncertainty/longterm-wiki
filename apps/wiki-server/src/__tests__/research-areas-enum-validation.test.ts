import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- Dispatcher ----
//
// All tests in this file exercise Zod schema rejection, which happens
// BEFORE any SQL is dispatched. A no-op dispatcher is sufficient.

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // validateEntityRefs runs: SELECT ... FROM entities WHERE id = ANY(...)
  // (via unnest). Return every requested id as "present" so the accept-path
  // tests get past validation.
  if (q.includes("unnest") && q.includes("from entities")) {
    return (params as unknown[]).map((p) => ({ ref: p }));
  }

  // Everything else (inserts, upserts) — no-op.
  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

describe("Research areas — CHECK constraint enum enforcement (QUA-283)", () => {
  let app: Hono;

  beforeEach(() => {
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ---- SyncOrgLinkSchema.role ----

  describe("POST /api/research-areas/sync-organizations", () => {
    it("rejects role values outside the CHECK enum with 400", async () => {
      // 'partially-addresses' is NOT in the CHECK list
      // ('pioneer', 'active', 'major', 'funder', 'emerging').
      // Pre-fix this passed Zod and exploded at the DB with a 500.
      const res = await postJson(app, "/api/research-areas/sync-organizations", {
        items: [
          {
            researchAreaId: "mech-interp",
            organizationId: "org-test",
            role: "partially-addresses",
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
      // Zod enum rejection messages include allowed values; just confirm
      // one of them is cited so future drift in the message format doesn't
      // silently pass this test.
      expect(body.message).toMatch(/pioneer|active|major|funder|emerging/);
    });

    it("accepts every valid role value at the schema level", async () => {
      // The DB dispatcher is a no-op, so a successful run through Zod +
      // entity-ref + insert returns 200. If any of these role values got
      // rejected by the new z.enum this test would fail with 400.
      for (const role of ["pioneer", "active", "major", "funder", "emerging"]) {
        const res = await postJson(
          app,
          "/api/research-areas/sync-organizations",
          {
            items: [
              {
                researchAreaId: "mech-interp",
                organizationId: "org-test",
                role,
              },
            ],
          },
        );
        expect(res.status, `role=${role}`).toBe(200);
      }
    });
  });

  // ---- SyncRiskLinkSchema.relevance ----

  describe("POST /api/research-areas/sync-risks — relevance", () => {
    it("rejects relevance values outside the CHECK enum with 400", async () => {
      const res = await postJson(app, "/api/research-areas/sync-risks", {
        items: [
          {
            researchAreaId: "mech-interp",
            riskId: "misalignment",
            relevance: "partially-addresses",
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
      expect(body.message).toMatch(/addresses|studies|exacerbates/);
    });

    it("accepts every valid relevance value", async () => {
      for (const relevance of ["addresses", "studies", "exacerbates"]) {
        const res = await postJson(app, "/api/research-areas/sync-risks", {
          items: [
            {
              researchAreaId: "mech-interp",
              riskId: "misalignment",
              relevance,
            },
          ],
        });
        expect(res.status, `relevance=${relevance}`).toBe(200);
      }
    });
  });

  // ---- SyncRiskLinkSchema.effectiveness ----

  describe("POST /api/research-areas/sync-risks — effectiveness", () => {
    it("rejects effectiveness values outside the CHECK enum with 400", async () => {
      const res = await postJson(app, "/api/research-areas/sync-risks", {
        items: [
          {
            researchAreaId: "mech-interp",
            riskId: "misalignment",
            effectiveness: "stellar",
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
      expect(body.message).toMatch(/high|moderate|low|uncertain/);
    });

    it("accepts null effectiveness (nullable optional)", async () => {
      const res = await postJson(app, "/api/research-areas/sync-risks", {
        items: [
          {
            researchAreaId: "mech-interp",
            riskId: "misalignment",
            effectiveness: null,
          },
        ],
      });
      expect(res.status).toBe(200);
    });

    it("accepts every valid effectiveness value", async () => {
      for (const effectiveness of ["high", "moderate", "low", "uncertain"]) {
        const res = await postJson(app, "/api/research-areas/sync-risks", {
          items: [
            {
              researchAreaId: "mech-interp",
              riskId: "misalignment",
              effectiveness,
            },
          ],
        });
        expect(res.status, `effectiveness=${effectiveness}`).toBe(200);
      }
    });
  });
});
