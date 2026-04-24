import { describe, it, expect } from "vitest";
import {
  assertValidDoi,
  normalizeDoi,
  extractDate,
  pickPublishedDate,
  formatAuthor,
  mapPublicationType,
  fetchDoiWork,
  buildProposal,
  importTarget,
  parseTargetsArg,
  type CrossrefTarget,
  type CrossrefWork,
} from "../crossref.ts";

const DOI = "10.1145/3442188.3445922";
const TARGET: CrossrefTarget = {
  orgSlug: "anthropic",
  personSlug: "dario-amodei",
  doi: DOI,
};

describe("assertValidDoi", () => {
  it("accepts well-formed DOIs", () => {
    expect(() => assertValidDoi("10.1145/3442188.3445922")).not.toThrow();
    expect(() => assertValidDoi("10.48550/arXiv.2303.08774")).not.toThrow();
  });
  it("rejects empty", () => {
    expect(() => assertValidDoi("")).toThrow(/invalid DOI/);
  });
  it("rejects missing '10.' prefix", () => {
    expect(() => assertValidDoi("1145/x")).toThrow(/invalid DOI/);
  });
  it("rejects missing slash + suffix", () => {
    expect(() => assertValidDoi("10.1145")).toThrow(/invalid DOI/);
    expect(() => assertValidDoi("10.1145/")).toThrow(/invalid DOI/);
  });
  it("rejects whitespace in DOI", () => {
    expect(() => assertValidDoi("10.1145/x y")).toThrow(/invalid DOI/);
  });
});

describe("normalizeDoi", () => {
  it("strips doi.org URL prefixes", () => {
    expect(normalizeDoi("https://doi.org/10.1145/abc")).toBe("10.1145/abc");
    expect(normalizeDoi("HTTPS://DOI.ORG/10.1145/ABC")).toBe("10.1145/ABC");
    expect(normalizeDoi("doi:10.1145/abc")).toBe("10.1145/abc");
  });
  it("returns bare DOI unchanged after validation", () => {
    expect(normalizeDoi("10.1145/abc")).toBe("10.1145/abc");
  });
  it("throws on empty/invalid", () => {
    expect(() => normalizeDoi("")).toThrow(/empty/);
    expect(() => normalizeDoi("not-a-doi")).toThrow(/invalid DOI/);
  });
});

describe("extractDate", () => {
  it("extracts YYYY from year-only tuple", () => {
    expect(extractDate({ "date-parts": [[2023]] })).toBe("2023-01-01");
  });
  it("extracts YYYY-MM from year+month tuple", () => {
    expect(extractDate({ "date-parts": [[2023, 6]] })).toBe("2023-06-01");
  });
  it("extracts YYYY-MM-DD from full tuple", () => {
    expect(extractDate({ "date-parts": [[2023, 6, 15]] })).toBe("2023-06-15");
  });
  it("zero-pads single-digit month/day", () => {
    expect(extractDate({ "date-parts": [[2023, 3, 5]] })).toBe("2023-03-05");
  });
  it("returns null for missing/empty/invalid", () => {
    expect(extractDate(undefined)).toBeNull();
    expect(extractDate({})).toBeNull();
    expect(extractDate({ "date-parts": [] })).toBeNull();
    expect(extractDate({ "date-parts": [[]] })).toBeNull();
  });
  it("rejects year < 1800", () => {
    expect(extractDate({ "date-parts": [[1799]] })).toBeNull();
    expect(extractDate({ "date-parts": [[0]] })).toBeNull();
  });
  it("defaults bogus month/day to 01", () => {
    expect(extractDate({ "date-parts": [[2023, 0, 0]] })).toBe("2023-01-01");
    expect(extractDate({ "date-parts": [[2023, 13, 32]] })).toBe("2023-01-01");
  });
});

describe("pickPublishedDate", () => {
  it("picks the earliest date across issued/published/published-online", () => {
    const work: CrossrefWork = {
      DOI,
      issued: { "date-parts": [[2023, 6, 15]] },
      published: { "date-parts": [[2023, 3, 1]] },
      "published-online": { "date-parts": [[2023, 2, 28]] },
    };
    expect(pickPublishedDate(work)).toBe("2023-02-28");
  });
  it("returns null when no date is available", () => {
    expect(pickPublishedDate({ DOI })).toBeNull();
  });
});

describe("formatAuthor", () => {
  it("formats given + family", () => {
    expect(formatAuthor({ given: "Jane", family: "Smith" })).toBe("Jane Smith");
  });
  it("falls back to family only", () => {
    expect(formatAuthor({ family: "Smith" })).toBe("Smith");
  });
  it("falls back to given only", () => {
    expect(formatAuthor({ given: "Jane" })).toBe("Jane");
  });
  it("uses organizational `name` when present", () => {
    expect(formatAuthor({ name: "OpenAI" })).toBe("OpenAI");
  });
  it("returns null when all fields empty", () => {
    expect(formatAuthor({})).toBeNull();
    expect(formatAuthor({ given: "", family: "" })).toBeNull();
  });
  it("trims whitespace", () => {
    expect(formatAuthor({ given: " Jane ", family: " Smith " })).toBe("Jane Smith");
  });
});

describe("mapPublicationType", () => {
  it("maps posted-content → preprint", () => {
    expect(mapPublicationType("posted-content")).toBe("preprint");
  });
  it("maps journal-article → paper", () => {
    expect(mapPublicationType("journal-article")).toBe("paper");
  });
  it("maps book variants → book", () => {
    expect(mapPublicationType("book")).toBe("book");
    expect(mapPublicationType("book-chapter")).toBe("book");
    expect(mapPublicationType("book-section")).toBe("book");
  });
  it("maps report variants → report", () => {
    expect(mapPublicationType("report")).toBe("report");
    expect(mapPublicationType("report-component")).toBe("report");
  });
  it("falls back to paper for unknown/null", () => {
    expect(mapPublicationType(null)).toBe("paper");
    expect(mapPublicationType(undefined)).toBe("paper");
    expect(mapPublicationType("weird")).toBe("paper");
  });
});

describe("fetchDoiWork", () => {
  function makeFetch(body: unknown, status = 200): typeof fetch {
    return (async () => ({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
    })) as unknown as typeof fetch;
  }

  it("returns the message on ok status", async () => {
    const fetchImpl = makeFetch({
      status: "ok",
      message: { DOI, title: ["x"] },
    });
    const w = await fetchDoiWork(DOI, { fetchImpl });
    expect(w.DOI).toBe(DOI);
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = makeFetch(null, 404);
    await expect(fetchDoiWork(DOI, { fetchImpl })).rejects.toThrow(/HTTP 404/);
  });

  it("throws when status != ok", async () => {
    const fetchImpl = makeFetch({ status: "failed" });
    await expect(fetchDoiWork(DOI, { fetchImpl })).rejects.toThrow(/status=failed/);
  });

  it("rejects invalid DOI before network call", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not fire");
    }) as unknown as typeof fetch;
    await expect(fetchDoiWork("not-a-doi", { fetchImpl })).rejects.toThrow(
      /invalid DOI/
    );
  });

  it("URL-encodes the DOI in path", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return { status: "ok", message: { DOI } };
        },
      };
    }) as unknown as typeof fetch;
    await fetchDoiWork(DOI, { fetchImpl });
    expect(capturedUrl).toContain(encodeURIComponent(DOI));
  });

  it("appends ?mailto= when provided", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return { status: "ok", message: { DOI } };
        },
      };
    }) as unknown as typeof fetch;
    await fetchDoiWork(DOI, { fetchImpl, mailto: "bot@example.com" });
    expect(capturedUrl).toContain("mailto=bot%40example.com");
  });
});

describe("buildProposal", () => {
  const baseWork: CrossrefWork = {
    DOI,
    title: ["Constitutional AI"],
    author: [
      { given: "Yuntao", family: "Bai" },
      { given: "Saurav", family: "Kadavath" },
    ],
    "container-title": ["arXiv"],
    publisher: "arXiv.org",
    type: "posted-content",
    issued: { "date-parts": [[2022, 12, 15]] },
    URL: "https://arxiv.org/abs/2212.08073",
  };

  it("emits T1 + crossref source + publication recordType", () => {
    const p = buildProposal(TARGET, baseWork)!;
    expect(p.tier).toBe("T1");
    expect(p.source).toBe(`crossref:${DOI}`);
    expect(p.recordType).toBe("publication");
  });

  it("emits both org and person entity refs when provided", () => {
    const p = buildProposal(TARGET, baseWork)!;
    expect(p.entityRefs?.organization).toBe("anthropic");
    expect(p.entityRefs?.person).toBe("dario-amodei");
  });

  it("omits empty entityRefs when no target refs supplied", () => {
    const t: CrossrefTarget = { doi: DOI };
    const p = buildProposal(t, baseWork)!;
    expect(p.entityRefs?.organization).toBeUndefined();
    expect(p.entityRefs?.person).toBeUndefined();
  });

  it("preserves title/DOI/venue/publisher/authors", () => {
    const p = buildProposal(TARGET, baseWork)!;
    expect(p.record.title).toBe("Constitutional AI");
    expect(p.record.doi).toBe(DOI);
    expect(p.record.venue).toBe("arXiv");
    expect(p.record.publisher).toBe("arXiv.org");
    expect(p.record.authors).toEqual(["Yuntao Bai", "Saurav Kadavath"]);
  });

  it("maps posted-content → preprint", () => {
    const p = buildProposal(TARGET, baseWork)!;
    expect(p.record.publicationType).toBe("preprint");
  });

  it("returns null for missing title", () => {
    expect(buildProposal(TARGET, { ...baseWork, title: [] })).toBeNull();
    expect(buildProposal(TARGET, { ...baseWork, title: [""] })).toBeNull();
    expect(buildProposal(TARGET, { ...baseWork, title: undefined })).toBeNull();
  });

  it("returns null for missing date", () => {
    expect(
      buildProposal(TARGET, {
        ...baseWork,
        issued: undefined,
        published: undefined,
        "published-print": undefined,
        "published-online": undefined,
      })
    ).toBeNull();
  });

  it("falls back to doi.org URL when URL is missing", () => {
    const p = buildProposal(TARGET, { ...baseWork, URL: null })!;
    expect(p.record.url).toBe(`https://doi.org/${DOI}`);
  });

  it("has deterministic hash over (doi, title, date)", () => {
    const a = buildProposal(TARGET, baseWork)!;
    const b = buildProposal(TARGET, baseWork)!;
    expect(a.responseHash).toBe(b.responseHash);
    expect(a.responseHash).toHaveLength(64);
  });
});

describe("importTarget", () => {
  it("fetches + builds proposal", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          status: "ok",
          message: {
            DOI,
            title: ["Constitutional AI"],
            issued: { "date-parts": [[2022, 12, 15]] },
          },
        };
      },
    })) as unknown as typeof fetch;
    const { proposal } = await importTarget(TARGET, { fetchImpl });
    expect(proposal).not.toBeNull();
    expect(proposal!.record.title).toBe("Constitutional AI");
  });

  it("returns null proposal when work lacks required fields", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          status: "ok",
          message: { DOI, title: [] }, // no title
        };
      },
    })) as unknown as typeof fetch;
    const { proposal } = await importTarget(TARGET, { fetchImpl });
    expect(proposal).toBeNull();
  });
});

describe("parseTargetsArg", () => {
  it("parses --target=doi:10.xxx/yyy (DOI only)", () => {
    const out = parseTargetsArg([`--target=doi:${DOI}`]);
    expect(out).toEqual([{ doi: DOI }]);
  });

  it("normalizes DOI URL form", () => {
    const out = parseTargetsArg([`--target=doi:https://doi.org/${DOI}`]);
    expect(out[0].doi).toBe(DOI);
  });

  it("parses pipe-separated org attribute", () => {
    const out = parseTargetsArg([`--target=doi:${DOI}|org=anthropic`]);
    expect(out[0]).toEqual({ doi: DOI, orgSlug: "anthropic" });
  });

  it("parses pipe-separated person attribute", () => {
    const out = parseTargetsArg([`--target=doi:${DOI}|person=jane-smith`]);
    expect(out[0].personSlug).toBe("jane-smith");
  });

  it("parses both org and person", () => {
    const out = parseTargetsArg([
      `--target=doi:${DOI}|org=anthropic|person=jane-smith`,
    ]);
    expect(out[0].orgSlug).toBe("anthropic");
    expect(out[0].personSlug).toBe("jane-smith");
  });

  it("throws when doi: prefix missing", () => {
    expect(() => parseTargetsArg([`--target=${DOI}`])).toThrow(/must start with "doi:"/);
  });

  it("throws on invalid DOI format", () => {
    expect(() => parseTargetsArg(["--target=doi:not-a-doi"])).toThrow(/invalid DOI/);
  });

  it("throws on malformed attribute (no =)", () => {
    expect(() =>
      parseTargetsArg([`--target=doi:${DOI}|orgonly`])
    ).toThrow(/key=value/);
  });

  it("throws on unknown attribute key", () => {
    expect(() =>
      parseTargetsArg([`--target=doi:${DOI}|foo=bar`])
    ).toThrow(/unknown attribute/);
  });

  it("throws on empty attribute value", () => {
    expect(() =>
      parseTargetsArg([`--target=doi:${DOI}|org=`])
    ).toThrow(/empty value/);
  });
});
