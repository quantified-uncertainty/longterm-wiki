import { describe, it, expect } from "vitest";
import {
  assertValidInstitutionId,
  normalizeDoi,
  workShortId,
  mapPublicationType,
  fetchInstitutionWorks,
  buildProposal,
  importTarget,
  parseTargetsArg,
  type OpenAlexTarget,
  type OpenAlexWork,
} from "../openalex.ts";

const TARGET: OpenAlexTarget = {
  orgSlug: "anthropic",
  orgName: "Anthropic",
  institutionId: "I4210125762",
};

describe("assertValidInstitutionId", () => {
  it("accepts valid IDs", () => {
    expect(() => assertValidInstitutionId("I1")).not.toThrow();
    expect(() => assertValidInstitutionId("I4210125762")).not.toThrow();
  });
  it("rejects leading zero", () => {
    expect(() => assertValidInstitutionId("I0")).toThrow(/invalid OpenAlex/);
    expect(() => assertValidInstitutionId("I04210125762")).toThrow(/invalid OpenAlex/);
  });
  it("rejects missing I prefix", () => {
    expect(() => assertValidInstitutionId("4210125762")).toThrow(/invalid OpenAlex/);
    expect(() => assertValidInstitutionId("i4210125762")).toThrow(/invalid OpenAlex/);
  });
  it("rejects trailing characters", () => {
    expect(() => assertValidInstitutionId("I4210125762-abc")).toThrow(/invalid OpenAlex/);
  });
});

describe("normalizeDoi", () => {
  it("returns null for null/empty/whitespace", () => {
    expect(normalizeDoi(null)).toBeNull();
    expect(normalizeDoi(undefined)).toBeNull();
    expect(normalizeDoi("")).toBeNull();
    expect(normalizeDoi("   ")).toBeNull();
  });
  it("strips https://doi.org/ prefix", () => {
    expect(normalizeDoi("https://doi.org/10.1145/3442188.3445922")).toBe(
      "10.1145/3442188.3445922"
    );
  });
  it("strips http://doi.org/ and doi: prefixes", () => {
    expect(normalizeDoi("http://doi.org/10.1/x")).toBe("10.1/x");
    expect(normalizeDoi("doi:10.1/x")).toBe("10.1/x");
  });
  it("strips case-insensitively but preserves DOI case", () => {
    // Prefix match is case-insensitive; actual DOI body preserves case.
    expect(normalizeDoi("HTTPS://DOI.ORG/10.1145/xYZ")).toBe("10.1145/xYZ");
  });
  it("returns a bare DOI unchanged", () => {
    expect(normalizeDoi("10.1145/x")).toBe("10.1145/x");
  });
});

describe("workShortId", () => {
  it("strips the OpenAlex URL prefix", () => {
    expect(workShortId("https://openalex.org/W12345")).toBe("W12345");
    expect(workShortId("http://openalex.org/W9999")).toBe("W9999");
  });
  it("passes through bare IDs unchanged", () => {
    expect(workShortId("W12345")).toBe("W12345");
  });
});

describe("mapPublicationType", () => {
  it("maps known types", () => {
    expect(mapPublicationType("journal-article")).toBe("paper");
    expect(mapPublicationType("article")).toBe("paper");
    expect(mapPublicationType("preprint")).toBe("preprint");
    expect(mapPublicationType("book-chapter")).toBe("book");
    expect(mapPublicationType("book")).toBe("book");
    expect(mapPublicationType("dissertation")).toBe("thesis");
    expect(mapPublicationType("report")).toBe("report");
  });
  it("falls back to 'paper' for unknown or null", () => {
    expect(mapPublicationType(null)).toBe("paper");
    expect(mapPublicationType(undefined)).toBe("paper");
    expect(mapPublicationType("something-new")).toBe("paper");
  });
});

describe("fetchInstitutionWorks — pagination + limits", () => {
  function pagedFetch(pages: unknown[]): typeof fetch {
    let call = 0;
    return (async () => ({
      ok: true,
      status: 200,
      async json() {
        return pages[call++] ?? { results: [], meta: { next_cursor: null } };
      },
    })) as unknown as typeof fetch;
  }

  it("follows next_cursor across multiple pages", async () => {
    const fetchImpl = pagedFetch([
      { results: [{ id: "https://openalex.org/W1", title: "A" }], meta: { next_cursor: "c2" } },
      { results: [{ id: "https://openalex.org/W2", title: "B" }], meta: { next_cursor: null } },
    ]);
    const works = await fetchInstitutionWorks("I4210125762", { fetchImpl, perPage: 1 });
    expect(works.map((w) => w.title)).toEqual(["A", "B"]);
  });

  it("stops at maxWorks even if cursor is still open", async () => {
    const fetchImpl = pagedFetch([
      {
        results: [
          { id: "https://openalex.org/W1", title: "A" },
          { id: "https://openalex.org/W2", title: "B" },
          { id: "https://openalex.org/W3", title: "C" },
        ],
        meta: { next_cursor: "more" },
      },
    ]);
    const works = await fetchInstitutionWorks("I4210125762", {
      fetchImpl,
      perPage: 100,
      maxWorks: 2,
    });
    expect(works).toHaveLength(2);
  });

  it("stops when results array is empty even with a cursor", async () => {
    const fetchImpl = pagedFetch([
      { results: [], meta: { next_cursor: "never-reached" } },
    ]);
    const works = await fetchInstitutionWorks("I42", { fetchImpl });
    expect(works).toEqual([]);
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;
    await expect(fetchInstitutionWorks("I42", { fetchImpl })).rejects.toThrow(
      /HTTP 429/
    );
  });

  it("rejects bad institution ID before network call", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    await expect(
      fetchInstitutionWorks("bad", { fetchImpl })
    ).rejects.toThrow(/invalid OpenAlex/);
  });

  it("includes mailto polite-pool param when set", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return { results: [], meta: { next_cursor: null } };
        },
      };
    }) as unknown as typeof fetch;
    await fetchInstitutionWorks("I42", {
      fetchImpl,
      mailto: "bot@example.com",
    });
    expect(capturedUrl).toContain("mailto=bot%40example.com");
  });
});

describe("buildProposal", () => {
  const baseWork: OpenAlexWork = {
    id: "https://openalex.org/W100",
    doi: "https://doi.org/10.1145/x",
    title: "Constitutional AI",
    publication_date: "2022-12-15",
    type: "preprint",
    authorships: [
      { author: { display_name: "Yuntao Bai" } },
      { author: { display_name: "Saurav Kadavath" } },
    ],
    primary_location: {
      source: { display_name: "arXiv" },
      landing_page_url: "https://arxiv.org/abs/2212.08073",
    },
  };

  it("emits T1 + openalex source + publication recordType", () => {
    const p = buildProposal(TARGET, baseWork)!;
    expect(p.tier).toBe("T1");
    expect(p.source).toBe("openalex:W100");
    expect(p.recordType).toBe("publication");
    expect(p.entityRefs?.organization).toBe("anthropic");
  });

  it("normalizes the DOI (strips URL prefix)", () => {
    const p = buildProposal(TARGET, baseWork)!;
    expect(p.record.doi).toBe("10.1145/x");
  });

  it("preserves title, authors (deduped, in order), venue, URL", () => {
    const p = buildProposal(TARGET, baseWork)!;
    expect(p.record.title).toBe("Constitutional AI");
    expect(p.record.authors).toEqual(["Yuntao Bai", "Saurav Kadavath"]);
    expect(p.record.venue).toBe("arXiv");
    expect(p.record.url).toBe("https://arxiv.org/abs/2212.08073");
  });

  it("maps preprint → preprint", () => {
    const p = buildProposal(TARGET, baseWork)!;
    expect(p.record.publicationType).toBe("preprint");
  });

  it("dedupes duplicate author names preserving first occurrence", () => {
    const work: OpenAlexWork = {
      ...baseWork,
      authorships: [
        { author: { display_name: "Yuntao Bai" } },
        { author: { display_name: "Yuntao Bai" } },
        { author: { display_name: "Saurav Kadavath" } },
      ],
    };
    const p = buildProposal(TARGET, work)!;
    expect(p.record.authors).toEqual(["Yuntao Bai", "Saurav Kadavath"]);
  });

  it("falls back to raw_author_name when display_name is missing", () => {
    const work: OpenAlexWork = {
      ...baseWork,
      authorships: [
        { raw_author_name: "Anonymous Submitter" },
        { author: { display_name: "" }, raw_author_name: "Fallback" },
      ],
    };
    const p = buildProposal(TARGET, work)!;
    expect(p.record.authors).toEqual(["Anonymous Submitter", "Fallback"]);
  });

  it("returns null when title is empty/whitespace", () => {
    expect(buildProposal(TARGET, { ...baseWork, title: "" })).toBeNull();
    expect(buildProposal(TARGET, { ...baseWork, title: "   " })).toBeNull();
    expect(buildProposal(TARGET, { ...baseWork, title: undefined })).toBeNull();
  });

  it("returns null when neither publication_date nor year is present", () => {
    expect(
      buildProposal(TARGET, {
        ...baseWork,
        publication_date: null,
        publication_year: null,
      })
    ).toBeNull();
  });

  it("falls back to publication_year when publication_date is absent", () => {
    const p = buildProposal(TARGET, {
      ...baseWork,
      publication_date: null,
      publication_year: 2023,
    })!;
    expect(p.record.publishedDate).toBe("2023-01-01");
  });

  it("falls back to openalex URL when no primary_location.landing_page_url", () => {
    const p = buildProposal(TARGET, {
      ...baseWork,
      primary_location: null,
      doi: null,
    })!;
    expect(p.record.url).toBe("https://openalex.org/W100");
  });

  it("falls back to doi.org URL when no landing page but DOI is present", () => {
    const p = buildProposal(TARGET, {
      ...baseWork,
      primary_location: null,
    })!;
    expect(p.record.url).toBe("https://doi.org/10.1145/x");
  });

  it("hash is deterministic over same (id, doi, title, date)", () => {
    const a = buildProposal(TARGET, baseWork)!;
    const b = buildProposal(TARGET, baseWork)!;
    expect(a.responseHash).toBe(b.responseHash);
    expect(a.responseHash).toHaveLength(64);
  });
});

describe("importTarget", () => {
  it("skips works with missing title/date; counts them", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          results: [
            { id: "https://openalex.org/W1", title: "A", publication_date: "2024-01-01" },
            { id: "https://openalex.org/W2", title: null, publication_date: "2024-01-01" },
            { id: "https://openalex.org/W3", title: "C", publication_date: null },
          ],
          meta: { next_cursor: null },
        };
      },
    })) as unknown as typeof fetch;
    const { proposals, skipped } = await importTarget(TARGET, { fetchImpl });
    expect(proposals).toHaveLength(1);
    expect(skipped).toBe(2);
  });
});

describe("parseTargetsArg", () => {
  it("parses --target=slug:Inumber", () => {
    expect(parseTargetsArg(["--target=anthropic:I4210125762"])).toEqual([
      { orgSlug: "anthropic", orgName: "anthropic", institutionId: "I4210125762" },
    ]);
  });
  it("throws on no colon", () => {
    expect(() => parseTargetsArg(["--target=slug"])).toThrow(/exactly one colon/);
  });
  it("throws on extra colons", () => {
    expect(() => parseTargetsArg(["--target=a:I1:extra"])).toThrow(
      /exactly one colon/
    );
  });
  it("throws on empty slug or institution id", () => {
    expect(() => parseTargetsArg(["--target=:I1"])).toThrow(/non-empty/);
    expect(() => parseTargetsArg(["--target=a:"])).toThrow(/non-empty/);
  });
  it("throws on malformed institution id", () => {
    expect(() => parseTargetsArg(["--target=a:42"])).toThrow(/invalid OpenAlex/);
    expect(() => parseTargetsArg(["--target=a:I0"])).toThrow(/invalid OpenAlex/);
  });
});
