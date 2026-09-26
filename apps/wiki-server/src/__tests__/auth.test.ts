import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { resolveAuthMode, validateApiKey, verifyToken } from "../auth.js";

describe("validateApiKey middleware", () => {
  let savedKey: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    savedNodeEnv = process.env.NODE_ENV;
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    else process.env.LONGTERMWIKI_SERVER_API_KEY = savedKey;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
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

  describe("no key configured, NODE_ENV=production (misconfigured prod)", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "production";
    });

    it("keeps reads working so a missing secret cannot take the site down", async () => {
      const app = buildApp();
      const res = await app.request("/api/pages");
      expect(res.status).toBe(200);
    });

    it("refuses writes with 503 even with an arbitrary token", async () => {
      const app = buildApp();
      const cases: Record<string, string>[] = [{}, { Authorization: "Bearer anything" }];
      for (const headers of cases) {
        const res = await app.request("/api/pages/sync", { method: "POST", headers });
        expect(res.status).toBe(503);
      }
    });

    it("refuses PUT/PATCH/DELETE too", async () => {
      const app = new Hono();
      app.use("/api/*", validateApiKey());
      app.all("/api/x", (c) => c.json({ ok: true }));
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const res = await app.request("/api/x", { method });
        expect(res.status).toBe(503);
      }
    });

    it("once the key is set, behaves exactly like keyed mode", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      const app = buildApp();
      expect((await app.request("/api/pages")).status).toBe(401);
      const ok = await app.request("/api/pages/sync", {
        method: "POST",
        headers: { Authorization: "Bearer test-secret" },
      });
      expect(ok.status).toBe(200);
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

describe("verifyToken", () => {
  it("returns true for matching tokens", () => {
    expect(verifyToken("secret-key", "secret-key")).toBe(true);
  });

  it("returns false for mismatched tokens", () => {
    expect(verifyToken("wrong-key", "secret-key")).toBe(false);
  });

  it("returns false for different-length tokens", () => {
    expect(verifyToken("short", "much-longer-key")).toBe(false);
  });

  it("returns false for prefix match", () => {
    expect(verifyToken("secret", "secret-key")).toBe(false);
  });
});

describe("resolveAuthMode", () => {
  it("is keyed whenever a key is set, regardless of NODE_ENV", () => {
    expect(resolveAuthMode({ LONGTERMWIKI_SERVER_API_KEY: "k", NODE_ENV: "production" })).toBe("key");
    expect(resolveAuthMode({ LONGTERMWIKI_SERVER_API_KEY: "k" })).toBe("key");
  });

  it("treats an empty key as unset", () => {
    expect(resolveAuthMode({ LONGTERMWIKI_SERVER_API_KEY: "", NODE_ENV: "production" })).toBe("prod-no-key");
  });

  it("is open only outside production", () => {
    expect(resolveAuthMode({})).toBe("open-dev");
    expect(resolveAuthMode({ NODE_ENV: "development" })).toBe("open-dev");
    expect(resolveAuthMode({ NODE_ENV: "test" })).toBe("open-dev");
    expect(resolveAuthMode({ NODE_ENV: "production" })).toBe("prod-no-key");
  });
});
