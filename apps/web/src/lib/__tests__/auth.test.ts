import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isAllowedUser, isSafeRedirect } from "../auth";

describe("auth", () => {
  describe("isAllowedUser", () => {
    beforeEach(() => {
      process.env.ADMIN_GITHUB_USERS = "alice,bob,charlie";
    });

    afterEach(() => {
      delete process.env.ADMIN_GITHUB_USERS;
    });

    it("allows a user in the allowlist", () => {
      expect(isAllowedUser("alice")).toBe(true);
      expect(isAllowedUser("bob")).toBe(true);
      expect(isAllowedUser("charlie")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isAllowedUser("Alice")).toBe(true);
      expect(isAllowedUser("BOB")).toBe(true);
    });

    it("rejects a user not in the allowlist", () => {
      expect(isAllowedUser("mallory")).toBe(false);
      expect(isAllowedUser("")).toBe(false);
    });

    it("denies all users when ADMIN_GITHUB_USERS is not set", () => {
      delete process.env.ADMIN_GITHUB_USERS;
      expect(isAllowedUser("alice")).toBe(false);
      expect(isAllowedUser("admin")).toBe(false);
    });

    it("denies all users when ADMIN_GITHUB_USERS is empty string", () => {
      process.env.ADMIN_GITHUB_USERS = "";
      expect(isAllowedUser("alice")).toBe(false);
    });

    it("handles whitespace around usernames", () => {
      process.env.ADMIN_GITHUB_USERS = " alice , bob , charlie ";
      expect(isAllowedUser("alice")).toBe(true);
      expect(isAllowedUser("bob")).toBe(true);
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
