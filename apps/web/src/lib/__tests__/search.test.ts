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
    it("returns empty array for empty query", async () => {
      const { searchWiki } = await import("../search");
      const results = await searchWiki("");
      expect(results).toEqual([]);
    });

    it("returns empty array for whitespace-only query", async () => {
      const { searchWiki } = await import("../search");
      const results = await searchWiki("   ");
      expect(results).toEqual([]);
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
      const results = await searchWiki("miri");

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("miri");
      expect(results[0].title).toBe("MIRI");
      expect(results[0].type).toBe("organization");
      expect(results[0].terms).toEqual(["miri"]);
      expect(results[0].match).toHaveProperty("miri");

      // Should have called /api/search
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/search?q=miri&limit=20",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns empty array when server returns error", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
      );

      const { searchWiki } = await import("../search");
      const results = await searchWiki("miri");

      expect(results).toEqual([]);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("returns empty array when server fetch throws", async () => {
      global.fetch = vi.fn().mockRejectedValueOnce(new Error("Network error"));

      const { searchWiki } = await import("../search");
      const results = await searchWiki("miri");

      expect(results).toEqual([]);
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
      const results = await searchWiki("test xyz");

      expect(results[0].terms).toEqual(["test", "xyz"]);
      // "test" appears in both title and description
      expect(results[0].match["test"]).toEqual(
        expect.arrayContaining(["title", "description"]),
      );
      // "xyz" doesn't appear in title or description, falls back to both
      expect(results[0].match["xyz"]).toEqual(["title", "description"]);
    });
  });
});
