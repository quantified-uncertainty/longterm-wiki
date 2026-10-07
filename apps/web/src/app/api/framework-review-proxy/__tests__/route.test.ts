import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../route";

const BASE = "http://localhost:3001/api/framework-review-proxy";

function post(path: string, init: { headers?: Record<string, string> } = {}) {
  return new NextRequest(`${BASE}?path=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify({ verdict: "false_positive" }),
  });
}

describe("/api/framework-review-proxy", () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.LONGTERMWIKI_SERVER_URL = "http://wiki-server.test";
    process.env.LONGTERMWIKI_SERVER_API_KEY = "server-key";
    delete process.env.LONGTERMWIKI_ADMIN_WRITE_TOKEN;
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  describe("POST (writes)", () => {
    it("refuses every write when no admin token is configured, without calling upstream", async () => {
      const res = await POST(post("diff/abc", { headers: { "x-lw-admin-token": "anything" } }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("writes_disabled");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses an anonymous write when a token is configured", async () => {
      process.env.LONGTERMWIKI_ADMIN_WRITE_TOKEN = "admin-secret";
      const res = await POST(post("version/v1/publish"));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("forbidden");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a wrong token, including one of a different length", async () => {
      process.env.LONGTERMWIKI_ADMIN_WRITE_TOKEN = "admin-secret";
      for (const t of ["admin-secreX", "a", "admin-secret-longer"]) {
        const res = await POST(post("threshold/t1", { headers: { "x-lw-admin-token": t } }));
        expect(res.status).toBe(403);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a non-JSON body even with a valid cookie (cross-site form CSRF)", async () => {
      process.env.LONGTERMWIKI_ADMIN_WRITE_TOKEN = "admin-secret";
      const req = new NextRequest(`${BASE}?path=diff/abc`, {
        method: "POST",
        headers: { "content-type": "text/plain", cookie: "lw_admin_token=admin-secret" },
        body: "{}",
      });
      const res = await POST(req);
      expect(res.status).toBe(415);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("forwards with the server key when the header token matches", async () => {
      process.env.LONGTERMWIKI_ADMIN_WRITE_TOKEN = "admin-secret";
      const res = await POST(post("diff/abc", { headers: { "x-lw-admin-token": "admin-secret" } }));
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://wiki-server.test/api/framework-review/diff/abc");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer server-key");
    });

    it("accepts the token from the lw_admin_token cookie", async () => {
      process.env.LONGTERMWIKI_ADMIN_WRITE_TOKEN = "admin-secret";
      const res = await POST(post("threshold/t1", { headers: { cookie: "lw_admin_token=admin-secret" } }));
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("still rejects unknown paths after auth", async () => {
      process.env.LONGTERMWIKI_ADMIN_WRITE_TOKEN = "admin-secret";
      const res = await POST(post("../pages/sync", { headers: { "x-lw-admin-token": "admin-secret" } }));
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("GET (reads)", () => {
    it("stays open without a token", async () => {
      const res = await GET(new NextRequest(`${BASE}?path=stats`));
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
