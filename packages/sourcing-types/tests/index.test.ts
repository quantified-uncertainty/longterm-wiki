import { describe, it, expect } from "vitest";
import {
  VALID_RECORD_TYPES,
  SOURCING_EXEMPT_TYPES,
  VALID_SOURCE_CHECK_VERDICTS,
  isSourcingExempt,
  isValidRecordType,
  isLinkableSourcingType,
  type RecordType,
  type SourcingExemptType,
  type SourcingVerdict,
} from "../src/index.js";

describe("VALID_RECORD_TYPES", () => {
  it("contains the known sourcing types", () => {
    expect(VALID_RECORD_TYPES).toContain("grant");
    expect(VALID_RECORD_TYPES).toContain("personnel");
    expect(VALID_RECORD_TYPES).toContain("fact");
    expect(VALID_RECORD_TYPES).toContain("wiki-page");
  });

  it("does not contain unregistered types flagged in QUA-416", () => {
    // These are types the UI tried to link to but the backend never stored.
    expect(VALID_RECORD_TYPES).not.toContain("entity");
    expect(VALID_RECORD_TYPES).not.toContain("race");
    expect(VALID_RECORD_TYPES).not.toContain("race-candidate");
    expect(VALID_RECORD_TYPES).not.toContain("model-release");
    expect(VALID_RECORD_TYPES).not.toContain("prediction-question");
    expect(VALID_RECORD_TYPES).not.toContain("project");
  });

  it("is frozen in length — adding a type is a schema change", () => {
    // Adjust this when the sourcing pipeline genuinely grows a new type.
    // The explicit count catches silent removals via merge conflict.
    expect(VALID_RECORD_TYPES.length).toBe(16);
  });
});

describe("SOURCING_EXEMPT_TYPES", () => {
  it("contains the four known exempt types", () => {
    expect([...SOURCING_EXEMPT_TYPES].sort()).toEqual([
      "benchmark-result",
      "citation",
      "entity-assessment",
      "secondary-market-price",
    ]);
  });

  it("every exempt type is also a valid record type (invariant)", () => {
    // If this fails, either the exempt list references a nonexistent type
    // or VALID_RECORD_TYPES dropped one without updating exempts.
    for (const t of SOURCING_EXEMPT_TYPES) {
      expect(
        (VALID_RECORD_TYPES as readonly string[]).includes(t),
        `exempt type "${t}" missing from VALID_RECORD_TYPES`,
      ).toBe(true);
    }
  });
});

describe("VALID_SOURCE_CHECK_VERDICTS", () => {
  it("matches the five verdict states the LLM pipeline can produce", () => {
    expect([...VALID_SOURCE_CHECK_VERDICTS].sort()).toEqual([
      "confirmed",
      "contradicted",
      "outdated",
      "partial",
      "unverifiable",
    ]);
  });

  it("does NOT include 'unchecked' — that is a placeholder, not a verdict", () => {
    expect(VALID_SOURCE_CHECK_VERDICTS).not.toContain("unchecked");
  });
});

describe("isSourcingExempt", () => {
  it("returns true for known exempt types", () => {
    expect(isSourcingExempt("benchmark-result")).toBe(true);
    expect(isSourcingExempt("citation")).toBe(true);
    expect(isSourcingExempt("entity-assessment")).toBe(true);
    expect(isSourcingExempt("secondary-market-price")).toBe(true);
  });

  it("returns false for non-exempt valid types", () => {
    expect(isSourcingExempt("grant")).toBe(false);
    expect(isSourcingExempt("personnel")).toBe(false);
    expect(isSourcingExempt("fact")).toBe(false);
  });

  it("returns false for unregistered types (no crash)", () => {
    expect(isSourcingExempt("entity")).toBe(false);
    expect(isSourcingExempt("race")).toBe(false);
    expect(isSourcingExempt("")).toBe(false);
  });
});

describe("isValidRecordType", () => {
  it("narrows string to RecordType when valid", () => {
    const raw: string = "grant";
    if (isValidRecordType(raw)) {
      // Compile check: raw is narrowed to RecordType inside the block.
      const _typed: RecordType = raw;
      expect(_typed).toBe("grant");
    }
  });

  it("returns false for unregistered types flagged in QUA-416", () => {
    expect(isValidRecordType("entity")).toBe(false);
    expect(isValidRecordType("race")).toBe(false);
    expect(isValidRecordType("model-release")).toBe(false);
    expect(isValidRecordType("prediction-question")).toBe(false);
    expect(isValidRecordType("project")).toBe(false);
    expect(isValidRecordType("")).toBe(false);
    expect(isValidRecordType("garbage-123")).toBe(false);
  });
});

describe("isLinkableSourcingType", () => {
  it("returns true for valid, non-exempt types", () => {
    expect(isLinkableSourcingType("grant")).toBe(true);
    expect(isLinkableSourcingType("personnel")).toBe(true);
    expect(isLinkableSourcingType("fact")).toBe(true);
    expect(isLinkableSourcingType("wiki-page")).toBe(true);
  });

  it("returns false for exempt types (even though they ARE valid)", () => {
    expect(isLinkableSourcingType("benchmark-result")).toBe(false);
    expect(isLinkableSourcingType("citation")).toBe(false);
    expect(isLinkableSourcingType("entity-assessment")).toBe(false);
    expect(isLinkableSourcingType("secondary-market-price")).toBe(false);
  });

  it("returns false for unregistered types", () => {
    expect(isLinkableSourcingType("entity")).toBe(false);
    expect(isLinkableSourcingType("race")).toBe(false);
    expect(isLinkableSourcingType("model-release")).toBe(false);
    expect(isLinkableSourcingType("project")).toBe(false);
  });

  it("excludes all SOURCING_EXEMPT_TYPES by construction", () => {
    for (const exempt of SOURCING_EXEMPT_TYPES) {
      expect(
        isLinkableSourcingType(exempt),
        `exempt type "${exempt}" should not be linkable`,
      ).toBe(false);
    }
  });
});

describe("type compatibility", () => {
  it("SourcingExemptType is a subset of RecordType (compile check)", () => {
    // Compile-time: if SourcingExemptType includes a value not in RecordType,
    // this assignment fails and the whole test file won't build.
    const exempt: SourcingExemptType = "benchmark-result";
    const asRecordType: RecordType = exempt;
    expect(asRecordType).toBe("benchmark-result");
  });

  it("SourcingVerdict is a string-literal union, not generic string", () => {
    const v: SourcingVerdict = "confirmed";
    expect(v).toBe("confirmed");
  });
});
