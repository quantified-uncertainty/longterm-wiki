import { describe, it, expect } from "vitest";
import {
  isSid,
  isAnySid,
  isLegacyStableId,
} from "../stable-id";

describe("isSid", () => {
  it("detects sid_-prefixed stableIds", () => {
    expect(isSid("sid_AbCdEfG12H")).toBe(true);
    expect(isSid("sid_1LcLlMGLbw")).toBe(true);
  });

  it("rejects strings without sid_ prefix", () => {
    expect(isSid("AbCdEfG12H")).toBe(false);
    expect(isSid("tom-brown")).toBe(false);
    expect(isSid("anthropic")).toBe(false);
    expect(isSid("12345")).toBe(false);
  });

  it("handles null and undefined", () => {
    expect(isSid(null)).toBe(false);
    expect(isSid(undefined)).toBe(false);
  });
});

describe("isAnySid", () => {
  it("detects sid_-prefixed stableIds", () => {
    expect(isAnySid("sid_AbCdEfG12H")).toBe(true);
  });

  it("detects legacy bare 10-char stableIds", () => {
    expect(isAnySid("AbCdEfG12H")).toBe(true);
    expect(isAnySid("3KjUCZCV8w")).toBe(true);
  });

  it("does not match slugs or names", () => {
    expect(isAnySid("tom-brown")).toBe(false);
    expect(isAnySid("anthropic")).toBe(false);
    expect(isAnySid("bioweapons")).toBe(false); // all-lowercase 10-char, no uppercase
  });
});

describe("isLegacyStableId", () => {
  it("matches old 10-char alphanumeric IDs with uppercase", () => {
    expect(isLegacyStableId("AbCdEfG12H")).toBe(true);
    expect(isLegacyStableId("3KjUCZCV8w")).toBe(true);
  });

  it("does not match all-lowercase 10-char strings", () => {
    expect(isLegacyStableId("bioweapons")).toBe(false);
    expect(isLegacyStableId("conjecture")).toBe(false);
  });

  it("does not match sid_-prefixed strings", () => {
    expect(isLegacyStableId("sid_AbCdEfG12H")).toBe(false);
  });
});
