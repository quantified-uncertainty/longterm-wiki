import { describe, it, expect } from "vitest";
import {
  isFactId,
  isLegacyFactId,
  isLegacyResourceId,
  stripFactIdPrefix,
} from "../id-masking";

/**
 * Unit tests for the cell-value ID masking helpers used by
 * entity-profile-viewer. See QUA-397 for context — this is the third fix
 * iteration, and the tests codify the exact edge cases we kept re-discovering.
 */

describe("isFactId", () => {
  it("matches canonical f_ prefix with 10 alphanumeric chars", () => {
    expect(isFactId("f_qR5tY9wE1a")).toBe(true);
    expect(isFactId("f_dW5cR9mJ8q")).toBe(true);
  });

  it("matches arbitrary longer suffixes", () => {
    expect(isFactId("f_ABCDEFGH")).toBe(true);
    expect(isFactId("f_ABCDEFGHIJKLMNOP")).toBe(true);
  });

  it("rejects values under 8 chars of suffix", () => {
    expect(isFactId("f_short")).toBe(false);
    expect(isFactId("f_ABCDEFG")).toBe(false); // only 7 alphanumeric
  });

  it("rejects non-f_ prefixes", () => {
    expect(isFactId("sid_qR5tY9wE1a")).toBe(false);
    expect(isFactId("qR5tY9wE1a")).toBe(false);
    expect(isFactId("fact_id_123")).toBe(false);
  });

  it("rejects legacy 8-char bare hex fact IDs (those need column gating)", () => {
    expect(isFactId("e7c42d88")).toBe(false);
    expect(isFactId("f2a06bd3")).toBe(false);
  });
});

describe("isLegacyFactId", () => {
  it("matches 8-12 char lowercase hex in fact_id column", () => {
    expect(isLegacyFactId("e7c42d88", "fact_id")).toBe(true);
    expect(isLegacyFactId("a8c71e05", "fact_id")).toBe(true);
    expect(isLegacyFactId("a8c71e05abcd", "fact_id")).toBe(true); // 12 chars
  });

  it("matches in camelCase factId column too", () => {
    expect(isLegacyFactId("e7c42d88", "factId")).toBe(true);
  });

  it("rejects hex-shaped values in unrelated columns (column gating)", () => {
    expect(isLegacyFactId("e7c42d88", "resource_id")).toBe(false);
    expect(isLegacyFactId("e7c42d88", "git_sha")).toBe(false);
    expect(isLegacyFactId("e7c42d88", "hash")).toBe(false);
    expect(isLegacyFactId("e7c42d88", "id")).toBe(false);
  });

  it("rejects non-hex chars even in fact_id column", () => {
    expect(isLegacyFactId("zzzzzzzz", "fact_id")).toBe(false);
    expect(isLegacyFactId("E7C42D88", "fact_id")).toBe(false); // uppercase
  });

  it("rejects strings under 8 or over 12 chars", () => {
    expect(isLegacyFactId("e7c42d8", "fact_id")).toBe(false); // 7 chars
    expect(isLegacyFactId("a8c71e05abcde", "fact_id")).toBe(false); // 13 chars
  });
});

describe("isLegacyResourceId", () => {
  it("matches 16-char lowercase hex in resource_id column", () => {
    expect(isLegacyResourceId("1f21fae8ed666710", "resource_id")).toBe(true);
    expect(isLegacyResourceId("0116b24a50f52f44", "resource_id")).toBe(true);
  });

  it("matches in camelCase / stable_id column variants", () => {
    expect(isLegacyResourceId("1f21fae8ed666710", "resourceId")).toBe(true);
    expect(isLegacyResourceId("1f21fae8ed666710", "stable_id")).toBe(true);
    expect(isLegacyResourceId("1f21fae8ed666710", "stableId")).toBe(true);
  });

  it("rejects hex-shaped values in unrelated columns", () => {
    expect(isLegacyResourceId("1f21fae8ed666710", "fact_id")).toBe(false);
    expect(isLegacyResourceId("1f21fae8ed666710", "git_sha")).toBe(false);
  });

  it("rejects wrong-length hex", () => {
    expect(isLegacyResourceId("1f21fae8ed66671", "resource_id")).toBe(false); // 15
    expect(isLegacyResourceId("1f21fae8ed6667100", "resource_id")).toBe(false); // 17
  });

  it("rejects canonical sid_ stableIds (those render via isAnySid path)", () => {
    expect(isLegacyResourceId("sid_1LcLlMGLbw", "stable_id")).toBe(false);
  });
});

describe("stripFactIdPrefix", () => {
  it("strips `f_... — Entity` titles", () => {
    expect(stripFactIdPrefix("f_qR5tY9wE1a — Anthropic")).toBe("Anthropic");
  });

  it("strips `f_...: value` descriptions", () => {
    expect(stripFactIdPrefix("f_qR5tY9wE1a: 100000000")).toBe("100000000");
  });

  it("strips legacy hex-prefixed titles", () => {
    expect(stripFactIdPrefix("e7c42d88: Google total invested in Anthropic")).toBe(
      "Google total invested in Anthropic"
    );
    expect(stripFactIdPrefix("e7c42d88 — Anthropic")).toBe("Anthropic");
  });

  it("returns null for already-clean values", () => {
    expect(stripFactIdPrefix("Anthropic")).toBeNull();
    expect(stripFactIdPrefix("Total funding — Anthropic")).toBeNull();
    expect(stripFactIdPrefix("f_qR5tY9wE1a")).toBeNull(); // no separator
  });

  it("returns null for values without a recognizable separator", () => {
    expect(stripFactIdPrefix("f_qR5tY9wE1aAnthropic")).toBeNull();
    expect(stripFactIdPrefix("e7c42d88Anthropic")).toBeNull();
  });

  it("does not match random 8-char values at the start of a title", () => {
    // Real-world unrelated strings should pass through unchanged
    expect(stripFactIdPrefix("Abcdefgh - some title")).toBeNull(); // uppercase
    expect(stripFactIdPrefix("zzzzzzzz: value")).toBeNull(); // non-hex chars
  });

  it("handles multi-line and long-suffix values (full remainder returned)", () => {
    expect(stripFactIdPrefix("f_qR5tY9wE1a — Some very long label with spaces")).toBe(
      "Some very long label with spaces"
    );
  });
});
