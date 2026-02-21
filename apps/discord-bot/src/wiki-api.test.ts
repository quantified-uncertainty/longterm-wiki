import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing wiki-api
vi.mock("./config.js", () => ({
  WIKI_SERVER_URL: "https://wiki-server.test.example",
  WIKI_SERVER_API_KEY: "test-api-key-123",
}));

const { searchWiki, getPage } = await import("./wiki-api.js");

describe("searchWiki", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL with query and limit", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], query: "test", total: 0 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await searchWiki("scheming", 5);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/pages/search");
    expect(url).toContain("q=scheming");
    expect(url).toContain("limit=5");
    expect(options.headers["Authorization"]).toBe("Bearer test-api-key-123");
  });

  it("returns results on success", async () => {
    const mockResults = [
      { id: "scheming", title: "Scheming", score: 1.5 },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: mockResults, query: "scheming", total: 1 }),
      })
    );

    const results = await searchWiki("scheming");
    expect(results).toEqual(mockResults);
  });

  it("returns empty array on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    const results = await searchWiki("test");
    expect(results).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error"))
    );

    const results = await searchWiki("test");
    expect(results).toEqual([]);
  });
});

describe("getPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL with page ID", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "scheming", title: "Scheming" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getPage("scheming");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/pages/scheming");
    expect(options.headers["Authorization"]).toBe("Bearer test-api-key-123");
  });

  it("encodes special characters in page ID", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "test page", title: "Test" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getPage("test page");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/pages/test%20page");
  });

  it("returns page data on success", async () => {
    const mockPage = {
      id: "scheming",
      title: "Scheming",
      contentPlaintext: "Content here",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockPage,
      })
    );

    const page = await getPage("scheming");
    expect(page).toEqual(mockPage);
  });

  it("returns null on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      })
    );

    const page = await getPage("nonexistent");
    expect(page).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    const page = await getPage("test");
    expect(page).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error"))
    );

    const page = await getPage("test");
    expect(page).toBeNull();
  });
});
