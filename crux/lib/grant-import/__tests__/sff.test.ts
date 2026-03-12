import { describe, it, expect } from "vitest";
import { parseSFFAmount, sffRoundToDate } from "../sources/sff.ts";

describe("parseSFFAmount", () => {
  it("parses simple amount", () => {
    expect(parseSFFAmount("$79,000")).toBe(79000);
  });

  it("parses amount with matching pledge", () => {
    expect(parseSFFAmount("$1,535,000 +$500,000\u2021")).toBe(2035000);
  });

  it("parses dual-source amount", () => {
    expect(parseSFFAmount("$1,094,000 and $135,000")).toBe(1229000);
  });

  it("parses amount with dagger only", () => {
    expect(parseSFFAmount("$1,607,000\u2021")).toBe(1607000);
  });

  it("returns null for non-dollar string", () => {
    expect(parseSFFAmount("TBD")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSFFAmount("")).toBeNull();
  });
});

describe("sffRoundToDate", () => {
  it("parses SFF-YYYY", () => {
    expect(sffRoundToDate("SFF-2025")).toBe("2025");
  });

  it("parses SFF-YYYY-H1", () => {
    expect(sffRoundToDate("SFF-2023-H1")).toBe("2023-01");
  });

  it("parses SFF-YYYY-H2", () => {
    expect(sffRoundToDate("SFF-2023-H2")).toBe("2023-07");
  });

  it("parses SFF-YYYY-Q3", () => {
    expect(sffRoundToDate("SFF-2019-Q3")).toBe("2019-07");
  });

  it("parses SFF-YYYY-Q4", () => {
    expect(sffRoundToDate("SFF-2019-Q4")).toBe("2019-10");
  });

  it("parses SFF-YYYY-FlexHEGs", () => {
    expect(sffRoundToDate("SFF-2024-FlexHEGs")).toBe("2024");
  });

  it("parses Initiative Committee YYYY", () => {
    expect(sffRoundToDate("Initiative Committee 2024")).toBe("2024");
  });

  it("returns null for unrecognized format", () => {
    expect(sffRoundToDate("Something Else")).toBeNull();
  });
});
