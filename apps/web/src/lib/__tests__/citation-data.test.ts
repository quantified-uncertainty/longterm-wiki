import { describe, it, expect } from "vitest";
import {
  computeCitationHealth,
  type CitationQuote,
} from "../citation-data";

function makeQuote(overrides: Partial<CitationQuote> = {}): CitationQuote {
  return {
    footnote: 1,
    url: "https://example.com",
    claimText: "Test claim",
    sourceQuote: null,
    sourceTitle: null,
    quoteVerified: false,
    verificationScore: null,
    verifiedAt: null,
    accuracyVerdict: null,
    accuracyScore: null,
    accuracyIssues: null,
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
