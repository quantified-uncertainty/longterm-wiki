import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing wiki-api
vi.mock("./config.js", () => ({
  WIKI_SERVER_URL: "https://wiki-server.test.example",
  WIKI_SERVER_API_KEY: "test-api-key-123",
}));

const {
  searchWiki,
  getPage,
  getRelatedPages,
  getEntity,
  searchEntities,
  getFacts,
  getPageCitations,
  searchResources,
  getBacklinks,
  getWikiStats,
  getRecentChanges,
  getAutoUpdateStatus,
  getCitationHealth,
  getRiskReport,
} = await import("./wiki-api.js");

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

describe("getRelatedPages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL with id and limit", async () => {
    const mockResponse = { entityId: "scheming", related: [], total: 0 };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });
    vi.stubGlobal("fetch", mockFetch);

    await getRelatedPages("scheming", 5);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/links/related/scheming");
    expect(url).toContain("limit=5");
  });

  it("returns response data on success", async () => {
    const mockResponse = {
      entityId: "scheming",
      related: [{ id: "deceptive-alignment", type: "concept", title: "Deceptive Alignment", score: 0.9 }],
      total: 1,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await getRelatedPages("scheming");
    expect(result).toEqual(mockResponse);
  });

  it("returns null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    }));

    const result = await getRelatedPages("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await getRelatedPages("test");
    expect(result).toBeNull();
  });
});

describe("getEntity", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL", async () => {
    const mockEntity = { id: "anthropic", entityType: "organization", title: "Anthropic" };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockEntity,
    });
    vi.stubGlobal("fetch", mockFetch);

    await getEntity("anthropic");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/entities/anthropic");
  });

  it("returns entity data on success", async () => {
    const mockEntity = {
      id: "anthropic",
      entityType: "organization",
      title: "Anthropic",
      description: "AI safety company",
      website: "https://anthropic.com",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockEntity,
    }));

    const result = await getEntity("anthropic");
    expect(result).toEqual(mockEntity);
  });

  it("returns null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    }));

    const result = await getEntity("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await getEntity("test");
    expect(result).toBeNull();
  });
});

describe("searchEntities", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL with query and limit", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], query: "ai labs", total: 0 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await searchEntities("ai labs", 5);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/entities/search");
    expect(url).toContain("q=ai+labs");
    expect(url).toContain("limit=5");
  });

  it("returns results on success", async () => {
    const mockResponse = {
      results: [{ id: "anthropic", entityType: "organization", title: "Anthropic" }],
      query: "anthropic",
      total: 1,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await searchEntities("anthropic");
    expect(result).toEqual(mockResponse);
  });

  it("returns null on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));

    const result = await searchEntities("test");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await searchEntities("test");
    expect(result).toBeNull();
  });
});

describe("getFacts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL with entity id", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entityId: "anthropic", facts: [], total: 0, limit: 100, offset: 0 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getFacts("anthropic");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/facts/by-entity/anthropic");
  });

  it("returns facts on success", async () => {
    const mockResponse = {
      entityId: "anthropic",
      facts: [{ id: 1, entityId: "anthropic", factId: "employees", label: "Employees", value: "~1000", numeric: 1000 }],
      total: 1,
      limit: 100,
      offset: 0,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await getFacts("anthropic");
    expect(result).toEqual(mockResponse);
  });

  it("returns null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    }));

    const result = await getFacts("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await getFacts("test");
    expect(result).toBeNull();
  });
});

describe("getPageCitations", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL with page_id query param", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ quotes: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getPageCitations("scheming");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/citations/quotes");
    expect(url).toContain("page_id=scheming");
  });

  it("returns quotes on success", async () => {
    const mockResponse = {
      quotes: [{ id: 1, pageId: "scheming", footnote: 1, claimText: "AI systems can deceive", url: "https://example.com" }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await getPageCitations("scheming");
    expect(result).toEqual(mockResponse);
  });

  it("returns null on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));

    const result = await getPageCitations("test");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await getPageCitations("test");
    expect(result).toBeNull();
  });
});

describe("searchResources", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL with query and limit", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], count: 0, query: "interpretability" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await searchResources("interpretability", 5);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/resources/search");
    expect(url).toContain("q=interpretability");
    expect(url).toContain("limit=5");
  });

  it("returns results on success", async () => {
    const mockResponse = {
      results: [{ id: "res1", url: "https://example.com", title: "Paper on Interp" }],
      count: 1,
      query: "interpretability",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await searchResources("interpretability");
    expect(result).toEqual(mockResponse);
  });

  it("returns null on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));

    const result = await searchResources("test");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await searchResources("test");
    expect(result).toBeNull();
  });
});

describe("getBacklinks", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL with id and limit", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ targetId: "rlhf", backlinks: [], total: 0 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getBacklinks("rlhf", 15);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/links/backlinks/rlhf");
    expect(url).toContain("limit=15");
  });

  it("returns backlinks on success", async () => {
    const mockResponse = {
      targetId: "rlhf",
      backlinks: [{ id: "alignment", type: "concept", title: "Alignment", linkType: "entity_link", weight: 1.0 }],
      total: 1,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await getBacklinks("rlhf");
    expect(result).toEqual(mockResponse);
  });

  it("returns null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    }));

    const result = await getBacklinks("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await getBacklinks("test");
    expect(result).toBeNull();
  });
});

describe("getWikiStats", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches both health and citation stats", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "healthy",
          database: "ok",
          totalIds: 1000,
          totalPages: 625,
          totalEntities: 200,
          totalFacts: 1500,
          nextId: 1001,
          uptime: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          totalQuotes: 3000,
          withQuotes: 2500,
          verified: 1200,
          unverified: 1300,
          totalPages: 600,
          averageScore: 0.85,
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await getWikiStats();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).not.toBeNull();
    expect(result!.health.totalPages).toBe(625);
    expect(result!.citations.totalQuotes).toBe(3000);
  });

  it("returns null if health request fails", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Error" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", mockFetch);

    const result = await getWikiStats();
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await getWikiStats();
    expect(result).toBeNull();
  });
});

describe("getRecentChanges", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL with limit", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getRecentChanges(5);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/sessions/page-changes");
    expect(url).toContain("limit=5");
  });

  it("includes since param when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getRecentChanges(10, "2026-01-01");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("since=2026-01-01");
  });

  it("returns sessions on success", async () => {
    const mockResponse = {
      sessions: [{ id: 1, date: "2026-02-21", title: "Update scheming page", pages: ["scheming"] }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await getRecentChanges();
    expect(result).toEqual(mockResponse);
  });

  it("returns null on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));

    const result = await getRecentChanges();
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await getRecentChanges();
    expect(result).toBeNull();
  });
});

describe("getAutoUpdateStatus", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL with limit", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [], total: 0, limit: 5, offset: 0 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getAutoUpdateStatus(3);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/auto-update-runs/all");
    expect(url).toContain("limit=3");
  });

  it("returns entries on success", async () => {
    const mockResponse = {
      entries: [{ id: 1, date: "2026-02-21", trigger: "scheduled", pagesUpdated: 5, newPagesCreated: [], results: [] }],
      total: 1,
      limit: 5,
      offset: 0,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await getAutoUpdateStatus();
    expect(result).toEqual(mockResponse);
  });

  it("returns null on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));

    const result = await getAutoUpdateStatus();
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await getAutoUpdateStatus();
    expect(result).toBeNull();
  });
});

describe("getCitationHealth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ broken: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getCitationHealth();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/citations/broken");
  });

  it("returns broken citations on success", async () => {
    const mockResponse = {
      broken: [{ pageId: "scheming", footnote: 1, url: "https://broken.example.com", claimText: "Some claim", verificationScore: 0.1 }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await getCitationHealth();
    expect(result).toEqual(mockResponse);
  });

  it("returns null on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));

    const result = await getCitationHealth();
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await getCitationHealth();
    expect(result).toBeNull();
  });
});

describe("getRiskReport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs correct URL with level and limit", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pages: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getRiskReport("high", 5);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/hallucination-risk/latest");
    expect(url).toContain("level=high");
    expect(url).toContain("limit=5");
  });

  it("returns risk pages on success", async () => {
    const mockResponse = {
      pages: [{ pageId: "scheming", score: 85, level: "high", factors: ["no_citations"], integrityIssues: null, computedAt: "2026-02-21" }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await getRiskReport();
    expect(result).toEqual(mockResponse);
  });

  it("defaults to high level", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pages: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getRiskReport();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("level=high");
  });

  it("returns null on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));

    const result = await getRiskReport();
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await getRiskReport();
    expect(result).toBeNull();
  });
});
