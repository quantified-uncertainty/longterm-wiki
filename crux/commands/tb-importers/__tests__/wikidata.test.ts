import { describe, it, expect } from "vitest";
import {
  assertValidQid,
  buildSparqlQuery,
  extractBindingValue,
  buildProposals,
  fetchSparqlBindings,
  importTarget,
  parseTargetsArg,
  WIKIDATA_PROPERTY_BINDINGS,
  type SparqlBinding,
  type WikidataTarget,
} from "../wikidata.ts";

const TARGET: WikidataTarget = {
  orgSlug: "anthropic",
  orgName: "Anthropic",
  qid: "Q108542504",
};

function makeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      return body;
    },
  })) as unknown as typeof fetch;
}

function sparqlResponse(row: Record<string, string>): unknown {
  const binding: SparqlBinding = {};
  for (const [k, v] of Object.entries(row)) {
    binding[k] = { type: "literal", value: v };
  }
  return { results: { bindings: [binding] } };
}

describe("assertValidQid", () => {
  it("accepts valid QIDs", () => {
    expect(() => assertValidQid("Q1")).not.toThrow();
    expect(() => assertValidQid("Q108542504")).not.toThrow();
  });
  it("rejects empty string", () => {
    expect(() => assertValidQid("")).toThrow(/invalid Wikidata QID/);
  });
  it("rejects missing Q prefix", () => {
    expect(() => assertValidQid("108542504")).toThrow(/invalid Wikidata QID/);
    expect(() => assertValidQid("q108542504")).toThrow(/invalid Wikidata QID/);
  });
  it("rejects leading zero (Q0...)", () => {
    expect(() => assertValidQid("Q0")).toThrow(/invalid Wikidata QID/);
    expect(() => assertValidQid("Q012345")).toThrow(/invalid Wikidata QID/);
  });
  it("rejects QID with trailing chars", () => {
    expect(() => assertValidQid("Q1234abc")).toThrow(/invalid Wikidata QID/);
  });
});

describe("buildSparqlQuery", () => {
  it("includes all property bindings", () => {
    const q = buildSparqlQuery("Q108542504");
    for (const b of WIKIDATA_PROPERTY_BINDINGS) {
      expect(q).toContain(`wdt:${b.wikidataProperty}`);
    }
  });
  it("targets the right QID", () => {
    expect(buildSparqlQuery("Q108542504")).toContain("wd:Q108542504");
    expect(buildSparqlQuery("Q42")).toContain("wd:Q42");
  });
  it("uses LIMIT 1 (we only expect one row per QID)", () => {
    expect(buildSparqlQuery("Q1")).toMatch(/LIMIT\s+1/);
  });
  it("rejects an invalid QID before building", () => {
    expect(() => buildSparqlQuery("not-a-qid")).toThrow(/invalid Wikidata QID/);
  });
});

describe("extractBindingValue", () => {
  const foundedBinding = WIKIDATA_PROPERTY_BINDINGS.find(
    (b) => b.property === "founded-date"
  )!;
  const headcountBinding = WIKIDATA_PROPERTY_BINDINGS.find(
    (b) => b.property === "headcount"
  )!;
  const hqBinding = WIKIDATA_PROPERTY_BINDINGS.find(
    (b) => b.property === "headquarters"
  )!;

  it("returns null when variable is missing", () => {
    expect(extractBindingValue({}, foundedBinding)).toBeNull();
  });
  it("returns null when variable value is empty", () => {
    const binding: SparqlBinding = {
      foundedDate: { type: "literal", value: "" },
    };
    expect(extractBindingValue(binding, foundedBinding)).toBeNull();
  });
  it("truncates date to YYYY-MM", () => {
    const binding: SparqlBinding = {
      foundedDate: { type: "literal", value: "2021-01-23T00:00:00Z" },
    };
    expect(extractBindingValue(binding, foundedBinding)).toBe("2021-01");
  });
  it("parses headcount as number (rejects 0 and negatives)", () => {
    expect(
      extractBindingValue(
        { employees: { type: "literal", value: "175" } },
        headcountBinding
      )
    ).toBe(175);
    expect(
      extractBindingValue(
        { employees: { type: "literal", value: "0" } },
        headcountBinding
      )
    ).toBeNull();
    expect(
      extractBindingValue(
        { employees: { type: "literal", value: "-5" } },
        headcountBinding
      )
    ).toBeNull();
    expect(
      extractBindingValue(
        { employees: { type: "literal", value: "NaN" } },
        headcountBinding
      )
    ).toBeNull();
  });
  it("returns raw value for string-typed properties", () => {
    const binding: SparqlBinding = {
      headquartersLabel: { type: "literal", value: "San Francisco" },
    };
    expect(extractBindingValue(binding, hqBinding)).toBe("San Francisco");
  });
});

describe("buildProposals", () => {
  it("returns [] when bindings is empty", () => {
    expect(buildProposals(TARGET, [], "", "x")).toEqual([]);
  });

  it("emits one proposal per present property", () => {
    const binding: SparqlBinding = {
      foundedDate: { type: "literal", value: "2021-01-23T00:00:00Z" },
      headquartersLabel: { type: "literal", value: "San Francisco" },
      employees: { type: "literal", value: "175" },
    };
    const proposals = buildProposals(
      TARGET,
      [binding],
      "raw",
      "https://www.wikidata.org/wiki/Q108542504"
    );
    expect(proposals).toHaveLength(3);
    const props = proposals.map((p) => p.record.property);
    expect(props).toContain("founded-date");
    expect(props).toContain("headquarters");
    expect(props).toContain("headcount");
  });

  it("emits T1 + wikidata source + organization-fact recordType", () => {
    const binding: SparqlBinding = {
      foundedDate: { type: "literal", value: "2021-01-23T00:00:00Z" },
    };
    const p = buildProposals(TARGET, [binding], "raw", "u")[0];
    expect(p.tier).toBe("T1");
    expect(p.source).toBe("wikidata:Q108542504:P571");
    expect(p.recordType).toBe("organization-fact");
    expect(p.entityRefs?.organization).toBe("anthropic");
    expect(p.record.value).toBe("2021-01");
    expect(p.record.valueType).toBe("date");
  });

  it("hashes (qid, property, value) deterministically", () => {
    const binding: SparqlBinding = {
      employees: { type: "literal", value: "175" },
    };
    const a = buildProposals(TARGET, [binding], "raw-a", "u")[0];
    const b = buildProposals(TARGET, [binding], "raw-b", "u")[0];
    // Hashing is over (qid, property, value), NOT the raw SPARQL JSON —
    // so raw-JSON-ordering changes don't flip the hash.
    expect(a.responseHash).toBe(b.responseHash);
    expect(a.responseHash).toHaveLength(64);
  });

  it("skips properties with null/empty/invalid values", () => {
    const binding: SparqlBinding = {
      foundedDate: { type: "literal", value: "" },
      employees: { type: "literal", value: "not-a-number" },
      headquartersLabel: { type: "literal", value: "Boston" },
    };
    const ps = buildProposals(TARGET, [binding], "raw", "u");
    expect(ps.map((p) => p.record.property)).toEqual(["headquarters"]);
  });
});

describe("fetchSparqlBindings", () => {
  it("throws on non-2xx", async () => {
    const fetchImpl = makeFetch(null, 503);
    await expect(
      fetchSparqlBindings("Q108542504", { fetchImpl })
    ).rejects.toThrow(/HTTP 503/);
  });

  it("throws on malformed JSON", async () => {
    const fetchImpl = makeFetch("{not json", 200);
    await expect(
      fetchSparqlBindings("Q108542504", { fetchImpl })
    ).rejects.toThrow(/not valid JSON/);
  });

  it("throws when results.bindings is missing", async () => {
    const fetchImpl = makeFetch({ other: true }, 200);
    await expect(
      fetchSparqlBindings("Q108542504", { fetchImpl })
    ).rejects.toThrow(/missing results.bindings/);
  });

  it("returns the canonical wiki page URL (not the SPARQL URL)", async () => {
    const fetchImpl = makeFetch(sparqlResponse({}));
    const { sourceUrl } = await fetchSparqlBindings("Q108542504", { fetchImpl });
    expect(sourceUrl).toBe("https://www.wikidata.org/wiki/Q108542504");
  });

  it("sends Accept: sparql-results+json and User-Agent", async () => {
    let capturedAccept = "";
    let capturedUA = "";
    const fetchImpl = (async (_url: string, init: RequestInit | undefined) => {
      const h = (init?.headers as Record<string, string>) ?? {};
      capturedAccept = h.Accept ?? "";
      capturedUA = h["User-Agent"] ?? "";
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify(sparqlResponse({}));
        },
      };
    }) as unknown as typeof fetch;
    await fetchSparqlBindings("Q108542504", { fetchImpl });
    expect(capturedAccept).toContain("sparql-results+json");
    expect(capturedUA).toBeTruthy();
  });

  it("strips CR/LF from user-supplied UA (header injection guard)", async () => {
    let captured = "";
    const fetchImpl = (async (_url: string, init: RequestInit | undefined) => {
      captured = String(
        (init?.headers as Record<string, string>)?.["User-Agent"] ?? ""
      );
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify(sparqlResponse({}));
        },
      };
    }) as unknown as typeof fetch;
    await fetchSparqlBindings("Q108542504", {
      fetchImpl,
      userAgent: "evil\r\nX-Inj: yes",
    });
    expect(captured).not.toContain("\r");
    expect(captured).not.toContain("\n");
  });
});

describe("importTarget — happy path", () => {
  it("produces proposals for the bindings present in the response", async () => {
    const fetchImpl = makeFetch(
      sparqlResponse({
        foundedDate: "2021-01-23T00:00:00Z",
        headquartersLabel: "San Francisco",
        ceoLabel: "Dario Amodei",
      })
    );
    const { proposals } = await importTarget(TARGET, { fetchImpl });
    expect(proposals).toHaveLength(3);
    const props = new Set(proposals.map((p) => p.record.property));
    expect(props).toEqual(new Set(["founded-date", "headquarters", "ceo-name"]));
  });

  it("returns empty proposals when the response has no bindings", async () => {
    const fetchImpl = makeFetch({ results: { bindings: [] } });
    const { proposals } = await importTarget(TARGET, { fetchImpl });
    expect(proposals).toEqual([]);
  });
});

describe("parseTargetsArg", () => {
  it("parses --target=slug:Qnumber", () => {
    expect(parseTargetsArg(["--target=anthropic:Q108542504"])).toEqual([
      { orgSlug: "anthropic", orgName: "anthropic", qid: "Q108542504" },
    ]);
  });
  it("ignores non-target flags", () => {
    expect(parseTargetsArg(["--submit", "--target=x:Q1"])).toHaveLength(1);
  });
  it("throws on no colon", () => {
    expect(() => parseTargetsArg(["--target=slugonly"])).toThrow(
      /exactly one colon/
    );
  });
  it("throws on extra colons", () => {
    expect(() => parseTargetsArg(["--target=a:Q1:extra"])).toThrow(
      /exactly one colon/
    );
  });
  it("throws on empty slug", () => {
    expect(() => parseTargetsArg(["--target=:Q1"])).toThrow(/non-empty/);
  });
  it("throws on empty qid", () => {
    expect(() => parseTargetsArg(["--target=a:"])).toThrow(/non-empty/);
  });
  it("throws on malformed qid", () => {
    expect(() => parseTargetsArg(["--target=a:notaqid"])).toThrow(
      /invalid Wikidata QID/
    );
    expect(() => parseTargetsArg(["--target=a:Q0"])).toThrow(
      /invalid Wikidata QID/
    );
  });
});
