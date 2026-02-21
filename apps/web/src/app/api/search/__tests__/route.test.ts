import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "../route";
import { NextRequest } from "next/server";

describe("GET /api/search", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3100";
    process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns empty results for missing query", async () => {
    const req = new NextRequest("http://localhost:3001/api/search");
    const res = await GET(req);
    const data = await res.json();
    expect(data).toEqual({ results: [], query: "", total: 0 });
  });

  it("returns empty results for empty query", async () => {
    const req = new NextRequest("http://localhost:3001/api/search?q=");
    const res = await GET(req);
    const data = await res.json();
    expect(data).toEqual({ results: [], query: "", total: 0 });
  });

  it("returns 503 when LONGTERMWIKI_SERVER_URL is not set", async () => {
    delete process.env.LONGTERMWIKI_SERVER_URL;
    const req = new NextRequest("http://localhost:3001/api/search?q=miri");
    const res = await GET(req);
    expect(res.status).toBe(503);
  });

  it("proxies search to wiki-server", async () => {
    const serverResponse = {
      results: [{ id: "miri", title: "MIRI", score: 1.5 }],
      query: "miri",
      total: 1,
    };

    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(serverResponse), { status: 200 }),
    );

    const req = new NextRequest("http://localhost:3001/api/search?q=miri&limit=10");
    const res = await GET(req);
    const data = await res.json();

    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("miri");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3100/api/pages/search?q=miri&limit=10",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-key" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns 503 when wiki-server is unreachable", async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const req = new NextRequest("http://localhost:3001/api/search?q=miri");
    const res = await GET(req);
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe("Wiki server unreachable");
  });

  it("returns 503 when wiki-server returns non-OK status", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const req = new NextRequest("http://localhost:3001/api/search?q=miri");
    const res = await GET(req);
    expect(res.status).toBe(503);
  });

  it("sends API key as Bearer token", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [], query: "x", total: 0 }), { status: 200 }),
    );

    const req = new NextRequest("http://localhost:3001/api/search?q=test");
    await GET(req);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer test-key" },
      }),
    );
  });

  it("works without API key", async () => {
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [], query: "x", total: 0 }), { status: 200 }),
    );

    const req = new NextRequest("http://localhost:3001/api/search?q=test");
    await GET(req);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {},
      }),
    );
  });
});
