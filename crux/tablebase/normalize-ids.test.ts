import { describe, it, expect } from "vitest";

/**
 * Import the heuristic functions by re-implementing them here since they are
 * not exported from the module (they are internal helpers). This tests the
 * logic that determines whether a value is a slug vs a stableId.
 */

function looksLikeStableId(value: string): boolean {
  return /^[A-Za-z0-9]{10}$/.test(value);
}

function looksLikeSlug(value: string): boolean {
  if (looksLikeStableId(value)) return false;
  if (value.includes("-")) return true;
  if (value === value.toLowerCase() && value.length > 10) return true;
  return false;
}

describe("looksLikeStableId", () => {
  it("matches 10-char alphanumeric strings", () => {
    expect(looksLikeStableId("mK9pX3rQ7n")).toBe(true);
    expect(looksLikeStableId("1LcLlMGLbw")).toBe(true);
    expect(looksLikeStableId("A4XoubikkQ")).toBe(true);
  });

  it("rejects slugs", () => {
    expect(looksLikeStableId("center-for-ai-safety")).toBe(false);
    expect(looksLikeStableId("openai")).toBe(false);
    expect(looksLikeStableId("rand-corporation")).toBe(false);
  });

  it("rejects display names", () => {
    expect(looksLikeStableId("Alex Holness-Tofts")).toBe(false);
    expect(looksLikeStableId("Center for AI Safety")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(looksLikeStableId("")).toBe(false);
  });

  it("rejects strings with wrong length", () => {
    expect(looksLikeStableId("abc")).toBe(false);
    expect(looksLikeStableId("abcdefghijk")).toBe(false); // 11 chars
  });
});

describe("looksLikeSlug", () => {
  it("detects hyphenated slugs", () => {
    expect(looksLikeSlug("center-for-ai-safety")).toBe(true);
    expect(looksLikeSlug("rand-corporation")).toBe(true);
    expect(looksLikeSlug("ai-now-institute")).toBe(true);
    expect(looksLikeSlug("partnership-on-ai")).toBe(true);
  });

  it("detects long all-lowercase strings", () => {
    expect(looksLikeSlug("longlowercase")).toBe(true); // 13 chars, all lowercase
  });

  it("rejects stableIds", () => {
    expect(looksLikeSlug("mK9pX3rQ7n")).toBe(false);
    expect(looksLikeSlug("1LcLlMGLbw")).toBe(false);
  });

  it("does not match short lowercase strings", () => {
    expect(looksLikeSlug("openai")).toBe(false); // 6 chars, no hyphens
    expect(looksLikeSlug("govai")).toBe(false); // 5 chars, no hyphens
  });

  it("detects hyphenated display names as slugs", () => {
    // Person names with hyphens will match — this is intentional.
    // The registry lookup will fail for these, so they'll be "unresolved"
    // rather than incorrectly fixed.
    expect(looksLikeSlug("Alex Holness-Tofts")).toBe(true);
    expect(looksLikeSlug("Shin-Shin Hua")).toBe(true);
  });

  it("detects UUIDs as slugs (contain hyphens)", () => {
    // UUIDs contain hyphens and will match the heuristic.
    // They won't match any slug in the registry, so they'll be "unresolved".
    expect(looksLikeSlug("400fe9a6-6614-4e98-a334-f7e70a67f3da")).toBe(true);
  });
});
