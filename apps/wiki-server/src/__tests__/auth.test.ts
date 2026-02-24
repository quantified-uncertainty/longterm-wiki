import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { validateApiKey, requireWriteScope, resolveScopes, type ApiScope } from "../auth.js";

// ---------------------------------------------------------------------------
// resolveScopes unit tests
// ---------------------------------------------------------------------------

describe("resolveScopes", () => {
  it("returns all scopes for legacy superkey", () => {
    const scopes = resolveScopes("super-secret", {
      legacyKey: "super-secret",
      projectKey: "proj-key",
      contentKey: "content-key",
    });
    expect(scopes).toEqual(["project", "content"]);
  });

  it("returns project scope for project key", () => {
    const scopes = resolveScopes("proj-key", {
      legacyKey: "super-secret",
      projectKey: "proj-key",
      contentKey: "content-key",
    });
    expect(scopes).toEqual(["project"]);
  });

  it("returns content scope for content key", () => {
    const scopes = resolveScopes("content-key", {
      legacyKey: "super-secret",
      projectKey: "proj-key",
      contentKey: "content-key",
    });
    expect(scopes).toEqual(["content"]);
  });

  it("returns empty array for unknown token", () => {
    const scopes = resolveScopes("wrong-key", {
      legacyKey: "super-secret",
      projectKey: "proj-key",
      contentKey: "content-key",
    });
    expect(scopes).toEqual([]);
  });

  it("returns empty array when no keys configured", () => {
    const scopes = resolveScopes("any-token", {});
    expect(scopes).toEqual([]);
  });

  it("handles only legacy key configured", () => {
    const scopes = resolveScopes("legacy", { legacyKey: "legacy" });
    expect(scopes).toEqual(["project", "content"]);
  });

  it("handles only project key configured", () => {
    const scopes = resolveScopes("proj", { projectKey: "proj" });
    expect(scopes).toEqual(["project"]);
  });
});

// ---------------------------------------------------------------------------
// Middleware integration tests with a tiny Hono app
// ---------------------------------------------------------------------------

describe("scoped auth middleware", () => {
  const envBackup: Record<string, string | undefined> = {};

  function saveEnv(...keys: string[]) {
    for (const k of keys) envBackup[k] = process.env[k];
  }
  function restoreEnv() {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(() => {
    saveEnv(
      "LONGTERMWIKI_SERVER_API_KEY",
      "LONGTERMWIKI_PROJECT_KEY",
      "LONGTERMWIKI_CONTENT_KEY"
    );
    // Clear all keys before each test
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    delete process.env.LONGTERMWIKI_PROJECT_KEY;
    delete process.env.LONGTERMWIKI_CONTENT_KEY;
  });

  afterEach(() => {
    restoreEnv();
  });

  function buildApp() {
    const app = new Hono();

    app.use("/api/*", validateApiKey());
    app.use("/api/pages/*", requireWriteScope("content"));
    app.use("/api/ids/*", requireWriteScope("project"));

    app.get("/api/pages", (c) => c.json({ ok: true }));
    app.post("/api/pages/sync", (c) => c.json({ ok: true }));
    app.get("/api/ids", (c) => c.json({ ok: true }));
    app.post("/api/ids/allocate", (c) => c.json({ ok: true }));

    return app;
  }

  describe("no keys configured (dev mode)", () => {
    it("allows all requests without auth", async () => {
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

  describe("legacy superkey", () => {
    beforeEach(() => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "super-secret";
    });

    it("allows GET with superkey", async () => {
      const app = buildApp();
      const res = await app.request("/api/pages", {
        headers: { Authorization: "Bearer super-secret" },
      });
      expect(res.status).toBe(200);
    });

    it("allows content POST with superkey", async () => {
      const app = buildApp();
      const res = await app.request("/api/pages/sync", {
        method: "POST",
        headers: { Authorization: "Bearer super-secret" },
      });
      expect(res.status).toBe(200);
    });

    it("allows project POST with superkey", async () => {
      const app = buildApp();
      const res = await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { Authorization: "Bearer super-secret" },
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

  describe("scoped keys", () => {
    beforeEach(() => {
      process.env.LONGTERMWIKI_PROJECT_KEY = "proj-key";
      process.env.LONGTERMWIKI_CONTENT_KEY = "content-key";
    });

    it("project key: allows GET on content routes (reads are universal)", async () => {
      const app = buildApp();
      const res = await app.request("/api/pages", {
        headers: { Authorization: "Bearer proj-key" },
      });
      expect(res.status).toBe(200);
    });

    it("project key: blocks POST on content routes", async () => {
      const app = buildApp();
      const res = await app.request("/api/pages/sync", {
        method: "POST",
        headers: { Authorization: "Bearer proj-key" },
      });
      expect(res.status).toBe(403);
    });

    it("project key: allows POST on project routes", async () => {
      const app = buildApp();
      const res = await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { Authorization: "Bearer proj-key" },
      });
      expect(res.status).toBe(200);
    });

    it("content key: allows POST on content routes", async () => {
      const app = buildApp();
      const res = await app.request("/api/pages/sync", {
        method: "POST",
        headers: { Authorization: "Bearer content-key" },
      });
      expect(res.status).toBe(200);
    });

    it("content key: blocks POST on project routes", async () => {
      const app = buildApp();
      const res = await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { Authorization: "Bearer content-key" },
      });
      expect(res.status).toBe(403);
    });

    it("content key: allows GET on project routes (reads are universal)", async () => {
      const app = buildApp();
      const res = await app.request("/api/ids", {
        headers: { Authorization: "Bearer content-key" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("mixed: legacy + scoped keys", () => {
    beforeEach(() => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "super-secret";
      process.env.LONGTERMWIKI_PROJECT_KEY = "proj-key";
      process.env.LONGTERMWIKI_CONTENT_KEY = "content-key";
    });

    it("superkey still works for all routes", async () => {
      const app = buildApp();

      const res1 = await app.request("/api/pages/sync", {
        method: "POST",
        headers: { Authorization: "Bearer super-secret" },
      });
      expect(res1.status).toBe(200);

      const res2 = await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { Authorization: "Bearer super-secret" },
      });
      expect(res2.status).toBe(200);
    });

    it("scoped keys still enforce their scope", async () => {
      const app = buildApp();

      const res = await app.request("/api/pages/sync", {
        method: "POST",
        headers: { Authorization: "Bearer proj-key" },
      });
      expect(res.status).toBe(403);
    });
  });
});
