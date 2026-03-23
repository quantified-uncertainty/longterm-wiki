import { describe, it, expect } from "vitest";
import { formatEntityRef, STABLE_ID_PATTERN } from "../routes/shared/entity-ref.js";

describe("formatEntityRef", () => {
  it("returns entity title when available", () => {
    const ref = formatEntityRef("abc123ABCD", "anthropic", "Anthropic", null, "anthropic");
    expect(ref).toEqual({ entityId: "abc123ABCD", slug: "anthropic", name: "Anthropic" });
  });

  it("falls back to displayName when no entity title", () => {
    const ref = formatEntityRef("abc123ABCD", "anthropic", null, "Anthropic PBC", "anthropic");
    expect(ref.name).toBe("Anthropic PBC");
  });

  it("falls back to rawId when no title or displayName", () => {
    const ref = formatEntityRef(null, null, null, null, "anthropic");
    expect(ref.name).toBe("anthropic");
  });

  it("returns null name for stableId-shaped rawId", () => {
    const ref = formatEntityRef(null, null, null, null, "abc123ABCD");
    expect(ref.name).toBeNull();
  });

  it("returns null name for pure numeric rawId (legacy DB IDs)", () => {
    const ref = formatEntityRef(null, null, null, null, "175");
    expect(ref.name).toBeNull();
  });

  it("returns null name for other numeric IDs", () => {
    expect(formatEntityRef(null, null, null, null, "265").name).toBeNull();
    expect(formatEntityRef(null, null, null, null, "335").name).toBeNull();
    expect(formatEntityRef(null, null, null, null, "0").name).toBeNull();
    expect(formatEntityRef(null, null, null, null, "999999").name).toBeNull();
  });

  it("allows alphanumeric rawId that is not a stableId or numeric", () => {
    const ref = formatEntityRef(null, null, null, null, "openai-2024");
    expect(ref.name).toBe("openai-2024");
  });

  it("returns all null for no inputs", () => {
    const ref = formatEntityRef(null, null, null, null, null);
    expect(ref).toEqual({ entityId: null, slug: null, name: null });
  });
});

describe("STABLE_ID_PATTERN", () => {
  it("matches 10-char alphanumeric with uppercase", () => {
    expect(STABLE_ID_PATTERN.test("abc123ABCD")).toBe(true);
    expect(STABLE_ID_PATTERN.test("AbCdEfGhIj")).toBe(true);
  });

  it("rejects strings without uppercase", () => {
    expect(STABLE_ID_PATTERN.test("abcdefghij")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(STABLE_ID_PATTERN.test("abc123ABC")).toBe(false);
    expect(STABLE_ID_PATTERN.test("abc123ABCDE")).toBe(false);
  });

  it("rejects numeric-only strings", () => {
    expect(STABLE_ID_PATTERN.test("1234567890")).toBe(false);
  });
});
