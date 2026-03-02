import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

// The github-issues route doesn't use the database, but the app
// still calls getDrizzleDb() for other mounted routes. Mock the db module
// minimally so createApp() doesn't crash.
vi.mock("../db.js", async () => {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("../schema.js");
  const { createBaseMockSql } = await import("./test-utils.js");
  const mockSql = createBaseMockSql((query) => {
    const q = query.toLowerCase();
    if (q.includes("count(*)") && q.includes("entity_ids")) return [{ count: 0 }];
    if (q.includes("last_value")) return [{ last_value: 0, is_called: false }];
    return [];
  });
  const mockDrizzle = drizzle(mockSql, { schema });
  return {
    getDb: () => mockSql,
    getDrizzleDb: () => mockDrizzle,
    initDb: vi.fn(),
    closeDb: vi.fn(),
  };
});

const { createApp } = await import("../app.js");

describe("GitHub Issues API", () => {
  let app: Hono;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    process.env.GITHUB_TOKEN = "test-gh-token";
    app = createApp();
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.GITHUB_TOKEN;
  });

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  describe("input validation", () => {
    it("returns 400 when numbers param is missing", async () => {
      const res = await app.request("/api/github/issues");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/numbers/i);
    });

    it("returns 400 when numbers param is empty string", async () => {
      const res = await app.request("/api/github/issues?numbers=");
      expect(res.status).toBe(400);
    });

    it("returns 400 when all numbers are invalid", async () => {
      const res = await app.request("/api/github/issues?numbers=abc,xyz,NaN");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no valid/i);
    });

    it("returns 400 when negative numbers are provided", async () => {
      const res = await app.request("/api/github/issues?numbers=-1,-5");
      expect(res.status).toBe(400);
    });

    it("returns 400 when more than 50 issues requested", async () => {
      const numbers = Array.from({ length: 51 }, (_, i) => i + 1).join(",");
      const res = await app.request(`/api/github/issues?numbers=${numbers}`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/maximum 50/i);
    });

    it("accepts exactly 50 issues", async () => {
      const numbers = Array.from({ length: 50 }, (_, i) => i + 1).join(",");
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({
          number: 1, title: "Test", state: "open",
          labels: [], created_at: "2026-01-01T00:00:00Z", closed_at: null,
        }), { status: 200 })
      );

      const res = await app.request(`/api/github/issues?numbers=${numbers}`);
      expect(res.status).toBe(200);
    });

    it("filters out invalid numbers and keeps valid ones", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({
          number: 42, title: "Valid Issue", state: "open",
          labels: [], created_at: "2026-01-01T00:00:00Z", closed_at: null,
        }), { status: 200 })
      );

      const res = await app.request("/api/github/issues?numbers=abc,42,xyz");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.issues).toHaveLength(1);
      expect(body.issues[0].number).toBe(42);
    });

    it("trims whitespace around numbers", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({
          number: 7, title: "Trimmed", state: "open",
          labels: [], created_at: "2026-01-01T00:00:00Z", closed_at: null,
        }), { status: 200 })
      );

      const res = await app.request("/api/github/issues?numbers=%207%20,%2010%20");
      expect(res.status).toBe(200);
      // fetch should have been called for 7 and 10
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // GITHUB_TOKEN handling
  // ---------------------------------------------------------------------------

  describe("GITHUB_TOKEN", () => {
    it("returns 500 when GITHUB_TOKEN is not set", async () => {
      delete process.env.GITHUB_TOKEN;
      const res = await app.request("/api/github/issues?numbers=1");
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/GITHUB_TOKEN/);
    });

    it("uses Bearer token in Authorization header", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({
          number: 1, title: "Test", state: "open",
          labels: [], created_at: "2026-01-01T00:00:00Z", closed_at: null,
        }), { status: 200 })
      );

      await app.request("/api/github/issues?numbers=1");

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/repos/quantified-uncertainty/longterm-wiki/issues/1"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-gh-token",
            Accept: "application/vnd.github.v3+json",
          }),
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Successful responses
  // ---------------------------------------------------------------------------

  describe("successful fetch", () => {
    it("returns issue data with correct shape", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({
          number: 42,
          title: "Fix the widget",
          state: "open",
          labels: [{ name: "bug" }, { name: "priority:high" }],
          created_at: "2026-01-15T10:30:00Z",
          closed_at: null,
        }), { status: 200 })
      );

      const res = await app.request("/api/github/issues?numbers=42");
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.issues).toHaveLength(1);
      const issue = body.issues[0];
      expect(issue.number).toBe(42);
      expect(issue.title).toBe("Fix the widget");
      expect(issue.state).toBe("open");
      expect(issue.labels).toEqual(["bug", "priority:high"]);
      expect(issue.created_at).toBe("2026-01-15T10:30:00Z");
      expect(issue.closed_at).toBeNull();
    });

    it("includes pull_request field when present", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({
          number: 100,
          title: "Add feature",
          state: "closed",
          labels: [],
          created_at: "2026-01-10T00:00:00Z",
          closed_at: "2026-01-20T00:00:00Z",
          pull_request: { url: "https://api.github.com/repos/test/repo/pulls/100" },
        }), { status: 200 })
      );

      const res = await app.request("/api/github/issues?numbers=100");
      const body = await res.json();
      expect(body.issues[0].pull_request).toBeDefined();
      expect(body.issues[0].pull_request.url).toContain("pulls/100");
    });

    it("omits pull_request field when not present", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({
          number: 99,
          title: "Just an issue",
          state: "open",
          labels: [],
          created_at: "2026-01-01T00:00:00Z",
          closed_at: null,
        }), { status: 200 })
      );

      const res = await app.request("/api/github/issues?numbers=99");
      const body = await res.json();
      expect(body.issues[0].pull_request).toBeUndefined();
    });

    it("fetches multiple issues in parallel", async () => {
      fetchSpy.mockImplementation((url: any) => {
        const num = parseInt(url.toString().match(/\/issues\/(\d+)/)?.[1] || "0");
        return Promise.resolve(
          new Response(JSON.stringify({
            number: num,
            title: `Issue #${num}`,
            state: num % 2 === 0 ? "closed" : "open",
            labels: [],
            created_at: "2026-01-01T00:00:00Z",
            closed_at: num % 2 === 0 ? "2026-02-01T00:00:00Z" : null,
          }), { status: 200 })
        );
      });

      const res = await app.request("/api/github/issues?numbers=1,2,3");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.issues).toHaveLength(3);
      expect(body.issues[0].number).toBe(1);
      expect(body.issues[1].number).toBe(2);
      expect(body.issues[2].number).toBe(3);
      expect(body.issues[0].state).toBe("open");
      expect(body.issues[1].state).toBe("closed");
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling (graceful degradation)
  // ---------------------------------------------------------------------------

  describe("error handling", () => {
    it("returns fallback data when GitHub API returns 404", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
      );

      const res = await app.request("/api/github/issues?numbers=999");
      expect(res.status).toBe(200); // still 200 — graceful degradation
      const body = await res.json();
      expect(body.issues[0].number).toBe(999);
      expect(body.issues[0].state).toBe("unknown");
      expect(body.issues[0].title).toContain("not found");
    });

    it("returns fallback data when fetch throws (network error)", async () => {
      fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

      const res = await app.request("/api/github/issues?numbers=1");
      expect(res.status).toBe(200); // graceful degradation
      const body = await res.json();
      expect(body.issues[0].number).toBe(1);
      expect(body.issues[0].state).toBe("unknown");
      expect(body.issues[0].title).toContain("fetch error");
    });

    it("handles mixed success and failure per issue", async () => {
      fetchSpy.mockImplementation((url: any) => {
        const num = parseInt(url.toString().match(/\/issues\/(\d+)/)?.[1] || "0");
        if (num === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({
              number: 1, title: "Success Issue", state: "open",
              labels: [], created_at: "2026-01-01T00:00:00Z", closed_at: null,
            }), { status: 200 })
          );
        }
        // Issue #2 fails
        return Promise.resolve(
          new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
        );
      });

      const res = await app.request("/api/github/issues?numbers=1,2");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.issues).toHaveLength(2);
      expect(body.issues[0].title).toBe("Success Issue");
      expect(body.issues[1].state).toBe("unknown");
    });

    it("returns fallback data when GitHub returns 403 (rate limited)", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 })
      );

      const res = await app.request("/api/github/issues?numbers=1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.issues[0].state).toBe("unknown");
      expect(body.issues[0].title).toContain("not found");
    });
  });
});
