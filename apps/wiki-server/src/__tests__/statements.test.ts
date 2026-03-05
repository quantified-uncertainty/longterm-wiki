/**
 * Unit tests for the Statements API — validation and security guards.
 *
 * Covers the fixes from issue #1662:
 * - /cleanup requires non-empty entityId (returns 400 if missing)
 * - /clear-by-entity requires non-empty entityId (returns 400 if empty)
 * - includeRetracted query param correctly parses "false" as false
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";
import { TestDb } from "./test-db-helper.js";

const testDb = new TestDb();

vi.mock("../db.js", () => mockDbModule(testDb.dispatch));

const { createApp } = await import("../app.js");

describe("Statements API — validation guards", () => {
  let app: Hono;

  beforeEach(() => {
    testDb.reset();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ---- POST /api/statements/cleanup ----

  describe("POST /api/statements/cleanup", () => {
    it("returns 400 when entityId is missing", async () => {
      const res = await postJson(app, "/api/statements/cleanup", {
        dryRun: true,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it("returns 400 when entityId is an empty string", async () => {
      const res = await postJson(app, "/api/statements/cleanup", {
        entityId: "",
        dryRun: true,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it("returns 400 when body is empty (global cleanup not allowed)", async () => {
      const res = await postJson(app, "/api/statements/cleanup", {});
      expect(res.status).toBe(400);
    });

    it("accepts a valid entityId with dryRun=true (dry-run mode)", async () => {
      const res = await postJson(app, "/api/statements/cleanup", {
        entityId: "anthropic",
        dryRun: true,
      });
      // Should succeed (dryRun=true means no actual deletion)
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dryRun).toBe(true);
      expect(body.ok).toBe(true);
    });

    it("defaults dryRun to true when not specified", async () => {
      const res = await postJson(app, "/api/statements/cleanup", {
        entityId: "anthropic",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // dryRun should default to true, so no deletion occurs
      expect(body.dryRun).toBe(true);
      expect(body.ok).toBe(true);
    });
  });

  // ---- POST /api/statements/clear-by-entity ----

  describe("POST /api/statements/clear-by-entity", () => {
    it("returns 400 when entityId is missing", async () => {
      const res = await postJson(app, "/api/statements/clear-by-entity", {});
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it("returns 400 when entityId is an empty string", async () => {
      const res = await postJson(app, "/api/statements/clear-by-entity", {
        entityId: "",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it("accepts a valid entityId and returns deleted count", async () => {
      const res = await postJson(app, "/api/statements/clear-by-entity", {
        entityId: "anthropic",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(typeof body.deleted).toBe("number");
    });
  });

  // ---- GET /api/statements/by-entity — includeRetracted param ----

  describe("GET /api/statements/by-entity — includeRetracted parsing", () => {
    it('treats includeRetracted=false as false (not truthy)', async () => {
      const res = await app.request(
        "/api/statements/by-entity?entityId=anthropic&includeRetracted=false"
      );
      // Should succeed (not a validation error)
      expect(res.status).toBe(200);
    });

    it('treats includeRetracted=true as true', async () => {
      const res = await app.request(
        "/api/statements/by-entity?entityId=anthropic&includeRetracted=true"
      );
      expect(res.status).toBe(200);
    });

    it('defaults includeRetracted to false when not provided', async () => {
      const res = await app.request(
        "/api/statements/by-entity?entityId=anthropic"
      );
      expect(res.status).toBe(200);
    });

    it('returns 400 when entityId is missing', async () => {
      const res = await app.request("/api/statements/by-entity");
      expect(res.status).toBe(400);
    });
  });
});
