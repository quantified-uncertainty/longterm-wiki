import { describe, it, expect } from "vitest";
import { sanitizeHeaderValue, getUserAgent, USER_AGENT } from "../http-utils.ts";

describe("sanitizeHeaderValue", () => {
  it("strips CR and LF from header values", () => {
    expect(sanitizeHeaderValue("hello\r\nX-Evil: yes")).toBe("helloX-Evil: yes");
    expect(sanitizeHeaderValue("a\nb\rc")).toBe("abc");
  });
  it("trims surrounding whitespace", () => {
    expect(sanitizeHeaderValue("  ua  ")).toBe("ua");
  });
});

describe("getUserAgent", () => {
  it("returns default when no override", () => {
    expect(getUserAgent({})).toBe(USER_AGENT);
  });
  it("returns sanitized override when provided", () => {
    expect(getUserAgent({ userAgent: "test/1.0\r\nX: y" })).toBe("test/1.0X: y");
  });
});

describe("USER_AGENT", () => {
  it("uses the org bot email, not personal", () => {
    expect(USER_AGENT).toContain("bot@quantifieduncertainty.org");
    expect(USER_AGENT).not.toContain("ozzie@");
  });
});
