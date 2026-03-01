import { describe, it, expect } from "vitest";
import { isSafeRedirect, safeRedirectOr } from "../safe-redirect";

describe("isSafeRedirect", () => {
  describe("valid paths", () => {
    it("accepts simple relative paths", () => {
      expect(isSafeRedirect("/internal")).toBe(true);
      expect(isSafeRedirect("/internal/pages")).toBe(true);
      expect(isSafeRedirect("/wiki/E42")).toBe(true);
      expect(isSafeRedirect("/login")).toBe(true);
    });

    it("accepts paths with query strings", () => {
      expect(isSafeRedirect("/internal?tab=pages")).toBe(true);
      expect(isSafeRedirect("/wiki?entity=risks")).toBe(true);
    });

    it("accepts paths with fragments", () => {
      expect(isSafeRedirect("/wiki/E42#overview")).toBe(true);
    });

    it("accepts root path", () => {
      expect(isSafeRedirect("/")).toBe(true);
    });
  });

  describe("protocol-relative URLs (//evil.com)", () => {
    it("rejects protocol-relative URLs", () => {
      expect(isSafeRedirect("//evil.com")).toBe(false);
      expect(isSafeRedirect("//evil.com/path")).toBe(false);
    });

    it("rejects URL-encoded protocol-relative URLs", () => {
      // %2F = /
      expect(isSafeRedirect("/%2Fevil.com")).toBe(false);
      expect(isSafeRedirect("/%2fevil.com")).toBe(false);
    });

    it("rejects double-encoded protocol-relative URLs", () => {
      // %252F = %2F (after first decode) = / (after second decode)
      expect(isSafeRedirect("/%252Fevil.com")).toBe(false);
      expect(isSafeRedirect("/%252fevil.com")).toBe(false);
    });
  });

  describe("backslash bypass", () => {
    it("rejects paths with backslashes", () => {
      expect(isSafeRedirect("/\\evil.com")).toBe(false);
      expect(isSafeRedirect("\\evil.com")).toBe(false);
    });

    it("rejects URL-encoded backslashes", () => {
      // %5C = backslash
      expect(isSafeRedirect("/%5Cevil.com")).toBe(false);
      expect(isSafeRedirect("/%5cevil.com")).toBe(false);
    });

    it("rejects double-encoded backslashes", () => {
      // %255C = %5C (after first decode) = \ (after second decode)
      expect(isSafeRedirect("/%255Cevil.com")).toBe(false);
      expect(isSafeRedirect("/%255cevil.com")).toBe(false);
    });
  });

  describe("absolute URLs", () => {
    it("rejects http URLs", () => {
      expect(isSafeRedirect("http://evil.com")).toBe(false);
    });

    it("rejects https URLs", () => {
      expect(isSafeRedirect("https://evil.com")).toBe(false);
    });

    it("rejects URL-encoded scheme", () => {
      // http%3A%2F%2F = http://
      expect(isSafeRedirect("http%3A%2F%2Fevil.com")).toBe(false);
    });
  });

  describe("CRLF injection", () => {
    it("rejects paths with carriage return", () => {
      expect(isSafeRedirect("/internal\r\nSet-Cookie: evil=true")).toBe(false);
    });

    it("rejects paths with newline", () => {
      expect(isSafeRedirect("/internal\nevil")).toBe(false);
    });

    it("rejects URL-encoded CRLF", () => {
      // %0D%0A = \r\n
      expect(isSafeRedirect("/internal%0D%0ASet-Cookie:%20evil=true")).toBe(
        false,
      );
    });
  });

  describe("edge cases", () => {
    it("rejects empty string", () => {
      expect(isSafeRedirect("")).toBe(false);
    });

    it("rejects null/undefined coerced to string", () => {
      // @ts-expect-error testing runtime behavior
      expect(isSafeRedirect(null)).toBe(false);
      // @ts-expect-error testing runtime behavior
      expect(isSafeRedirect(undefined)).toBe(false);
    });

    it("rejects paths not starting with /", () => {
      expect(isSafeRedirect("evil.com")).toBe(false);
      expect(isSafeRedirect("internal")).toBe(false);
    });

    it("rejects javascript: scheme", () => {
      expect(isSafeRedirect("javascript:alert(1)")).toBe(false);
    });

    it("rejects data: scheme", () => {
      expect(isSafeRedirect("data:text/html,<h1>evil</h1>")).toBe(false);
    });

    it("handles malformed percent encoding gracefully", () => {
      // %ZZ is not valid percent encoding — should be rejected safely
      expect(isSafeRedirect("/%ZZ")).toBe(false);
    });
  });
});

describe("safeRedirectOr", () => {
  it("returns the path when it's safe", () => {
    expect(safeRedirectOr("/internal", "/fallback")).toBe("/internal");
  });

  it("returns the fallback for unsafe paths", () => {
    expect(safeRedirectOr("//evil.com", "/fallback")).toBe("/fallback");
  });

  it("returns the fallback for null", () => {
    expect(safeRedirectOr(null, "/fallback")).toBe("/fallback");
  });

  it("returns the fallback for undefined", () => {
    expect(safeRedirectOr(undefined, "/fallback")).toBe("/fallback");
  });

  it("returns the fallback for empty string", () => {
    expect(safeRedirectOr("", "/fallback")).toBe("/fallback");
  });
});
