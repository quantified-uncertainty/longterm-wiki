import { describe, it, expect } from "vitest";
import {
  VALID_RECORD_TYPES,
  SOURCING_EXEMPT_TYPES,
  VALID_SOURCE_CHECK_VERDICTS,
  isSourcingExempt,
  isValidRecordType,
  isLinkableSourcingType,
  asRecordId,
  isCandidateRecordId,
  InvalidRecordIdError,
  type RecordType,
  type RecordId,
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

// ── Branded RecordId<T> (QUA-423) ─────────────────────────────────────────

describe("asRecordId", () => {
  it("returns the raw string wrapped as RecordId<T> on a valid PK", () => {
    const id = asRecordId("grant", "8NUnVSueLS");
    // Runtime value is the same string; brand is erased at runtime.
    expect(id).toBe("8NUnVSueLS");
    // Compile-time: id is typed as RecordId<"grant"> — test the assignment.
    const grantId: RecordId<"grant"> = id;
    expect(grantId).toBe("8NUnVSueLS");
  });

  it("accepts various real-world PK shapes", () => {
    // sid_-prefixed stableIds (entity PKs in many tables)
    expect(asRecordId("personnel", "sid_A4XoubikkQ")).toBe("sid_A4XoubikkQ");
    // 10-char alphanumeric grant PKs (what prod actually uses)
    expect(asRecordId("grant", "8NUnVSueLS")).toBe("8NUnVSueLS");
    // f_-prefixed fact IDs
    expect(asRecordId("fact", "f_mEKUPPFYRg")).toBe("f_mEKUPPFYRg");
    // Short numeric IDs (funding-round, investment use these)
    expect(asRecordId("funding-round", "42")).toBe("42");
    // Slug-shaped IDs (some legacy rows)
    expect(asRecordId("wiki-page", "anthropic")).toBe("anthropic");
  });

  it("throws on empty strings (caller likely passed undefined)", () => {
    expect(() => asRecordId("grant", "")).toThrow(InvalidRecordIdError);
  });

  it("throws on excessively long strings (likely a URL or title)", () => {
    const tooLong = "x".repeat(201);
    expect(() => asRecordId("grant", tooLong)).toThrow(
      /length 201 exceeds 200/,
    );
  });

  it("throws on composite React keys: sid_X-sid_Y (the QUA-417 bug shape)", () => {
    // This is exactly the value conn.key had in funding-connections.tsx
    // before QUA-417. The runtime guard catches it at the boundary.
    expect(() => asRecordId("grant", "sid_ULjDXpSLCI-8NUnVSueLS")).toThrow(
      /composite React key/,
    );
    expect(() => asRecordId("grant", "sid_abc-sid_def")).toThrow(
      InvalidRecordIdError,
    );
  });

  it("throws on composite numeric-ID shapes: 123-456", () => {
    expect(() => asRecordId("funding-round", "12345-67890")).toThrow(
      /composite/,
    );
  });

  it("does NOT flag legitimate hyphenated slugs (false-positive guard)", () => {
    // These legitimate PK shapes contain hyphens but aren't composite keys.
    expect(() => asRecordId("wiki-page", "some-name-2024")).not.toThrow();
    expect(() => asRecordId("publication", "arxiv-2310-12345")).not.toThrow();
    expect(() => asRecordId("grant", "1-2")).not.toThrow(); // short numeric both sides — not composite
    expect(() => asRecordId("personnel", "a-b-c-d")).not.toThrow();
  });

  it("throws with a clear error message referencing QUA-417", () => {
    try {
      asRecordId("grant", "sid_abc-sid_def");
      throw new Error("expected asRecordId to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidRecordIdError);
      const err = e as InvalidRecordIdError;
      expect(err.recordType).toBe("grant");
      expect(err.rawId).toBe("sid_abc-sid_def");
      expect(err.message).toMatch(/QUA-417/);
    }
  });

  it("enforces recordType at the type level (compile check)", () => {
    // This test passes by compilation — if RecordType drifts from
    // VALID_RECORD_TYPES, the literal below no longer satisfies T.
    const id = asRecordId("grant", "g1");
    const grantId: RecordId<"grant"> = id;
    expect(grantId).toBeDefined();
    // Not assignable across types:
    // const wrong: RecordId<"personnel"> = id;  ← would not compile
  });
});

describe("isCandidateRecordId", () => {
  it("accepts valid PK shapes (same set asRecordId accepts)", () => {
    expect(isCandidateRecordId("8NUnVSueLS")).toBe(true);
    expect(isCandidateRecordId("sid_A4XoubikkQ")).toBe(true);
    expect(isCandidateRecordId("f_mEKUPPFYRg")).toBe(true);
    expect(isCandidateRecordId("some-name-2024")).toBe(true);
  });

  it("rejects what asRecordId would throw on", () => {
    expect(isCandidateRecordId("")).toBe(false);
    expect(isCandidateRecordId("x".repeat(201))).toBe(false);
    expect(isCandidateRecordId("sid_abc-sid_def")).toBe(false);
    expect(isCandidateRecordId("12345-67890")).toBe(false);
  });

  it("rejects non-string inputs without throwing", () => {
    expect(isCandidateRecordId(undefined)).toBe(false);
    expect(isCandidateRecordId(null)).toBe(false);
    expect(isCandidateRecordId(42)).toBe(false);
    expect(isCandidateRecordId({})).toBe(false);
  });

  it("narrows the type to string when true (compile check)", () => {
    const raw: unknown = "8NUnVSueLS";
    if (isCandidateRecordId(raw)) {
      const _s: string = raw; // narrowed to string
      expect(_s).toBe("8NUnVSueLS");
    }
  });
});

describe("RecordId<T> type distinctness (compile-time)", () => {
  it("treats different record types as distinct branded types", () => {
    // These compile — which is the test.
    const grantId: RecordId<"grant"> = asRecordId("grant", "g1");
    const personnelId: RecordId<"personnel"> = asRecordId("personnel", "p1");

    // A function typed to accept only grant IDs can't be called with a
    // personnel ID at compile time:
    function takeGrant(id: RecordId<"grant">): string {
      return id;
    }
    expect(takeGrant(grantId)).toBe("g1");
    // takeGrant(personnelId);  ← would not compile: types incompatible

    // Brand is erased at runtime — strings still equal themselves.
    expect(grantId).toBe("g1");
    expect(personnelId).toBe("p1");
  });
});
