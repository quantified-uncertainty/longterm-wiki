/**
 * Tests for QUA-423 branded RecordId<T> + runtime predicates in api-types.ts.
 *
 * The QUA-417 bug shipped because getRecordVerdict / getSourcingHref accepted
 * any string as recordId — a composite React key (`${owner}-${record}`) was
 * silently accepted, every verdict lookup missed, every dot rendered as
 * "unchecked" and 404'd. This suite locks in the runtime defense.
 */
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
} from "../api-types.js";

describe("VALID_RECORD_TYPES", () => {
  it("contains the known sourcing types", () => {
    expect(VALID_RECORD_TYPES).toContain("grant");
    expect(VALID_RECORD_TYPES).toContain("personnel");
    expect(VALID_RECORD_TYPES).toContain("fact");
    expect(VALID_RECORD_TYPES).toContain("wiki-page");
  });

  it("does not contain unregistered types flagged in QUA-416", () => {
    expect(VALID_RECORD_TYPES).not.toContain("entity");
    expect(VALID_RECORD_TYPES).not.toContain("race");
    expect(VALID_RECORD_TYPES).not.toContain("race-candidate");
    expect(VALID_RECORD_TYPES).not.toContain("model-release");
    expect(VALID_RECORD_TYPES).not.toContain("prediction-question");
    expect(VALID_RECORD_TYPES).not.toContain("project");
  });

  it("is frozen in length — adding a type is a schema change", () => {
    expect(VALID_RECORD_TYPES.length).toBe(16);
  });
});

describe("SOURCING_EXEMPT_TYPES invariants", () => {
  it("every exempt type is also a valid record type", () => {
    for (const t of SOURCING_EXEMPT_TYPES) {
      expect(
        (VALID_RECORD_TYPES as readonly string[]).includes(t),
        `exempt type "${t}" missing from VALID_RECORD_TYPES`,
      ).toBe(true);
    }
  });
});

describe("VALID_SOURCE_CHECK_VERDICTS", () => {
  it("does NOT include 'unchecked' — that is a placeholder, not a verdict", () => {
    expect(VALID_SOURCE_CHECK_VERDICTS).not.toContain("unchecked");
  });
});

describe("isValidRecordType", () => {
  it("narrows string to RecordType when valid", () => {
    const raw: string = "grant";
    if (isValidRecordType(raw)) {
      const _typed: RecordType = raw;
      expect(_typed).toBe("grant");
    }
  });

  it("returns false for QUA-416 dead types", () => {
    expect(isValidRecordType("entity")).toBe(false);
    expect(isValidRecordType("race")).toBe(false);
    expect(isValidRecordType("model-release")).toBe(false);
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

  it("excludes all SOURCING_EXEMPT_TYPES by construction", () => {
    for (const exempt of SOURCING_EXEMPT_TYPES) {
      expect(
        isLinkableSourcingType(exempt),
        `exempt type "${exempt}" should not be linkable`,
      ).toBe(false);
    }
  });
});

describe("asRecordId — QUA-423", () => {
  it("accepts valid PK shapes", () => {
    // Brand is erased at runtime; value is the same string.
    expect(asRecordId("grant", "8NUnVSueLS")).toBe("8NUnVSueLS");
    expect(asRecordId("personnel", "sid_A4XoubikkQ")).toBe("sid_A4XoubikkQ");
    expect(asRecordId("fact", "f_mEKUPPFYRg")).toBe("f_mEKUPPFYRg");
    expect(asRecordId("funding-round", "42")).toBe("42");
    expect(asRecordId("wiki-page", "anthropic")).toBe("anthropic");
  });

  it("throws on empty strings", () => {
    expect(() => asRecordId("grant", "")).toThrow(InvalidRecordIdError);
  });

  it("throws on excessively long strings", () => {
    expect(() => asRecordId("grant", "x".repeat(201))).toThrow(
      /length 201 exceeds 200/,
    );
  });

  it("throws on the exact QUA-417 composite-key shape", () => {
    // conn.key = `${ownerEntityId}-${record.key}`
    expect(() => asRecordId("grant", "sid_ULjDXpSLCI-8NUnVSueLS")).toThrow(
      /composite React key/,
    );
  });

  it("throws on sid_X-sid_Y composites", () => {
    expect(() => asRecordId("grant", "sid_abc-sid_def")).toThrow(
      InvalidRecordIdError,
    );
  });

  it("throws on two-multi-digit-numeric composites", () => {
    expect(() => asRecordId("funding-round", "12345-67890")).toThrow(
      /composite/,
    );
  });

  it("does NOT flag legitimate hyphenated slugs (false-positive guard)", () => {
    expect(() => asRecordId("wiki-page", "some-name-2024")).not.toThrow();
    expect(() => asRecordId("publication", "arxiv-2310-12345")).not.toThrow();
    expect(() => asRecordId("grant", "1-2")).not.toThrow();
    expect(() => asRecordId("personnel", "a-b-c-d")).not.toThrow();
  });

  it("error message references QUA-417 for debuggability", () => {
    try {
      asRecordId("grant", "sid_abc-sid_def");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidRecordIdError);
      const err = e as InvalidRecordIdError;
      expect(err.recordType).toBe("grant");
      expect(err.rawId).toBe("sid_abc-sid_def");
      expect(err.message).toMatch(/QUA-417/);
    }
  });
});

describe("isCandidateRecordId", () => {
  it("accepts the same shapes asRecordId accepts", () => {
    expect(isCandidateRecordId("8NUnVSueLS")).toBe(true);
    expect(isCandidateRecordId("sid_A4XoubikkQ")).toBe(true);
    expect(isCandidateRecordId("some-name-2024")).toBe(true);
  });

  it("rejects what asRecordId throws on", () => {
    expect(isCandidateRecordId("")).toBe(false);
    expect(isCandidateRecordId("x".repeat(201))).toBe(false);
    expect(isCandidateRecordId("sid_abc-sid_def")).toBe(false);
    expect(isCandidateRecordId("sid_ULjDXpSLCI-8NUnVSueLS")).toBe(false);
    expect(isCandidateRecordId("12345-67890")).toBe(false);
  });

  it("rejects non-string inputs without throwing", () => {
    expect(isCandidateRecordId(undefined)).toBe(false);
    expect(isCandidateRecordId(null)).toBe(false);
    expect(isCandidateRecordId(42)).toBe(false);
    expect(isCandidateRecordId({})).toBe(false);
  });

  it("narrows unknown → string via type guard", () => {
    const raw: unknown = "8NUnVSueLS";
    if (isCandidateRecordId(raw)) {
      const _s: string = raw;
      expect(_s).toBe("8NUnVSueLS");
    }
  });
});

describe("RecordId<T> type distinctness (compile-time)", () => {
  it("treats different record types as distinct branded types", () => {
    const grantId: RecordId<"grant"> = asRecordId("grant", "g1");
    const personnelId: RecordId<"personnel"> = asRecordId("personnel", "p1");

    function takeGrant(id: RecordId<"grant">): string {
      return id;
    }
    expect(takeGrant(grantId)).toBe("g1");
    // takeGrant(personnelId);  ← would not compile: types incompatible

    // Brand is erased at runtime.
    expect(grantId).toBe("g1");
    expect(personnelId).toBe("p1");
  });
});
