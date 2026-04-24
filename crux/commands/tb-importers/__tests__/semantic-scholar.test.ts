import { describe, it, expect } from "vitest";
import {
  assertValidAuthorId,
  mapPublicationType,
  normalizeDoi,
  fetchAuthorPapers,
  buildProposal,
  importTarget,
  parseTargetsArg,
  type SemanticScholarTarget,
  type SemanticScholarPaper,
} from "../semantic-scholar.ts";

const TARGET: SemanticScholarTarget = {
  personSlug: "dario-amodei",
  personName: "Dario Amodei",
  authorId: "1712334",
};

describe("assertValidAuthorId", () => {
  it("accepts numeric IDs", () => {
    expect(() => assertValidAuthorId("1")).not.toThrow();
    expect(() => assertValidAuthorId("1712334")).not.toThrow();
  });
  it("rejects non-numeric", () => {
    expect(() => assertValidAuthorId("abc")).toThrow(/invalid Semantic Scholar/);
    expect(() => assertValidAuthorId("123x")).toThrow(/invalid Semantic Scholar/);
  });
  it("rejects empty", () => {
    expect(() => assertValidAuthorId("")).toThrow(/invalid Semantic Scholar/);
  });
  it("rejects IDs with leading/trailing whitespace", () => {
    expect(() => assertValidAuthorId(" 123")).toThrow(/invalid Semantic Scholar/);
    expect(() => assertValidAuthorId("123 ")).toThrow(/invalid Semantic Scholar/);
  });
});

describe("mapPublicationType", () => {
  it("maps Book → book", () => {
    expect(mapPublicationType(["Book"])).toBe("book");
  });
  it("maps JournalArticle → paper", () => {
    expect(mapPublicationType(["JournalArticle"])).toBe("paper");
  });
  it("maps Conference → paper", () => {
    expect(mapPublicationType(["Conference"])).toBe("paper");
  });
  it("maps Review → paper", () => {
    expect(mapPublicationType(["Review"])).toBe("paper");
  });
  it("returns paper for null/empty", () => {
    expect(mapPublicationType(null)).toBe("paper");
    expect(mapPublicationType(undefined)).toBe("paper");
    expect(mapPublicationType([])).toBe("paper");
  });
  it("prefers Book > other types when multiple present", () => {
    expect(mapPublicationType(["JournalArticle", "Book"])).toBe("book");
  });
});

describe("normalizeDoi", () => {
  it("returns null for null/empty", () => {
    expect(normalizeDoi(null)).toBeNull();
    expect(normalizeDoi(undefined)).toBeNull();
    expect(normalizeDoi("")).toBeNull();
  });
  it("strips doi.org URL prefixes", () => {
    expect(normalizeDoi("https://doi.org/10.1/x")).toBe("10.1/x");
    expect(normalizeDoi("http://doi.org/10.1/x")).toBe("10.1/x");
    expect(normalizeDoi("doi:10.1/x")).toBe("10.1/x");
  });
});

describe("fetchAuthorPapers", () => {
  function pagedFetch(pages: unknown[]): typeof fetch {
    let call = 0;
    return (async () => ({
      ok: true,
      status: 200,
      async json() {
        return pages[call++] ?? { data: [] };
      },
    })) as unknown as typeof fetch;
  }

  it("paginates via `next` offsets", async () => {
    const fetchImpl = pagedFetch([
      { data: [{ paperId: "p1" }], next: 1 },
      { data: [{ paperId: "p2" }], next: 2 },
      { data: [] },
    ]);
    const papers = await fetchAuthorPapers("1", { fetchImpl, limit: 1 });
    expect(papers.map((p) => p.paperId)).toEqual(["p1", "p2"]);
  });

  it("stops when `next` is missing", async () => {
    const fetchImpl = pagedFetch([
      { data: [{ paperId: "p1" }] /* no next field */ },
    ]);
    const papers = await fetchAuthorPapers("1", { fetchImpl });
    expect(papers).toHaveLength(1);
  });

  it("stops when `next` does not advance (defensive against bad APIs)", async () => {
    const fetchImpl = pagedFetch([
      { data: [{ paperId: "p1" }], next: 0 }, // same offset — terminator
    ]);
    const papers = await fetchAuthorPapers("1", { fetchImpl });
    expect(papers).toHaveLength(1);
  });

  it("respects maxPapers", async () => {
    const fetchImpl = pagedFetch([
      { data: [{ paperId: "p1" }, { paperId: "p2" }, { paperId: "p3" }], next: 3 },
    ]);
    const papers = await fetchAuthorPapers("1", { fetchImpl, maxPapers: 2 });
    expect(papers).toHaveLength(2);
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    await expect(fetchAuthorPapers("1", { fetchImpl })).rejects.toThrow(/HTTP 403/);
  });

  it("rejects bad author ID before network call", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not fire");
    }) as unknown as typeof fetch;
    await expect(fetchAuthorPapers("bad", { fetchImpl })).rejects.toThrow(
      /invalid Semantic Scholar/
    );
  });

  it("sends x-api-key when provided", async () => {
    let captured = "";
    const fetchImpl = (async (_url: string, init: RequestInit | undefined) => {
      captured = String(
        (init?.headers as Record<string, string>)?.["x-api-key"] ?? ""
      );
      return { ok: true, status: 200, async json() { return { data: [] }; } };
    }) as unknown as typeof fetch;
    await fetchAuthorPapers("1", { fetchImpl, apiKey: "my-key" });
    expect(captured).toBe("my-key");
  });

  it("strips CR/LF from apiKey (header injection guard)", async () => {
    let captured = "";
    const fetchImpl = (async (_url: string, init: RequestInit | undefined) => {
      captured = String(
        (init?.headers as Record<string, string>)?.["x-api-key"] ?? ""
      );
      return { ok: true, status: 200, async json() { return { data: [] }; } };
    }) as unknown as typeof fetch;
    await fetchAuthorPapers("1", { fetchImpl, apiKey: "bad\r\nX-Inj: pwn" });
    expect(captured).not.toContain("\r");
    expect(captured).not.toContain("\n");
  });
});

describe("buildProposal", () => {
  const basePaper: SemanticScholarPaper = {
    paperId: "abc123",
    externalIds: { DOI: "10.1/x", ArXiv: "2307.12345" },
    title: "On Cruxes",
    venue: "NeurIPS",
    year: 2023,
    publicationDate: "2023-06-15",
    publicationTypes: ["JournalArticle"],
    url: "https://example.org/paper",
  };

  it("emits T1 + semantic-scholar source + publication recordType", () => {
    const p = buildProposal(TARGET, basePaper)!;
    expect(p.tier).toBe("T1");
    expect(p.source).toBe("semantic-scholar:abc123");
    expect(p.recordType).toBe("publication");
    expect(p.entityRefs?.person).toBe("dario-amodei");
  });

  it("preserves title/DOI/venue/arxiv", () => {
    const p = buildProposal(TARGET, basePaper)!;
    expect(p.record.title).toBe("On Cruxes");
    expect(p.record.doi).toBe("10.1/x");
    expect(p.record.arxivId).toBe("2307.12345");
    expect(p.record.venue).toBe("NeurIPS");
  });

  it("returns null when title is missing", () => {
    expect(buildProposal(TARGET, { ...basePaper, title: "" })).toBeNull();
    expect(buildProposal(TARGET, { ...basePaper, title: null })).toBeNull();
  });

  it("returns null when date unresolvable", () => {
    expect(
      buildProposal(TARGET, { ...basePaper, publicationDate: null, year: null })
    ).toBeNull();
    // Year 0 is treated as unset
    expect(
      buildProposal(TARGET, { ...basePaper, publicationDate: null, year: 0 })
    ).toBeNull();
    expect(
      buildProposal(TARGET, { ...basePaper, publicationDate: null, year: 1700 })
    ).toBeNull();
  });

  it("falls back to year-only when publicationDate is absent", () => {
    const p = buildProposal(TARGET, {
      ...basePaper,
      publicationDate: null,
      year: 2022,
    })!;
    expect(p.record.publishedDate).toBe("2022-01-01");
  });

  it("falls back to s2 URL when no paper.url", () => {
    const p = buildProposal(TARGET, { ...basePaper, url: null, externalIds: null })!;
    expect(p.record.url).toBe("https://www.semanticscholar.org/paper/abc123");
  });

  it("falls back to doi.org URL when no paper.url but has DOI", () => {
    const p = buildProposal(TARGET, { ...basePaper, url: null })!;
    expect(p.record.url).toBe("https://doi.org/10.1/x");
  });

  it("includes arxiv id in notes when present", () => {
    const p = buildProposal(TARGET, basePaper)!;
    expect(String(p.record.notes)).toContain("arXiv:2307.12345");
  });

  it("has deterministic hash over (paperId, doi, arxiv, title, date)", () => {
    const a = buildProposal(TARGET, basePaper)!;
    const b = buildProposal(TARGET, basePaper)!;
    expect(a.responseHash).toBe(b.responseHash);
    expect(a.responseHash).toHaveLength(64);
  });
});

describe("importTarget", () => {
  it("skips papers with missing title/date + counts them", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          data: [
            { paperId: "p1", title: "A", publicationDate: "2024-01-01" },
            { paperId: "p2", title: null, publicationDate: "2024-01-01" },
            { paperId: "p3", title: "B", publicationDate: null, year: null },
          ],
          next: null,
        };
      },
    })) as unknown as typeof fetch;
    const { proposals, skipped } = await importTarget(TARGET, { fetchImpl });
    expect(proposals).toHaveLength(1);
    expect(skipped).toBe(2);
  });
});

describe("parseTargetsArg", () => {
  it("parses --target=personSlug:displayName:authorId", () => {
    expect(
      parseTargetsArg(["--target=dario-amodei:Dario Amodei:1712334"])
    ).toEqual([
      { personSlug: "dario-amodei", personName: "Dario Amodei", authorId: "1712334" },
    ]);
  });
  it("handles displayName containing a colon", () => {
    // First colon separates slug, last colon separates authorId; middle may contain colons.
    const t = parseTargetsArg(["--target=a:Prof: Dario Amodei:1712334"])[0];
    expect(t.personSlug).toBe("a");
    expect(t.personName).toBe("Prof: Dario Amodei");
    expect(t.authorId).toBe("1712334");
  });
  it("throws when fewer than 2 colons", () => {
    expect(() => parseTargetsArg(["--target=slug"])).toThrow(/at least two colons/);
    expect(() => parseTargetsArg(["--target=slug:only"])).toThrow(
      /at least two colons/
    );
  });
  it("throws on empty segments", () => {
    expect(() => parseTargetsArg(["--target=:Dario:123"])).toThrow(/empty segment/);
    expect(() => parseTargetsArg(["--target=a::123"])).toThrow(/empty segment/);
    expect(() => parseTargetsArg(["--target=a:Dario:"])).toThrow(/empty segment/);
  });
  it("throws on non-numeric author id", () => {
    expect(() => parseTargetsArg(["--target=a:Dario:abc"])).toThrow(
      /invalid Semantic Scholar/
    );
  });
});
