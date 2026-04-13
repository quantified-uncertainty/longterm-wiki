import { describe, it, expect } from "vitest";
import {
  sanitizeRawIds,
  isClickableFactId,
  isOpaqueLegacyFactId,
  isLegacyResourceId,
} from "../sanitize-raw-ids";

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

  describe("isClickableFactId — URL-resolvable formats only", () => {
    it("accepts canonical f_ fact IDs in any column", () => {
      expect(isClickableFactId("f_mEKUPPFYRg", "fact_id")).toBe(true);
      expect(isClickableFactId("f_mEKUPPFYRg", "id")).toBe(true);
      expect(isClickableFactId("f_mEKUPPFYRg", "random_column")).toBe(true);
    });

    it("accepts legacy 8-12 char lowercase hex in fact-id columns", () => {
      expect(isClickableFactId("e7c42d88", "fact_id")).toBe(true);
      expect(isClickableFactId("f2a06bd3", "factId")).toBe(true);
      expect(isClickableFactId("a8c71e05abcd", "id")).toBe(true);
    });

    it("rejects legacy hex in non-fact-id columns", () => {
      expect(isClickableFactId("e7c42d88", "resource_id")).toBe(false);
      expect(isClickableFactId("e7c42d88", "description")).toBe(false);
    });

    it("rejects 10-char mixed-case alnum legacy IDs — those 404 unreliably on prod", () => {
      // Measured: /factbase/fact/2Y4ope8OxA → 404, /factbase/fact/RYUAwpW0fA → 200
      // Linking this format would point half of users at broken pages.
      expect(isClickableFactId("2Y4ope8OxA", "fact_id")).toBe(false);
      expect(isClickableFactId("XUSIG6vsPw", "fact_id")).toBe(false);
      expect(isClickableFactId("RYUAwpW0fA", "fact_id")).toBe(false);
    });

    it("rejects non-fact shapes", () => {
      expect(isClickableFactId("sid_Aqcyu3onCA", "fact_id")).toBe(false);
      expect(isClickableFactId("1f21fae8ed666710", "fact_id")).toBe(false); // 16-hex
      expect(isClickableFactId("Anthropic", "fact_id")).toBe(false);
    });
  });

  describe("isOpaqueLegacyFactId — 10-char mixed-case alnum, no link", () => {
    it("accepts 10-char mixed-case with upper+lower+digit in fact-id columns", () => {
      expect(isOpaqueLegacyFactId("2Y4ope8OxA", "fact_id")).toBe(true);
      expect(isOpaqueLegacyFactId("XUSIG6vsPw", "factId")).toBe(true);
      expect(isOpaqueLegacyFactId("RYUAwpW0fA", "id")).toBe(true);
    });

    it("rejects canonical f_ (those are clickable)", () => {
      expect(isOpaqueLegacyFactId("f_mEKUPPFY", "fact_id")).toBe(false);
    });

    it("rejects 8-char lowercase hex (those are clickable)", () => {
      expect(isOpaqueLegacyFactId("e7c42d88", "fact_id")).toBe(false);
    });

    it("rejects 10-char strings missing digit/upper/lower entropy", () => {
      expect(isOpaqueLegacyFactId("Washington", "fact_id")).toBe(false); // no digit
      expect(isOpaqueLegacyFactId("abcdefghij", "fact_id")).toBe(false); // no upper, no digit
      expect(isOpaqueLegacyFactId("ABCDEFGHIJ", "fact_id")).toBe(false); // no lower, no digit
      expect(isOpaqueLegacyFactId("1234567890", "fact_id")).toBe(false); // no letters
    });

    it("rejects the correct shape in wrong columns (column gating)", () => {
      expect(isOpaqueLegacyFactId("2Y4ope8OxA", "description")).toBe(false);
      expect(isOpaqueLegacyFactId("2Y4ope8OxA", "title")).toBe(false);
    });

    it("rejects wrong length", () => {
      expect(isOpaqueLegacyFactId("2Y4ope8Ox", "fact_id")).toBe(false); // 9
      expect(isOpaqueLegacyFactId("2Y4ope8OxAB", "fact_id")).toBe(false); // 11
    });
  });

  describe("isLegacyResourceId — 16-char lowercase hex, muted render", () => {
    it("accepts in resource-id columns", () => {
      expect(isLegacyResourceId("1f21fae8ed666710", "resource_id")).toBe(true);
      expect(isLegacyResourceId("0116b24a50f52f44", "resourceId")).toBe(true);
      expect(isLegacyResourceId("1f21fae8ed666710", "stable_id")).toBe(true);
      expect(isLegacyResourceId("1f21fae8ed666710", "id")).toBe(true);
    });

    it("rejects wrong length", () => {
      expect(isLegacyResourceId("1f21fae8ed66671", "resource_id")).toBe(false); // 15
      expect(isLegacyResourceId("1f21fae8ed6667100", "resource_id")).toBe(false); // 17
    });

    it("rejects canonical sid_ (those go through isAnySid)", () => {
      expect(isLegacyResourceId("sid_1LcLlMGLbw", "resource_id")).toBe(false);
    });

    it("rejects non-hex chars", () => {
      expect(isLegacyResourceId("1F21FAE8ED666710", "resource_id")).toBe(false); // uppercase
      expect(isLegacyResourceId("1z21fae8ed666710", "resource_id")).toBe(false); // non-hex
    });

    it("rejects correct shape in wrong columns", () => {
      expect(isLegacyResourceId("1f21fae8ed666710", "fact_id")).toBe(false);
      expect(isLegacyResourceId("1f21fae8ed666710", "description")).toBe(false);
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
