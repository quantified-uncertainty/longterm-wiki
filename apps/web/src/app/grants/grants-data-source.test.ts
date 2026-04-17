import { describe, it, expect } from "vitest";
import { inferDataSource } from "./grants-data-source";

describe("inferDataSource", () => {
  it("returns null for null/empty input", () => {
    expect(inferDataSource(null)).toBeNull();
    expect(inferDataSource("")).toBeNull();
  });

  it("returns null for URLs that don't match any pattern", () => {
    expect(inferDataSource("https://example.com/some-grant")).toBeNull();
    expect(inferDataSource("https://anthropic.com/news/grant")).toBeNull();
  });

  it("matches Coefficient Giving URLs", () => {
    const ds = inferDataSource(
      "https://coefficientgiving.org/wp-content/uploads/grants.csv",
    );
    expect(ds).toEqual({
      id: "coefficient-giving",
      name: "Coefficient Giving",
      resourceId: "28c67bc404f6c25d",
    });
  });

  it("is case-insensitive", () => {
    const ds = inferDataSource("HTTPS://COEFFICIENTGIVING.ORG/grants");
    expect(ds?.id).toBe("coefficient-giving");
  });

  it("matches EA Funds across both URL forms", () => {
    expect(inferDataSource("https://funds.effectivealtruism.org/funds/ai")?.id).toBe("ea-funds");
    expect(inferDataSource("https://effectivealtruism.org/post")?.id).toBe("ea-funds");
  });

  it("matches each known pattern to a data source id that the /data-sources/[id] route can resolve", () => {
    // The ids below must match real data source slugs on prod.
    const cases: Array<[string, string]> = [
      ["https://survivalandflourishing.fund/sff-2024", "sff"],
      ["https://manifund.org/projects/foo", "manifund"],
      ["https://www.gatesfoundation.org/grants/x", "gates-foundation"],
      ["https://www.givewell.org/research/foo", "givewell"],
      ["https://futureoflife.org/grants/ai-safety", "fli"],
      ["https://astralcodexten.substack.com/p/acx-grants", "acx-grants"],
      ["https://ftxfuturefund.org/grants", "ftx-future-fund"],
      ["https://ftx.com/foundation", "ftx-future-fund"],
      ["https://www.aria.org.uk/programmes/safeguarded-ai", "aria"],
      ["https://wellcome.org/grant-funding", "wellcome-trust"],
      ["https://www.fordfoundation.org/work/our-grants", "ford-foundation"],
      ["https://donations.vipulnaik.com/donors", "vipulnaik"],
      ["https://foresight.org/prize", "foresight-prizes"],
    ];
    for (const [url, expectedId] of cases) {
      expect(inferDataSource(url)?.id, `URL: ${url}`).toBe(expectedId);
    }
  });
});
