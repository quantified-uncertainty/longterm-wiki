import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("search", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("searchWiki", () => {
    it("returns ok:true with empty results for empty query", async () => {
      const { searchWiki } = await import("../search");
      const result = await searchWiki("");
      expect(result).toEqual({ ok: true, results: [] });
    });

    it("returns ok:true with empty results for whitespace-only query", async () => {
      const { searchWiki } = await import("../search");
      const result = await searchWiki("   ");
      expect(result).toEqual({ ok: true, results: [] });
    });

    it("uses server search when available", async () => {
      const serverResponse = {
        results: [
          {
            id: "miri",
            numericId: "E42",
            title: "MIRI",
            description: "Machine Intelligence Research Institute",
            entityType: "organization",
            category: "organizations",
            readerImportance: 60,
            quality: 75,
            score: 1.5,
          },
        ],
        query: "miri",
        total: 1,
      };

      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(serverResponse), { status: 200 }),
      );

      const { searchWiki } = await import("../search");
      const result = await searchWiki("miri");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe("miri");
      expect(result.results[0].title).toBe("MIRI");
      expect(result.results[0].type).toBe("organization");
      expect(result.results[0].terms).toEqual(["miri"]);
      expect(result.results[0].match).toHaveProperty("miri");

      // Should have called /api/search
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/search?q=miri&limit=20",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns ok:false when server returns error", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
      );

      const { searchWiki } = await import("../search");
      const result = await searchWiki("miri");

      expect(result).toEqual({ ok: false, error: "unavailable" });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("returns ok:false when server fetch throws", async () => {
      global.fetch = vi.fn().mockRejectedValueOnce(new Error("Network error"));

      const { searchWiki } = await import("../search");
      const result = await searchWiki("miri");

      expect(result).toEqual({ ok: false, error: "unavailable" });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("synthesizes accurate match info from query terms", async () => {
      const serverResponse = {
        results: [
          {
            id: "test-page",
            numericId: "E1",
            title: "Test Page",
            description: "Some description about testing",
            entityType: "concept",
            category: null,
            readerImportance: null,
            quality: null,
            score: 2.0,
          },
        ],
        query: "test xyz",
        total: 1,
      };

      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(serverResponse), { status: 200 }),
      );

      const { searchWiki } = await import("../search");
      const result = await searchWiki("test xyz");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.results[0].terms).toEqual(["test", "xyz"]);
      // "test" appears in both title and description
      expect(result.results[0].match["test"]).toEqual(
        expect.arrayContaining(["title", "description"]),
      );
      // "xyz" doesn't appear in title or description, falls back to both
      expect(result.results[0].match["xyz"]).toEqual(["title", "description"]);
    });

    it("passes through server snippet when present", async () => {
      const serverResponse = {
        results: [
          {
            id: "anthropic",
            numericId: "E50",
            title: "Anthropic",
            description: "AI safety company founded by Dario Amodei",
            entityType: "organization",
            category: "organizations",
            readerImportance: 80,
            quality: 85,
            score: 2.5,
            snippet: "AI safety company founded by Dario <mark>Amodei</mark>",
          },
        ],
        query: "amodei",
        total: 1,
      };

      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(serverResponse), { status: 200 }),
      );

      const { searchWiki } = await import("../search");
      const result = await searchWiki("amodei");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.results).toHaveLength(1);
      expect(result.results[0].snippet).toBe(
        "AI safety company founded by Dario <mark>Amodei</mark>",
      );
    });

    it("returns undefined snippet when server sends null", async () => {
      const serverResponse = {
        results: [
          {
            id: "test",
            numericId: "E1",
            title: "Test",
            description: "A page",
            entityType: "concept",
            category: null,
            readerImportance: null,
            quality: null,
            score: 1.0,
            snippet: null,
          },
        ],
        query: "test",
        total: 1,
      };

      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(serverResponse), { status: 200 }),
      );

      const { searchWiki } = await import("../search");
      const result = await searchWiki("test");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.results[0].snippet).toBeUndefined();
    });
  });
});
