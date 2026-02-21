import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock MiniSearch before importing the search module
vi.mock("minisearch", () => {
  const mockSearch = vi.fn().mockReturnValue([]);
  const mockLoadJSON = vi.fn().mockReturnValue({
    search: mockSearch,
  });
  return {
    default: {
      loadJSON: mockLoadJSON,
    },
    __mockSearch: mockSearch,
    __mockLoadJSON: mockLoadJSON,
  };
});

describe("search", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
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

    it("falls back to MiniSearch when server returns 503", async () => {
      // First call: server returns 503
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "unavailable" }), {
            status: 503,
          }),
        )
        // MiniSearch index and docs fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({}), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([]), { status: 200 }),
        );

      const { searchWiki } = await import("../search");
      const results = await searchWiki("miri");

      // Server failed, MiniSearch loaded but returned empty (mocked)
      expect(results).toEqual([]);
      // fetch was called 3 times: server + index + docs
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it("falls back to MiniSearch when server fetch throws", async () => {
      global.fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error"))
        // MiniSearch index and docs fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({}), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([]), { status: 200 }),
        );

      const { searchWiki } = await import("../search");
      const results = await searchWiki("miri");

      expect(results).toEqual([]);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it("synthesizes match info from query terms for server results", async () => {
      const serverResponse = {
        results: [
          {
            id: "test-page",
            numericId: "E1",
            title: "Test Page",
            description: "Some description",
            entityType: "concept",
            category: null,
            readerImportance: null,
            quality: null,
            score: 2.0,
          },
        ],
        query: "test page",
        total: 1,
      };

      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(serverResponse), { status: 200 }),
      );

      const { searchWiki } = await import("../search");
      const results = await searchWiki("test page");

      expect(results[0].terms).toEqual(["test", "page"]);
      expect(results[0].match).toEqual({
        test: ["title", "description"],
        page: ["title", "description"],
      });
    });
  });

  describe("searchWikiScores", () => {
    it("returns empty map for empty query", async () => {
      // searchWikiScores always uses MiniSearch, so it will try to load the index
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({}), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([]), { status: 200 }),
        );

      const { searchWikiScores } = await import("../search");
      const scores = await searchWikiScores("");
      expect(scores.size).toBe(0);
    });
  });
});
