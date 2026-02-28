import { describe, it, expect } from "vitest";
import {
  generateSessionToken,
  verifySessionToken,
  verifyPassword,
  isSafeRedirect,
} from "../auth";

describe("auth", () => {
  const SECRET = "test-admin-password-123";

  describe("generateSessionToken", () => {
    it("produces a token with nonce.hmac format", () => {
      const token = generateSessionToken(SECRET);
      const parts = token.split(".");
      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatch(/^[0-9a-f]{64}$/); // 32 bytes = 64 hex chars
      expect(parts[1]).toMatch(/^[0-9a-f]{64}$/); // SHA-256 HMAC = 64 hex chars
    });

    it("generates unique tokens each time", () => {
      const t1 = generateSessionToken(SECRET);
      const t2 = generateSessionToken(SECRET);
      expect(t1).not.toBe(t2);
    });
  });

  describe("verifySessionToken", () => {
    it("accepts a token generated with the same secret", () => {
      const token = generateSessionToken(SECRET);
      expect(verifySessionToken(token, SECRET)).toBe(true);
    });

    it("rejects a token generated with a different secret", () => {
      const token = generateSessionToken(SECRET);
      expect(verifySessionToken(token, "wrong-secret")).toBe(false);
    });

    it("rejects the old hardcoded 'authenticated' value", () => {
      expect(verifySessionToken("authenticated", SECRET)).toBe(false);
    });

    it("rejects empty string", () => {
      expect(verifySessionToken("", SECRET)).toBe(false);
    });

    it("rejects token with tampered nonce", () => {
      const token = generateSessionToken(SECRET);
      const [, hmac] = token.split(".");
      const tampered = "00".repeat(32) + "." + hmac;
      expect(verifySessionToken(tampered, SECRET)).toBe(false);
    });

    it("rejects token with tampered HMAC", () => {
      const token = generateSessionToken(SECRET);
      const [nonce] = token.split(".");
      const tampered = nonce + "." + "00".repeat(32);
      expect(verifySessionToken(tampered, SECRET)).toBe(false);
    });

    it("rejects token without dot separator", () => {
      expect(verifySessionToken("abcdef1234567890", SECRET)).toBe(false);
    });
  });

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

  describe("isSafeRedirect", () => {
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

    it("blocks embedded protocol indicators", () => {
      expect(isSafeRedirect("/foo://bar")).toBe(false);
    });

    it("blocks backslash variants", () => {
      expect(isSafeRedirect("/\\evil.com")).toBe(false);
      expect(isSafeRedirect("\\\\evil.com")).toBe(false);
    });
  });
});
