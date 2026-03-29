import { describe, it, expect } from "vitest";
import {
  SID_PREFIX,
  isSid,
  isDisplayableName,
  generateSid,
} from "../src/index.js";

describe("isSid", () => {
  it("detects sid_-prefixed IDs", () => {
    expect(isSid("sid_1LcLlMGLbw")).toBe(true);
    expect(isSid("sid_AbCdEfG12H")).toBe(true);
    expect(isSid("sid_0000000000")).toBe(true);
  });

  it("rejects non-prefixed strings", () => {
    expect(isSid("1LcLlMGLbw")).toBe(false);
    expect(isSid("openai")).toBe(false);
    expect(isSid("John Smith")).toBe(false);
    expect(isSid("E218")).toBe(false);
    expect(isSid("f_1Y4HfGVOvA")).toBe(false);
    expect(isSid("")).toBe(false);
  });

  it("handles null and undefined safely", () => {
    expect(isSid(null)).toBe(false);
    expect(isSid(undefined)).toBe(false);
    expect(isSid("")).toBe(false);
  });

  it("rejects partial prefix matches", () => {
    expect(isSid("si_1LcLlMGLbw")).toBe(false);
    expect(isSid("sid1LcLlMGLbw")).toBe(false);
    expect(isSid("SID_1LcLlMGLbw")).toBe(false);
  });
});

describe("isDisplayableName", () => {
  it("accepts human names", () => {
    expect(isDisplayableName("John Smith")).toBe(true);
    expect(isDisplayableName("OpenAI")).toBe(true);
    expect(isDisplayableName("anthropic")).toBe(true);
    expect(isDisplayableName("Li Wei")).toBe(true);
  });

  it("accepts slugs", () => {
    expect(isDisplayableName("openai-2024")).toBe(true);
    expect(isDisplayableName("center-for-ai-safety")).toBe(true);
  });

  it("accepts wiki IDs and fact IDs (they have their own prefixes)", () => {
    expect(isDisplayableName("E218")).toBe(true);
    expect(isDisplayableName("f_1Y4HfGVOvA")).toBe(true);
  });

  it("rejects sid_-prefixed IDs", () => {
    expect(isDisplayableName("sid_1LcLlMGLbw")).toBe(false);
    expect(isDisplayableName("sid_AbCdEfG12H")).toBe(false);
  });
});

describe("generateSid", () => {
  it("produces sid_-prefixed strings", () => {
    const id = generateSid();
    expect(id.startsWith(SID_PREFIX)).toBe(true);
  });

  it("produces 14-character strings (4 prefix + 10 random)", () => {
    const id = generateSid();
    expect(id.length).toBe(14);
  });

  it("produces alphanumeric characters after prefix", () => {
    const id = generateSid();
    const suffix = id.slice(SID_PREFIX.length);
    expect(/^[A-Za-z0-9]{10}$/.test(suffix)).toBe(true);
  });

  it("produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSid()));
    expect(ids.size).toBe(100);
  });

  it("passes isSid check", () => {
    expect(isSid(generateSid())).toBe(true);
  });
});

describe("null/undefined safety", () => {
  it("isSid returns false for non-string values", () => {
    expect(isSid(undefined)).toBe(false);
    expect(isSid(null)).toBe(false);
  });

  it("isDisplayableName returns false for non-string values", () => {
    expect(isDisplayableName(undefined)).toBe(false);
    expect(isDisplayableName(null)).toBe(false);
  });
});
