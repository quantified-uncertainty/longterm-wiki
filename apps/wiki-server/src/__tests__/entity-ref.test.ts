import { describe, it, expect } from "vitest";
import { formatEntityRef } from "../routes/shared/entity-ref.js";

describe("formatEntityRef", () => {
  it("returns entity title when available", () => {
    const ref = formatEntityRef("sid_abc123ABCD", "anthropic", "Anthropic", null, "anthropic");
    expect(ref).toEqual({ entityId: "sid_abc123ABCD", slug: "anthropic", name: "Anthropic" });
  });

  it("falls back to displayName when no entity title", () => {
    const ref = formatEntityRef("sid_abc123ABCD", "anthropic", null, "Anthropic PBC", "anthropic");
    expect(ref.name).toBe("Anthropic PBC");
  });

  it("falls back to rawId when no title or displayName", () => {
    const ref = formatEntityRef(null, null, null, null, "anthropic");
    expect(ref.name).toBe("anthropic");
  });

  it("returns null name for sid_-prefixed rawId", () => {
    const ref = formatEntityRef(null, null, null, null, "sid_abc123ABCD");
    expect(ref.name).toBeNull();
  });

  it("allows non-sid rawId", () => {
    const ref = formatEntityRef(null, null, null, null, "openai-2024");
    expect(ref.name).toBe("openai-2024");
  });

  it("rejects sid_-prefixed displayName and falls back to rawId", () => {
    const ref = formatEntityRef(null, null, null, "sid_AbCdEfG12H", "some-org");
    expect(ref.name).toBe("some-org");
  });

  it("rejects sid_-prefixed displayName and returns null when no fallback", () => {
    const ref = formatEntityRef(null, null, null, "sid_8JZq4lrlDA", null);
    expect(ref.name).toBeNull();
  });

  it("returns all null for no inputs", () => {
    const ref = formatEntityRef(null, null, null, null, null);
    expect(ref).toEqual({ entityId: null, slug: null, name: null });
  });
});
