import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { validateApiKey } from "../auth.js";

describe("validateApiKey middleware", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    else process.env.LONGTERMWIKI_SERVER_API_KEY = savedKey;
  });

  function buildApp() {
    const app = new Hono();
    app.use("/api/*", validateApiKey());
    app.get("/api/pages", (c) => c.json({ ok: true }));
    app.post("/api/pages/sync", (c) => c.json({ ok: true }));
    return app;
  }

  describe("no key configured (dev mode)", () => {
    it("allows GET without auth", async () => {
      const app = buildApp();
      const res = await app.request("/api/pages");
      expect(res.status).toBe(200);
    });

    it("allows POST without auth", async () => {
      const app = buildApp();
      const res = await app.request("/api/pages/sync", { method: "POST" });
      expect(res.status).toBe(200);
    });
  });

  describe("key configured", () => {
    beforeEach(() => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
    });

    it("allows GET with correct key", async () => {
      const app = buildApp();
      const res = await app.request("/api/pages", {
        headers: { Authorization: "Bearer test-secret" },
      });
      expect(res.status).toBe(200);
    });

    it("allows POST with correct key", async () => {
      const app = buildApp();
      const res = await app.request("/api/pages/sync", {
        method: "POST",
        headers: { Authorization: "Bearer test-secret" },
      });
      expect(res.status).toBe(200);
    });

    it("rejects requests without token", async () => {
      const app = buildApp();
      const res = await app.request("/api/pages");
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const app = buildApp();
      const res = await app.request("/api/pages", {
        headers: { Authorization: "Bearer wrong-key" },
      });
      expect(res.status).toBe(401);
    });
  });
});
