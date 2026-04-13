import { describe, it, expect } from "vitest";
import { sanitizeRawIds } from "../sanitize-raw-ids";

// QUA-397: regression tests for the render-layer raw-ID sanitizer.
// These codify the exact leak shapes observed on prod via the no-raw-ids
// Playwright suite (`apps/web/e2e/no-raw-ids.spec.ts`).

describe("sanitizeRawIds", () => {
  describe("prefix stripping", () => {
    it("strips `f_xxx — Entity` prefix, leaving just the entity name", () => {
      expect(sanitizeRawIds("f_mEKUPPFYRg — Google DeepMind")).toBe("Google DeepMind");
    });

    it("strips `f_xxx: value` prefix, leaving just the value", () => {
      expect(sanitizeRawIds("f_mEKUPPFYRg: 2010-09")).toBe("2010-09");
    });

    it("strips legacy 8-char hex prefix (`e7c42d88: value`)", () => {
      expect(sanitizeRawIds("e7c42d88: $1,000,000")).toBe("$1,000,000");
    });

    it("strips legacy 12-char hex prefix", () => {
      expect(sanitizeRawIds("a8c71e05abcd — Anthropic")).toBe("Anthropic");
    });

    it("handles single hyphen + space between id and value", () => {
      expect(sanitizeRawIds("f_qR5tY9wE1a - Some Title")).toBe("Some Title");
    });
  });

  describe("embedded id masking", () => {
    it("masks a bare f_ id", () => {
      expect(sanitizeRawIds("f_mEKUPPFYRg")).toBe("\u2026");
    });

    it("masks a bare sid_ id", () => {
      expect(sanitizeRawIds("sid_Aqcyu3onCA")).toBe("\u2026");
    });

    it("masks each element of a ref-list CSV (the QUA-397 `founded-by` case)", () => {
      expect(
        sanitizeRawIds("sid_Aqcyu3onCA, sid_muueuPOHfg, sid_DBq1ddu8Mg"),
      ).toBe("\u2026, \u2026, \u2026");
    });

    it("masks embedded ids without touching surrounding text", () => {
      expect(sanitizeRawIds("see fact f_mEKUPPFYRg for details")).toBe(
        "see fact \u2026 for details",
      );
    });
  });

  describe("passthrough for clean values", () => {
    it("leaves a normal entity name untouched", () => {
      expect(sanitizeRawIds("Google DeepMind")).toBe("Google DeepMind");
    });

    it("leaves a property slug untouched", () => {
      expect(sanitizeRawIds("founded-date")).toBe("founded-date");
    });

    it("leaves a numeric value untouched", () => {
      expect(sanitizeRawIds("6000")).toBe("6000");
    });

    it("leaves URLs untouched", () => {
      expect(sanitizeRawIds("https://en.wikipedia.org/wiki/Google_DeepMind")).toBe(
        "https://en.wikipedia.org/wiki/Google_DeepMind",
      );
    });

    it("leaves a value containing legitimate short hex (git sha fragment) untouched", () => {
      // 7 chars is below the 8-char minimum for legacy fact id matching.
      expect(sanitizeRawIds("abc1234 commit")).toBe("abc1234 commit");
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(sanitizeRawIds("")).toBe("");
    });

    it("handles a value that is only an id prefix with no remainder", () => {
      // Strips the prefix; leaves an empty remainder. Not a bug — the row
      // renderer will show it as empty, which is preferable to leaking.
      expect(sanitizeRawIds("f_mEKUPPFYRg: ")).toBe("");
    });

    it("does not strip an id when it is mid-string (requires prefix position)", () => {
      // Only the LEADING id gets stripped as a prefix. Mid-string ids fall
      // through to the embedded-mask pass and become ellipses.
      expect(sanitizeRawIds("value: f_mEKUPPFYRg")).toBe("value: \u2026");
    });

    it("handles consecutive embedded ids", () => {
      expect(sanitizeRawIds("f_aaaaaaaa f_bbbbbbbb")).toBe("\u2026 \u2026");
    });

    it("leaves short strings that look like id prefixes alone (< 8 chars)", () => {
      expect(sanitizeRawIds("f_short")).toBe("f_short");
      expect(sanitizeRawIds("sid_xx")).toBe("sid_xx");
    });
  });

  describe("QUA-397 — exact leak patterns from failing test output", () => {
    // These are the literal text fragments from the failing CI run
    // (E2E Post-Deploy Smoke Tests run 24359067965).
    it("handles the DeepMind title leak", () => {
      const leak = "f_mEKUPPFYRg — Google DeepMind";
      expect(sanitizeRawIds(leak)).not.toMatch(/\bf_[A-Za-z0-9]{8,}\b/);
      expect(sanitizeRawIds(leak)).not.toMatch(/\bsid_[A-Za-z0-9]{10}\b/);
    });

    it("handles the DeepMind description leak", () => {
      const leak = "f_mEKUPPFYRg: 2010-09";
      expect(sanitizeRawIds(leak)).not.toMatch(/\bf_[A-Za-z0-9]{8,}\b/);
    });

    it("handles the DeepMind founders ref-list leak", () => {
      const leak = "sid_Aqcyu3onCA, sid_muueuPOHfg, sid_DBq1ddu8Mg";
      expect(sanitizeRawIds(leak)).not.toMatch(/\bsid_[A-Za-z0-9]{10}\b/);
    });

    it("handles a compound leak (prefix + ref-list value)", () => {
      const leak = "f_xyz12345: sid_Aqcyu3onCA, sid_muueuPOHfg";
      const cleaned = sanitizeRawIds(leak);
      expect(cleaned).not.toMatch(/\bf_[A-Za-z0-9]{8,}\b/);
      expect(cleaned).not.toMatch(/\bsid_[A-Za-z0-9]{10}\b/);
    });
  });
});
