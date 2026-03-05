import { describe, it, expect, vi } from "vitest";
import {
  computeCitationHealth,
  type CitationQuote,
} from "../citation-data";
import { isSafeUrl } from "../../components/wiki/resource-utils";

function makeQuote(overrides: Partial<CitationQuote> = {}): CitationQuote {
  return {
    footnote: 1,
    url: "https://example.com",
    resourceId: null,
    claimText: "Test claim",
    sourceQuote: null,
    sourceTitle: null,
    sourceType: null,
    quoteVerified: false,
    verificationScore: null,
    verifiedAt: null,
    accuracyVerdict: null,
    accuracyScore: null,
    accuracyIssues: null,
    accuracySupportingQuotes: null,
    verificationDifficulty: null,
    accuracyCheckedAt: null,
    ...overrides,
  };
}

describe("computeCitationHealth", () => {
  it("returns zeros for empty array", () => {
    const health = computeCitationHealth([]);
    expect(health).toEqual({
      total: 0,
      verified: 0,
      accurate: 0,
      inaccurate: 0,
      unsupported: 0,
      minorIssues: 0,
      unchecked: 0,
    });
  });

  it("counts accurate citations", () => {
    const quotes = [
      makeQuote({ footnote: 1, accuracyVerdict: "accurate" }),
      makeQuote({ footnote: 2, accuracyVerdict: "accurate" }),
    ];
    const health = computeCitationHealth(quotes);
    expect(health.accurate).toBe(2);
    expect(health.total).toBe(2);
    expect(health.unchecked).toBe(0);
  });

  it("counts inaccurate and unsupported citations", () => {
    const quotes = [
      makeQuote({ footnote: 1, accuracyVerdict: "inaccurate" }),
      makeQuote({ footnote: 2, accuracyVerdict: "unsupported" }),
      makeQuote({ footnote: 3, accuracyVerdict: "accurate" }),
    ];
    const health = computeCitationHealth(quotes);
    expect(health.inaccurate).toBe(1);
    expect(health.unsupported).toBe(1);
    expect(health.accurate).toBe(1);
  });

  it("counts minor_issues citations", () => {
    const quotes = [
      makeQuote({ footnote: 1, accuracyVerdict: "minor_issues" }),
    ];
    const health = computeCitationHealth(quotes);
    expect(health.minorIssues).toBe(1);
  });

  it("counts verified-only citations (no accuracy verdict)", () => {
    const quotes = [
      makeQuote({ footnote: 1, quoteVerified: true }),
      makeQuote({ footnote: 2, quoteVerified: true }),
    ];
    const health = computeCitationHealth(quotes);
    expect(health.verified).toBe(2);
    expect(health.unchecked).toBe(0);
  });

  it("counts unchecked citations", () => {
    const quotes = [
      makeQuote({ footnote: 1 }),
      makeQuote({ footnote: 2 }),
    ];
    const health = computeCitationHealth(quotes);
    expect(health.unchecked).toBe(2);
    expect(health.total).toBe(2);
  });

  it("handles mixed statuses correctly", () => {
    const quotes = [
      makeQuote({ footnote: 1, accuracyVerdict: "accurate" }),
      makeQuote({ footnote: 2, accuracyVerdict: "inaccurate" }),
      makeQuote({ footnote: 3, accuracyVerdict: "minor_issues" }),
      makeQuote({ footnote: 4, quoteVerified: true }),
      makeQuote({ footnote: 5 }), // unchecked
    ];
    const health = computeCitationHealth(quotes);
    expect(health).toEqual({
      total: 5,
      accurate: 1,
      inaccurate: 1,
      unsupported: 0,
      minorIssues: 1,
      verified: 1,
      unchecked: 1,
    });
  });

  it("accuracy verdict takes precedence over quoteVerified", () => {
    const quotes = [
      makeQuote({
        footnote: 1,
        quoteVerified: true,
        accuracyVerdict: "accurate",
      }),
    ];
    const health = computeCitationHealth(quotes);
    expect(health.accurate).toBe(1);
    expect(health.verified).toBe(0); // not double-counted
  });
});

/** Shared mock setup for getCitationQuotes and getCitationQuotesByUrl tests */
function mockCitationDeps(overrides: {
  fetchFromWikiServer?: ReturnType<typeof vi.fn>;
  getLocalCitationQuotes?: () => unknown;
}) {
  vi.doMock("../wiki-server", () => ({
    fetchFromWikiServer: overrides.fetchFromWikiServer ?? vi.fn().mockResolvedValue(null),
  }));
  vi.doMock("@/data", () => ({
    getLocalCitationQuotes: overrides.getLocalCitationQuotes ?? (() => undefined),
  }));
}

describe("getCitationQuotes", () => {
  it("returns empty array when no local data exists", async () => {
    vi.resetModules();
    mockCitationDeps({});
    const mod = await import("../citation-data");
    const result = mod.getCitationQuotes("test-page");
    expect(result).toEqual([]);
  });

  it("filters out quotes without verification data", async () => {
    vi.resetModules();
    const localQuotes = [
      makeQuote({ footnote: 1, quoteVerified: true }), // has verification
      makeQuote({ footnote: 2 }), // no verification data — should be filtered
      makeQuote({ footnote: 3, accuracyVerdict: "accurate" }), // has accuracy
    ];
    mockCitationDeps({ getLocalCitationQuotes: () => localQuotes });
    const mod = await import("../citation-data");
    const result = mod.getCitationQuotes("test-page");
    expect(result).toHaveLength(2);
    expect(result[0].footnote).toBe(1);
    expect(result[1].footnote).toBe(3);
  });

  it("always uses local data (no API calls)", async () => {
    vi.resetModules();
    const localQuotes = [
      makeQuote({ footnote: 1, quoteVerified: true }),
      makeQuote({ footnote: 2, accuracyVerdict: "accurate" }),
    ];
    const mockFetch = vi.fn();
    mockCitationDeps({
      fetchFromWikiServer: mockFetch,
      getLocalCitationQuotes: () => localQuotes,
    });
    const mod = await import("../citation-data");
    const result = mod.getCitationQuotes("test-page");
    expect(result).toHaveLength(2);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("getCitationQuotesByUrl", () => {
  it("calls the claims by-source-url endpoint (not deprecated citations/quotes-by-url)", async () => {
    vi.resetModules();
    const mockFetch = vi.fn().mockResolvedValue({ quotes: [], stats: {} });
    mockCitationDeps({ fetchFromWikiServer: mockFetch });
    const mod = await import("../citation-data");
    await mod.getCitationQuotesByUrl("https://example.com/test");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/claims/by-source-url?url=https%3A%2F%2Fexample.com%2Ftest",
      { revalidate: 600 }
    );
  });

  it("returns null when server is unavailable", async () => {
    vi.resetModules();
    mockCitationDeps({ fetchFromWikiServer: vi.fn().mockResolvedValue(null) });
    const mod = await import("../citation-data");
    const result = await mod.getCitationQuotesByUrl("https://example.com/test");
    expect(result).toBeNull();
  });
});

describe("isSafeUrl", () => {
  it("allows https URLs", () => {
    expect(isSafeUrl("https://example.com")).toBe(true);
    expect(isSafeUrl("https://arxiv.org/abs/2301.00001")).toBe(true);
  });

  it("allows http URLs", () => {
    expect(isSafeUrl("http://example.com")).toBe(true);
  });

  it("rejects javascript: URLs", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects data: URLs", () => {
    expect(isSafeUrl("data:text/html,<h1>hi</h1>")).toBe(false);
  });

  it("rejects invalid URLs", () => {
    expect(isSafeUrl("not a url")).toBe(false);
    expect(isSafeUrl("")).toBe(false);
  });

  it("rejects ftp: URLs", () => {
    expect(isSafeUrl("ftp://example.com/file")).toBe(false);
  });
});
