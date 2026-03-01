import { describe, it, expect } from "vitest";
import { verifyPassword, isSafeRedirect } from "../auth";

describe("auth", () => {
  describe("verifyPassword", () => {
    it("accepts matching passwords", () => {
      expect(verifyPassword("correct-password", "correct-password")).toBe(true);
    });

    it("rejects non-matching passwords of same length", () => {
      expect(verifyPassword("password-aaa", "password-bbb")).toBe(false);
    });

    it("rejects non-matching passwords of different length", () => {
      expect(verifyPassword("short", "a-much-longer-password")).toBe(false);
    });

    it("rejects empty password against non-empty", () => {
      expect(verifyPassword("", "secret")).toBe(false);
    });
  });

  describe("isSafeRedirect (re-exported from safe-redirect)", () => {
    it("allows simple relative paths", () => {
      expect(isSafeRedirect("/internal")).toBe(true);
      expect(isSafeRedirect("/internal/dashboard")).toBe(true);
      expect(isSafeRedirect("/")).toBe(true);
    });

    it("blocks protocol-relative URLs", () => {
      expect(isSafeRedirect("//evil.com")).toBe(false);
      expect(isSafeRedirect("//evil.com/steal")).toBe(false);
    });

    it("blocks absolute URLs with protocol", () => {
      expect(isSafeRedirect("https://evil.com")).toBe(false);
      expect(isSafeRedirect("http://evil.com")).toBe(false);
    });

    it("blocks non-path strings", () => {
      expect(isSafeRedirect("evil.com")).toBe(false);
      expect(isSafeRedirect("javascript:alert(1)")).toBe(false);
    });

    it("blocks backslash variants", () => {
      expect(isSafeRedirect("/\\evil.com")).toBe(false);
      expect(isSafeRedirect("\\\\evil.com")).toBe(false);
    });
  });
});
