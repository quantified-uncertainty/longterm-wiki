import { describe, it, expect } from "vitest";
import {
  padCik,
  buildFormDUrl,
  parseFormDXml,
  decodeXmlEntities,
  fetchFormDFilings,
  fetchAndParseFormD,
  buildProposal,
  importTarget,
  parseTargetsArg,
  type FormDFiling,
  type SecEdgarTarget,
  type SecEdgarOptions,
} from "../sec-edgar.ts";

const TARGET: SecEdgarTarget = {
  orgSlug: "anthropic",
  orgName: "Anthropic, PBC",
  cik: "1828101",
};

const SAMPLE_XML = `<?xml version="1.0"?>
<edgarSubmission>
  <primaryIssuer>
    <entityName>Anthropic, PBC</entityName>
  </primaryIssuer>
  <offeringData>
    <offeringSalesAmounts>
      <totalOfferingAmount>1000000000</totalOfferingAmount>
      <totalAmountSold>750000000</totalAmountSold>
    </offeringSalesAmounts>
    <signatureBlock>
      <dateOfFirstSale>2024-05-30</dateOfFirstSale>
    </signatureBlock>
    <totalNumberAlreadyInvested>12</totalNumberAlreadyInvested>
  </offeringData>
</edgarSubmission>`;

describe("padCik", () => {
  it("pads short CIKs to 10 digits", () => {
    expect(padCik("1828101")).toBe("0001828101");
    expect(padCik("1")).toBe("0000000001");
  });
  it("preserves a 10-digit CIK", () => {
    expect(padCik("0001234567")).toBe("0001234567");
  });
  it("strips non-digits before padding", () => {
    expect(padCik("CIK 1828101")).toBe("0001828101");
    expect(padCik("0001828101 ")).toBe("0001828101");
  });
  it("throws on input with no digits", () => {
    expect(() => padCik("CIK")).toThrow(/invalid CIK/);
    expect(() => padCik("")).toThrow(/invalid CIK/);
  });
});

describe("decodeXmlEntities", () => {
  it("decodes named entities", () => {
    expect(decodeXmlEntities("AT&amp;T")).toBe("AT&T");
    expect(decodeXmlEntities("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeXmlEntities("she said &quot;hi&quot;")).toBe('she said "hi"');
    expect(decodeXmlEntities("don&apos;t")).toBe("don't");
  });
  it("decodes decimal numeric character references", () => {
    expect(decodeXmlEntities("&#39;")).toBe("'");
    expect(decodeXmlEntities("&#65;")).toBe("A");
  });
  it("decodes hex numeric character references", () => {
    expect(decodeXmlEntities("&#x27;")).toBe("'");
    expect(decodeXmlEntities("&#xA9;")).toBe("©");
  });
  it("preserves &amp;lt; → &lt; (not <)", () => {
    expect(decodeXmlEntities("&amp;lt;")).toBe("&lt;");
  });
  it("leaves bare ampersands alone", () => {
    expect(decodeXmlEntities("a & b")).toBe("a & b");
  });
});

describe("buildFormDUrl", () => {
  const filing: FormDFiling = {
    accessionNumber: "0001828101-24-000001",
    filingDate: "2024-05-30",
    primaryDocument: "primary_doc.xml",
    accessionNoDashes: "000182810124000001",
  };
  it("uses unpadded CIK in directory segment", () => {
    expect(buildFormDUrl("1828101", filing)).toBe(
      "https://www.sec.gov/Archives/edgar/data/1828101/000182810124000001/primary_doc.xml"
    );
  });
  it("strips leading zeros from a padded CIK", () => {
    expect(buildFormDUrl("0001828101", filing)).toBe(
      "https://www.sec.gov/Archives/edgar/data/1828101/000182810124000001/primary_doc.xml"
    );
  });
  it("throws on all-zero CIK rather than producing /data/0/...", () => {
    expect(() => buildFormDUrl("0000000000", filing)).toThrow(/all zeros/);
  });
});

describe("parseFormDXml", () => {
  it("extracts the headline numeric fields", () => {
    const e = parseFormDXml(SAMPLE_XML);
    expect(e.totalAmountSold).toBe(750_000_000);
    expect(e.totalNumberAlreadyInvested).toBe(12);
    expect(e.firstSaleDate).toBe("2024-05-30");
    expect(e.issuerName).toBe("Anthropic, PBC");
  });

  it("returns null for missing fields rather than throwing", () => {
    const e = parseFormDXml(`<edgarSubmission></edgarSubmission>`);
    expect(e.totalAmountSold).toBeNull();
    expect(e.totalNumberAlreadyInvested).toBeNull();
    expect(e.firstSaleDate).toBeNull();
    expect(e.issuerName).toBeNull();
  });

  it("returns null when amount field is non-numeric", () => {
    const xml = `<edgarSubmission><totalAmountSold>UNKNOWN</totalAmountSold></edgarSubmission>`;
    expect(parseFormDXml(xml).totalAmountSold).toBeNull();
  });

  it("handles empty leaf elements", () => {
    const xml = `<edgarSubmission><totalAmountSold></totalAmountSold></edgarSubmission>`;
    expect(parseFormDXml(xml).totalAmountSold).toBeNull();
  });

  it("handles namespace-prefixed tags (ns1:totalAmountSold)", () => {
    const xml = `<ns1:edgarSubmission><ns1:totalAmountSold>500</ns1:totalAmountSold></ns1:edgarSubmission>`;
    expect(parseFormDXml(xml).totalAmountSold).toBe(500);
  });

  it("handles tags with attributes (xml:lang on entityName)", () => {
    const xml = `<edgarSubmission><entityName xml:lang="en">OpenAI</entityName></edgarSubmission>`;
    expect(parseFormDXml(xml).issuerName).toBe("OpenAI");
  });

  it("handles namespace + attributes simultaneously", () => {
    const xml = `<a><ns1:entityName xml:lang="en" foo="bar">Anthropic, PBC</ns1:entityName></a>`;
    expect(parseFormDXml(xml).issuerName).toBe("Anthropic, PBC");
  });

  it("decodes XML entities inside element values", () => {
    const xml = `<edgarSubmission><entityName>OpenAI &amp; Affiliates</entityName></edgarSubmission>`;
    expect(parseFormDXml(xml).issuerName).toBe("OpenAI & Affiliates");
  });

  it("decodes numeric character references in values", () => {
    const xml = `<edgarSubmission><entityName>L&#39;Or&#xE9;al</entityName></edgarSubmission>`;
    expect(parseFormDXml(xml).issuerName).toBe("L'Oréal");
  });
});

describe("fetchFormDFilings", () => {
  function makeFetch(body: unknown, status = 200): typeof fetch {
    return (async () => ({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
    })) as unknown as typeof fetch;
  }

  it("filters to Form D / Form D/A and zips parallel arrays", async () => {
    const fetchImpl = makeFetch({
      cik: "1828101",
      name: "Anthropic, PBC",
      filings: {
        recent: {
          accessionNumber: ["A-001", "A-002", "A-003", "A-004"],
          form: ["D", "10-K", "D/A", "8-K"],
          filingDate: ["2024-05-30", "2024-03-01", "2024-06-15", "2024-04-01"],
          primaryDocument: ["d.xml", "10k.htm", "da.xml", "8k.htm"],
        },
      },
    });

    const out = await fetchFormDFilings("1828101", { fetchImpl });
    expect(out).toHaveLength(2);
    expect(out[0].accessionNumber).toBe("A-001");
    expect(out[0].accessionNoDashes).toBe("A001");
    expect(out[1].accessionNumber).toBe("A-003");
  });

  it("returns empty array when no Form D filings", async () => {
    const fetchImpl = makeFetch({
      cik: "1828101",
      name: "Anthropic, PBC",
      filings: {
        recent: { accessionNumber: ["X"], form: ["8-K"], filingDate: ["2024-01-01"] },
      },
    });
    const out = await fetchFormDFilings("1828101", { fetchImpl });
    expect(out).toEqual([]);
  });

  it("returns empty array when the recent block is missing entirely", async () => {
    const fetchImpl = makeFetch({ cik: "1828101", name: "X" });
    expect(await fetchFormDFilings("1828101", { fetchImpl })).toEqual([]);
  });

  it("throws on non-2xx HTTP", async () => {
    const fetchImpl = makeFetch(null, 503);
    await expect(fetchFormDFilings("1828101", { fetchImpl })).rejects.toThrow(/HTTP 503/);
  });

  it("respects maxFilingsPerTarget", async () => {
    const accs = Array.from({ length: 10 }, (_, i) => `A-${i}`);
    const fetchImpl = makeFetch({
      cik: "1828101",
      filings: {
        recent: {
          accessionNumber: accs,
          form: accs.map(() => "D"),
          filingDate: accs.map(() => "2024-01-01"),
        },
      },
    });
    const out = await fetchFormDFilings("1828101", { fetchImpl, maxFilingsPerTarget: 3 });
    expect(out).toHaveLength(3);
  });

  it("safely handles mismatched parallel-array lengths", async () => {
    const fetchImpl = makeFetch({
      cik: "1828101",
      filings: {
        recent: {
          accessionNumber: ["A-1"],          // length 1
          form: ["D", "D"],                   // length 2
          filingDate: ["2024-01-01", "2024-02-01"], // length 2
        },
      },
    });
    // Should not crash on undefined access; takes the shortest array.
    const out = await fetchFormDFilings("1828101", { fetchImpl });
    expect(out).toHaveLength(1);
    expect(out[0].accessionNumber).toBe("A-1");
  });

  it("sends the configured User-Agent header", async () => {
    let captured = "";
    const fetchImpl = (async (_url: string, init: RequestInit | undefined) => {
      captured = String((init?.headers as Record<string, string>)?.["User-Agent"] ?? "");
      return {
        ok: true,
        status: 200,
        async json() {
          return { cik: "x", filings: { recent: {} } };
        },
      };
    }) as unknown as typeof fetch;
    await fetchFormDFilings("1828101", { fetchImpl, userAgent: "test-agent/1.0" });
    expect(captured).toBe("test-agent/1.0");
  });

  it("strips CR/LF from user-supplied User-Agent (header injection guard)", async () => {
    let captured = "";
    const fetchImpl = (async (_url: string, init: RequestInit | undefined) => {
      captured = String((init?.headers as Record<string, string>)?.["User-Agent"] ?? "");
      return {
        ok: true,
        status: 200,
        async json() {
          return { cik: "x", filings: { recent: {} } };
        },
      };
    }) as unknown as typeof fetch;
    await fetchFormDFilings("1828101", { fetchImpl, userAgent: "evil\r\nX-Inj: yes" });
    expect(captured).not.toContain("\r");
    expect(captured).not.toContain("\n");
  });
});

describe("fetchAndParseFormD", () => {
  it("returns extract + raw + sourceUrl", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      async text() {
        return SAMPLE_XML;
      },
    })) as unknown as typeof fetch;
    const filing: FormDFiling = {
      accessionNumber: "A-001",
      filingDate: "2024-05-30",
      primaryDocument: "primary_doc.xml",
      accessionNoDashes: "A001",
    };
    const r = await fetchAndParseFormD("1828101", filing, { fetchImpl });
    expect(r.extract.totalAmountSold).toBe(750_000_000);
    expect(r.sourceUrl).toContain("/1828101/A001/primary_doc.xml");
    expect(r.rawXml).toBe(SAMPLE_XML);
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const filing: FormDFiling = {
      accessionNumber: "A-001",
      filingDate: "x",
      primaryDocument: "d.xml",
      accessionNoDashes: "A",
    };
    await expect(
      fetchAndParseFormD("1828101", filing, { fetchImpl })
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("buildProposal", () => {
  const filing: FormDFiling = {
    accessionNumber: "0001828101-24-000001",
    filingDate: "2024-05-30",
    primaryDocument: "primary_doc.xml",
    accessionNoDashes: "000182810124000001",
  };

  it("emits T1 + sec-edgar source + funding-round recordType", () => {
    const extract = parseFormDXml(SAMPLE_XML);
    const p = buildProposal(
      TARGET,
      filing,
      extract,
      SAMPLE_XML,
      "https://www.sec.gov/x"
    );
    expect(p.tier).toBe("T1");
    expect(p.source).toBe("sec-edgar:0001828101-24-000001");
    expect(p.recordType).toBe("funding-round");
    expect(p.entityRefs?.organization).toBe("anthropic");
  });

  it("hashes the raw XML deterministically", () => {
    const extract = parseFormDXml(SAMPLE_XML);
    const a = buildProposal(TARGET, filing, extract, SAMPLE_XML, "u");
    const b = buildProposal(TARGET, filing, extract, SAMPLE_XML, "u");
    expect(a.responseHash).toBe(b.responseHash);
    expect(a.responseHash).toHaveLength(64); // hex sha256
  });

  it("populates raised + date from the extract", () => {
    const extract = parseFormDXml(SAMPLE_XML);
    const p = buildProposal(TARGET, filing, extract, SAMPLE_XML, "u");
    expect(p.record.raised).toBe(750_000_000);
    // Prefers extract.firstSaleDate over filing.filingDate when both are present
    expect(p.record.date).toBe("2024-05-30");
  });

  it("includes the issuer name from the XML in notes (for evidence)", () => {
    const extract = parseFormDXml(SAMPLE_XML);
    const p = buildProposal(TARGET, filing, extract, SAMPLE_XML, "u");
    expect(String(p.record.notes)).toContain("12 investors");
    expect(String(p.record.notes)).toContain("Issuer per Form D: Anthropic, PBC");
  });

  it("falls back to filing.filingDate when extract.firstSaleDate is null", () => {
    const extract = parseFormDXml(`<edgarSubmission></edgarSubmission>`);
    const p = buildProposal(TARGET, filing, extract, SAMPLE_XML, "u");
    expect(p.record.date).toBe("2024-05-30"); // from filing.filingDate
    expect(p.record.notes).toBeNull();
  });

  it("emits null raised when the extract lacks the field", () => {
    const extract = parseFormDXml(`<edgarSubmission></edgarSubmission>`);
    const p = buildProposal(TARGET, filing, extract, SAMPLE_XML, "u");
    expect(p.record.raised).toBeNull();
  });
});

describe("importTarget — happy path + skip-on-error", () => {
  it("returns proposals + failures count and skips broken filings", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("submissions/")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              cik: "1828101",
              filings: {
                recent: {
                  accessionNumber: ["A-1", "A-2"],
                  form: ["D", "D"],
                  filingDate: ["2024-01-01", "2024-02-01"],
                  primaryDocument: ["primary_doc.xml", "primary_doc.xml"],
                },
              },
            };
          },
        };
      }
      // Fail filing A-2 specifically (not call-counter — robust to refactor)
      if (String(url).includes("/A2/")) {
        return { ok: false, status: 500 };
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return SAMPLE_XML;
        },
      };
    }) as unknown as typeof fetch;
    const opts: SecEdgarOptions = { fetchImpl };
    const { proposals, failures } = await importTarget(TARGET, opts);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe("sec-edgar:A-1");
    expect(failures).toBe(1);
  });
});

describe("parseTargetsArg", () => {
  it("parses --target=slug:cik", () => {
    expect(parseTargetsArg(["--target=anthropic:1828101"])).toEqual([
      { orgSlug: "anthropic", orgName: "anthropic", cik: "1828101" },
    ]);
  });
  it("ignores other flags", () => {
    expect(parseTargetsArg(["--submit", "--target=x:1"])).toHaveLength(1);
  });
  it("throws on malformed --target (no colon)", () => {
    expect(() => parseTargetsArg(["--target=missingcik"])).toThrow(/exactly one colon/);
  });
  it("throws on extra colons (--target=slug:cik:extra)", () => {
    expect(() => parseTargetsArg(["--target=anthropic:1828101:extra"])).toThrow(
      /exactly one colon/
    );
  });
  it("throws on empty slug", () => {
    expect(() => parseTargetsArg(["--target=:1828101"])).toThrow(/non-empty/);
  });
  it("throws on empty cik", () => {
    expect(() => parseTargetsArg(["--target=anthropic:"])).toThrow(/non-empty/);
  });
  it("throws on non-numeric cik", () => {
    expect(() => parseTargetsArg(["--target=anthropic:abc"])).toThrow(/1-10 digits/);
    expect(() => parseTargetsArg(["--target=anthropic:CIK 1"])).toThrow(/1-10 digits/);
  });
  it("throws on too-long cik", () => {
    expect(() => parseTargetsArg(["--target=anthropic:12345678901"])).toThrow(/1-10 digits/);
  });
});
