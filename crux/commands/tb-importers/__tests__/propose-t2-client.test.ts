import { describe, it, expect } from "vitest";
import {
  buildT2ProposeRequest,
  validateT2Proposal,
  deriveRecordId,
  hashContent,
  submitT2Proposal,
  type T2EnrichmentProposal,
} from "../propose-t2-client.ts";

const HEX64 =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const QUOTE =
  "Jane Smith is the Chief Scientist at ExampleCorp and has led the safety team since 2022.";

const VALID_T2: T2EnrichmentProposal = {
  recordType: "personnel",
  record: {
    role: "Chief Scientist",
    roleType: "leadership",
    personDisplayName: "Jane Smith",
    orgDisplayName: "ExampleCorp",
    source: "https://example.com/team",
    notes: "Extracted from /team (T2)",
    isFounder: false,
  },
  sourceUrl: "https://example.com/team",
  responseHash: HEX64,
  sourceContent: `About us... Our leadership team. ${QUOTE} We are based in SF.`,
  quotedText: QUOTE,
  verdict: "confirmed",
  checkerModel: "claude-haiku-4-5-20251001",
  confidence: 0.9,
  entityRefs: { organization: "example-corp", person: "Jane Smith" },
};

describe("validateT2Proposal", () => {
  it("returns null on a fully-valid proposal", () => {
    expect(validateT2Proposal(VALID_T2)).toBeNull();
  });

  it("rejects missing sourceUrl/responseHash/sourceContent", () => {
    expect(validateT2Proposal({ ...VALID_T2, sourceUrl: "" })).toMatch(
      /missing required/,
    );
    expect(validateT2Proposal({ ...VALID_T2, responseHash: "" })).toMatch(
      /missing required/,
    );
    expect(validateT2Proposal({ ...VALID_T2, sourceContent: "" })).toMatch(
      /missing required/,
    );
  });

  it("rejects missing verdict/quotedText/checkerModel", () => {
    expect(
      validateT2Proposal({ ...VALID_T2, quotedText: "" }),
    ).toMatch(/missing required/);
    expect(
      validateT2Proposal({ ...VALID_T2, checkerModel: "" }),
    ).toMatch(/missing required/);
  });

  it("rejects quotes shorter than 40 chars", () => {
    expect(
      validateT2Proposal({ ...VALID_T2, quotedText: "too short" }),
    ).toMatch(/too short/);
  });

  it("rejects quotes that are not substrings of sourceContent", () => {
    expect(
      validateT2Proposal({
        ...VALID_T2,
        quotedText:
          "A fabricated quote that does not appear anywhere in the real source text.",
      }),
    ).toMatch(/not a verbatim substring/);
  });

  it("whitespace-tolerant: collapses whitespace and casing when checking", () => {
    const proposal: T2EnrichmentProposal = {
      ...VALID_T2,
      sourceContent: `About us. ${QUOTE.toUpperCase()} More stuff.`,
      quotedText: QUOTE, // same content, different case
    };
    expect(validateT2Proposal(proposal)).toBeNull();
  });
});

describe("deriveRecordId", () => {
  it("returns first 10 chars of hex hash", () => {
    expect(deriveRecordId(HEX64)).toBe("abcdef0123");
  });

  it("rejects non-hex input", () => {
    expect(() => deriveRecordId("not-a-hash")).toThrow(/hex/);
  });

  it("rejects hashes under 10 chars", () => {
    expect(() => deriveRecordId("abc")).toThrow(/hex/);
  });
});

describe("hashContent", () => {
  it("produces a 64-char lowercase hex hash", () => {
    const h = hashContent("hello world");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashContent("x")).toBe(hashContent("x"));
    expect(hashContent("x")).not.toBe(hashContent("y"));
  });
});

describe("buildT2ProposeRequest", () => {
  it("produces a request with all T2-specific fields set", () => {
    const req = buildT2ProposeRequest(VALID_T2);
    expect(req.tier).toBe("T2");
    expect(req.recordType).toBe("personnel");
    expect(req.sourceUrl).toBe(VALID_T2.sourceUrl);
    expect(req.sourceContentHash).toBe(HEX64);
    expect(req.sourceContent).toBe(VALID_T2.sourceContent);
    expect(req.quotedText).toBe(QUOTE);
    expect(req.verdict).toBe("confirmed");
    expect(req.checkerModel).toBe("claude-haiku-4-5-20251001");
    expect(req.confidence).toBe(0.9);
    expect(req.row.id).toBe("abcdef0123");
  });

  it("maps entityRefs.organization → row.organizationId for personnel", () => {
    const req = buildT2ProposeRequest(VALID_T2);
    expect(req.row.organizationId).toBe("example-corp");
    expect(req.row.personId).toBe("Jane Smith");
  });

  it("does not overwrite an explicit row value with entityRefs", () => {
    const proposal: T2EnrichmentProposal = {
      ...VALID_T2,
      record: { ...VALID_T2.record, organizationId: "preset-org" },
    };
    const req = buildT2ProposeRequest(proposal);
    expect(req.row.organizationId).toBe("preset-org");
  });

  it("includes runId when provided", () => {
    const req = buildT2ProposeRequest(VALID_T2, { runId: "qua-642-run-1" });
    expect(req.runId).toBe("qua-642-run-1");
  });

  it("omits confidence and reasoning when not provided", () => {
    const noConf = { ...VALID_T2, confidence: undefined };
    const req = buildT2ProposeRequest(noConf);
    expect("confidence" in req).toBe(false);
    expect("reasoning" in req).toBe(false);
  });
});

describe("submitT2Proposal", () => {
  it("returns dry-run pending when submit is false (default)", async () => {
    const result = await submitT2Proposal(VALID_T2, { submit: false });
    expect(result.status).toBe("pending");
    expect(result.reason).toBe("dry-run");
  });

  it("rejects invalid proposals locally without a round trip", async () => {
    const bad = { ...VALID_T2, quotedText: "tiny" };
    const result = await submitT2Proposal(bad, { submit: true });
    expect(result.status).toBe("rejected");
    expect(result.reason).toMatch(/too short/);
  });
});
