import { describe, it, expect, afterEach, vi } from "vitest";
import { matchGrantee, MANUAL_GRANTEE_OVERRIDES, normalizeGranteeName, buildEntityMatcher } from "../entity-matcher.ts";
import type { EntityMatcher } from "../types.ts";
import * as fs from "fs";

// Note: vi.mock("fs") is hoisted to the top of the file regardless of where
// it appears in the source. If fs mocking is added for buildEntityMatcher tests,
// it will affect ALL tests in this file. Use afterEach(vi.restoreAllMocks) to
// prevent mock leaks between tests.

function makeMockMatcher(map: Record<string, string>): EntityMatcher {
  const nameMap = new Map(
    Object.entries(map).map(([name, stableId]) => [
      name.toLowerCase(),
      { stableId, slug: name, name },
    ])
  );
  return {
    allNames: nameMap,
    match: (name: string) => nameMap.get(name.toLowerCase().trim()) || null,
  };
}

describe("matchGrantee", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const matcher = makeMockMatcher({
    miri: "abc123",
    anthropic: "def456",
    arc: "ghi789",
    "center-for-ai-safety": "jkl012",
    cset: "mno345",
    elicit: "pqr678",
  });

  it("matches via manual override", () => {
    // "Machine Intelligence Research Institute" → "miri" → "abc123"
    expect(matchGrantee("Machine Intelligence Research Institute", matcher)).toBe("abc123");
  });

  it("matches via override acronym", () => {
    expect(matchGrantee("MIRI", matcher)).toBe("abc123");
  });

  it("returns null for unknown name", () => {
    expect(matchGrantee("Totally Unknown Org", matcher)).toBeNull();
  });

  it("matches directly when no override exists", () => {
    expect(matchGrantee("Anthropic", matcher)).toBe("def456");
  });

  it("prefers override over direct match when both exist", () => {
    // "ARC" override maps to "arc" slug which resolves to ghi789
    expect(matchGrantee("ARC", matcher)).toBe("ghi789");
  });

  it("accepts extra overrides", () => {
    const result = matchGrantee("Custom Org", matcher, { "Custom Org": "miri" });
    expect(result).toBe("abc123");
  });

  it("extra overrides take precedence over built-in", () => {
    const result = matchGrantee("MIRI", matcher, { MIRI: "cset" });
    expect(result).toBe("mno345");
  });

  it("includes FTX-specific overrides", () => {
    expect(MANUAL_GRANTEE_OVERRIDES["Ought"]).toBe("elicit");
    expect(MANUAL_GRANTEE_OVERRIDES["Quantified Uncertainty Research Institute"]).toBe("quri");
  });

  it("matches after stripping Inc. suffix", () => {
    // "Anthropic, Inc." normalizes to "Anthropic" which has an override
    expect(matchGrantee("Anthropic, Inc.", matcher)).toBe("def456");
  });

  it("matches after stripping LLC suffix", () => {
    const matcherWithOpenAI = makeMockMatcher({
      ...Object.fromEntries(
        Object.entries({ miri: "abc123", anthropic: "def456", arc: "ghi789", "center-for-ai-safety": "jkl012", cset: "mno345", elicit: "pqr678", openai: "oai999" })
      ),
    });
    expect(matchGrantee("OpenAI, LLC", matcherWithOpenAI)).toBe("oai999");
  });

  it("matches after stripping Foundation suffix", () => {
    const matcherWithGoodVentures = makeMockMatcher({
      "good-ventures": "gv001",
    });
    expect(matchGrantee("Good Ventures Foundation", matcherWithGoodVentures)).toBe("gv001");
  });

  it("does not strip suffix from middle of name", () => {
    // "Foundation for Something" should not become "for Something"
    const result = matchGrantee("Foundation for Something", matcher);
    expect(result).toBeNull();
  });
});

describe("normalizeGranteeName", () => {
  it("strips ', Inc.' suffix", () => {
    expect(normalizeGranteeName("Anthropic, Inc.")).toBe("Anthropic");
  });

  it("strips ', Inc' suffix (no period)", () => {
    expect(normalizeGranteeName("OpenAI, Inc")).toBe("OpenAI");
  });

  it("strips ' LLC' suffix", () => {
    expect(normalizeGranteeName("OpenAI Global LLC")).toBe("OpenAI Global");
  });

  it("strips ', LLC' suffix", () => {
    expect(normalizeGranteeName("SomeOrg, LLC")).toBe("SomeOrg");
  });

  it("strips ' Ltd.' suffix", () => {
    expect(normalizeGranteeName("DeepMind Ltd.")).toBe("DeepMind");
  });

  it("strips ' Foundation' suffix", () => {
    expect(normalizeGranteeName("Good Ventures Foundation")).toBe("Good Ventures");
  });

  it("strips ' Corporation' suffix", () => {
    expect(normalizeGranteeName("Microsoft Corporation")).toBe("Microsoft");
  });

  it("strips ' Corp.' suffix", () => {
    expect(normalizeGranteeName("RAND Corp.")).toBe("RAND");
  });

  it("strips ' Incorporated' suffix", () => {
    expect(normalizeGranteeName("Something Incorporated")).toBe("Something");
  });

  it("is case-insensitive for suffix matching", () => {
    expect(normalizeGranteeName("SomeOrg, INC.")).toBe("SomeOrg");
    expect(normalizeGranteeName("SomeOrg, llc")).toBe("SomeOrg");
  });

  it("returns name unchanged when no suffix", () => {
    expect(normalizeGranteeName("Anthropic")).toBe("Anthropic");
  });

  it("handles whitespace-only names", () => {
    expect(normalizeGranteeName("  ")).toBe("");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeGranteeName("  Anthropic, Inc.  ")).toBe("Anthropic");
  });

  it("only strips one suffix", () => {
    // "Org Inc. Foundation" — strips Foundation (matched first due to suffix ordering)
    expect(normalizeGranteeName("Org Inc Foundation")).toBe("Org Inc");
  });

  it("does not strip partial word matches", () => {
    // "Incubator" should not match "Inc"
    expect(normalizeGranteeName("AI Incubator")).toBe("AI Incubator");
  });
});

describe("MANUAL_GRANTEE_OVERRIDES coverage", () => {
  it("maps major AI safety orgs", () => {
    expect(MANUAL_GRANTEE_OVERRIDES["MIRI"]).toBe("miri");
    expect(MANUAL_GRANTEE_OVERRIDES["ARC"]).toBe("arc");
    expect(MANUAL_GRANTEE_OVERRIDES["METR"]).toBe("metr");
    expect(MANUAL_GRANTEE_OVERRIDES["CAIS"]).toBe("cais");
    expect(MANUAL_GRANTEE_OVERRIDES["Apollo Research"]).toBe("apollo-research");
    expect(MANUAL_GRANTEE_OVERRIDES["Conjecture"]).toBe("conjecture");
    expect(MANUAL_GRANTEE_OVERRIDES["Goodfire"]).toBe("goodfire");
  });

  it("maps policy/governance orgs", () => {
    expect(MANUAL_GRANTEE_OVERRIDES["FHI"]).toBe("fhi");
    expect(MANUAL_GRANTEE_OVERRIDES["CSER"]).toBe("cser");
    expect(MANUAL_GRANTEE_OVERRIDES["FLI"]).toBe("fli");
    expect(MANUAL_GRANTEE_OVERRIDES["CLTR"]).toBe("centre-for-long-term-resilience");
    expect(MANUAL_GRANTEE_OVERRIDES["GPAI"]).toBe("gpai");
    expect(MANUAL_GRANTEE_OVERRIDES["Pause AI"]).toBe("pause-ai");
  });

  it("maps EA orgs", () => {
    expect(MANUAL_GRANTEE_OVERRIDES["CEA"]).toBe("cea");
    expect(MANUAL_GRANTEE_OVERRIDES["GWWC"]).toBe("giving-what-we-can");
    expect(MANUAL_GRANTEE_OVERRIDES["Effective Ventures"]).toBe("cea");
    expect(MANUAL_GRANTEE_OVERRIDES["EA Global"]).toBe("ea-global");
  });

  it("maps funders", () => {
    expect(MANUAL_GRANTEE_OVERRIDES["Open Phil"]).toBe("coefficient-giving");
    expect(MANUAL_GRANTEE_OVERRIDES["SFF"]).toBe("sff");
    expect(MANUAL_GRANTEE_OVERRIDES["LTFF"]).toBe("ltff");
    expect(MANUAL_GRANTEE_OVERRIDES["CZI"]).toBe("chan-zuckerberg-initiative");
    expect(MANUAL_GRANTEE_OVERRIDES["Schmidt Futures"]).toBe("schmidt-futures");
  });

  it("maps forecasting orgs", () => {
    expect(MANUAL_GRANTEE_OVERRIDES["QURI"]).toBe("quri");
    expect(MANUAL_GRANTEE_OVERRIDES["Forecasting Research Institute"]).toBe("fri");
    expect(MANUAL_GRANTEE_OVERRIDES["Samotsvety"]).toBe("samotsvety");
  });

  it("maps biosecurity orgs", () => {
    expect(MANUAL_GRANTEE_OVERRIDES["NTI"]).toBe("nti-bio");
    expect(MANUAL_GRANTEE_OVERRIDES["SecureDNA"]).toBe("securedna");
    expect(MANUAL_GRANTEE_OVERRIDES["IBBIS"]).toBe("ibbis");
    expect(MANUAL_GRANTEE_OVERRIDES["CEPI"]).toBe("coalition-for-epidemic-preparedness-innovations");
    expect(MANUAL_GRANTEE_OVERRIDES["CFAR"]).toBe("center-for-applied-rationality");
  });

  it("maps tech companies", () => {
    expect(MANUAL_GRANTEE_OVERRIDES["Google DeepMind"]).toBe("deepmind");
    expect(MANUAL_GRANTEE_OVERRIDES["Microsoft"]).toBe("microsoft");
    expect(MANUAL_GRANTEE_OVERRIDES["NVIDIA"]).toBe("nvidia");
    expect(MANUAL_GRANTEE_OVERRIDES["Meta AI"]).toBe("meta-ai");
  });

  it("maps name variants for OpenAI", () => {
    expect(MANUAL_GRANTEE_OVERRIDES["OpenAI"]).toBe("openai");
    expect(MANUAL_GRANTEE_OVERRIDES["OpenAI LP"]).toBe("openai");
    expect(MANUAL_GRANTEE_OVERRIDES["OpenAI Global, LLC"]).toBe("openai");
  });

  it("maps name variants for Anthropic", () => {
    expect(MANUAL_GRANTEE_OVERRIDES["Anthropic"]).toBe("anthropic");
    expect(MANUAL_GRANTEE_OVERRIDES["Anthropic PBC"]).toBe("anthropic");
  });
});

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof fs>("fs");
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

describe("buildEntityMatcher — missing files", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("handles missing factbase-data.json gracefully", () => {
    const readMock = vi.mocked(fs.readFileSync);
    readMock.mockImplementation((path: fs.PathOrFileDescriptor) => {
      const pathStr = String(path);
      if (pathStr.includes("factbase-data.json")) {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      if (pathStr.includes("database.json")) {
        return JSON.stringify({ typedEntities: [] });
      }
      throw new Error(`Unexpected read: ${pathStr}`);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const matcher = buildEntityMatcher();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("factbase-data.json not found")
    );
    expect(matcher.match("Nonexistent Org")).toBeNull();
    expect(matcher.allNames.size).toBe(0);
  });

  it("handles missing database.json gracefully", () => {
    const readMock = vi.mocked(fs.readFileSync);
    readMock.mockImplementation((path: fs.PathOrFileDescriptor) => {
      const pathStr = String(path);
      if (pathStr.includes("factbase-data.json")) {
        return JSON.stringify({ slugToEntityId: {}, entities: {} });
      }
      if (pathStr.includes("database.json")) {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      throw new Error(`Unexpected read: ${pathStr}`);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const matcher = buildEntityMatcher();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("database.json not found")
    );
    expect(matcher.match("Nonexistent Org")).toBeNull();
  });

  it("handles both files missing gracefully", () => {
    const readMock = vi.mocked(fs.readFileSync);
    readMock.mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const matcher = buildEntityMatcher();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(matcher.allNames.size).toBe(0);
    expect(matcher.match("anything")).toBeNull();
  });

  it("re-throws non-ENOENT errors", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    expect(() => buildEntityMatcher()).toThrow("EACCES: permission denied");
  });
});
