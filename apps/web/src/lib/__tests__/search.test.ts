import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

    it("skips server after circuit breaker threshold", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;

      const { searchWiki } = await import("../search");

      // Failure 1: server 503 + MiniSearch loads for the first time
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({}), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([]), { status: 200 }),
        );
      await searchWiki("q1");

      // Failure 2: server 503 (MiniSearch already loaded, no extra fetches)
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
      );
      await searchWiki("q2");

      // Failure 3: server 503 -> triggers circuit breaker (3 consecutive failures)
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
      );
      await searchWiki("q3");

      // Clear call history, then verify circuit breaker skips server
      fetchMock.mockClear();
      await searchWiki("skipped");

      // No fetch calls at all: server was skipped, MiniSearch was already loaded
      expect(fetchMock).not.toHaveBeenCalled();
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
