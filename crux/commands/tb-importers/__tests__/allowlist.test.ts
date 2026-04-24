import { describe, it, expect } from "vitest";
import { isT1Authoritative, T1_AUTHORITY_ALLOWLIST } from "../allowlist.ts";

describe("T1_AUTHORITY_ALLOWLIST", () => {
  it("includes the three QUA-640 importers", () => {
    const sources = T1_AUTHORITY_ALLOWLIST.map((e) => e.sourcePrefix);
    expect(sources).toContain("sec-edgar:");
    expect(sources).toContain("github-contributors:");
    expect(sources).toContain("hf-leaderboard:");
  });

  it("includes the four QUA-666 importers", () => {
    const sources = T1_AUTHORITY_ALLOWLIST.map((e) => e.sourcePrefix);
    expect(sources).toContain("wikidata:");
    expect(sources).toContain("openalex:");
    expect(sources).toContain("semantic-scholar:");
    expect(sources).toContain("crossref:");
  });

  it("each entry has a description", () => {
    for (const entry of T1_AUTHORITY_ALLOWLIST) {
      expect(entry.description.length).toBeGreaterThan(10);
    }
  });

  it("no duplicate (sourcePrefix, recordType) tuples", () => {
    const keys = new Set<string>();
    for (const entry of T1_AUTHORITY_ALLOWLIST) {
      const key = `${entry.sourcePrefix}|${entry.recordType}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }
  });
});

describe("isT1Authoritative", () => {
  it("accepts on prefix match + recordType match", () => {
    expect(isT1Authoritative("sec-edgar:0001234567-25-000001", "funding-rounds")).toBe(true);
    expect(isT1Authoritative("github-contributors:anthropic:alice", "personnel")).toBe(true);
    expect(isT1Authoritative("hf-leaderboard:meta-llama/M:IFEval", "benchmark-results")).toBe(true);
    expect(isT1Authoritative("wikidata:Q108542504:P571", "organization-fact")).toBe(true);
    expect(isT1Authoritative("openalex:W100", "publication")).toBe(true);
    expect(isT1Authoritative("semantic-scholar:abc123", "publication")).toBe(true);
    expect(isT1Authoritative("crossref:10.1/x", "publication")).toBe(true);
  });

  it("rejects when source matches but recordType doesn't", () => {
    expect(isT1Authoritative("sec-edgar:abc", "personnel")).toBe(false);
    expect(isT1Authoritative("github-contributors:x:y", "funding-rounds")).toBe(false);
  });

  it("rejects when recordType matches but source doesn't", () => {
    expect(isT1Authoritative("crunchbase:abc", "funding-rounds")).toBe(false);
    expect(isT1Authoritative("twitter:somebody", "personnel")).toBe(false);
  });

  it("rejects exact-match-without-prefix-colon", () => {
    // Source needs the colon so that "sec-edgar-fake:abc" doesn't slip past
    expect(isT1Authoritative("sec-edgar-fake:abc", "funding-rounds")).toBe(false);
  });

  it("rejects empty source", () => {
    expect(isT1Authoritative("", "funding-rounds")).toBe(false);
  });
});
