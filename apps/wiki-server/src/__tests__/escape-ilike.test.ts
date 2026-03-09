import { describe, it, expect } from "vitest";
import { escapeIlike } from "../routes/utils.js";

describe("escapeIlike", () => {
  it("passes normal string through unchanged", () => {
    expect(escapeIlike("hello")).toBe("hello");
  });

  it("escapes % wildcard", () => {
    expect(escapeIlike("50%")).toBe("50\\%");
  });

  it("escapes _ wildcard", () => {
    expect(escapeIlike("a_b")).toBe("a\\_b");
  });

  it("escapes backslash", () => {
    expect(escapeIlike("a\\b")).toBe("a\\\\b");
  });

  it("escapes all three metacharacters together", () => {
    expect(escapeIlike("%_\\")).toBe("\\%\\_\\\\");
  });

  it("handles empty string", () => {
    expect(escapeIlike("")).toBe("");
  });

  it("leaves branch-like strings unchanged", () => {
    expect(escapeIlike("claude/fix-bug")).toBe("claude/fix-bug");
  });
});
