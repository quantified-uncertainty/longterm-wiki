import { describe, it, expect } from "vitest";
import { isSid, isDisplayableName, SID_PREFIX } from "../stable-id";

describe("isSid (re-exported from id-utils)", () => {
  it("detects sid_-prefixed IDs", () => {
    expect(isSid("sid_1LcLlMGLbw")).toBe(true);
    expect(isSid("sid_AbCdEfG12H")).toBe(true);
  });

  it("rejects non-prefixed strings", () => {
    expect(isSid("1LcLlMGLbw")).toBe(false);
    expect(isSid("openai")).toBe(false);
    expect(isSid("AbCdEfG12H")).toBe(false);
  });
});

describe("isDisplayableName (re-exported from id-utils)", () => {
  it("accepts human-readable names", () => {
    expect(isDisplayableName("John Smith")).toBe(true);
    expect(isDisplayableName("anthropic")).toBe(true);
  });

  it("rejects sid_-prefixed IDs", () => {
    expect(isDisplayableName("sid_1LcLlMGLbw")).toBe(false);
  });
});

describe("SID_PREFIX", () => {
  it("is sid_", () => {
    expect(SID_PREFIX).toBe("sid_");
  });
});
