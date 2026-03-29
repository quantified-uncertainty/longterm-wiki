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

  it("allows bare 10-char alphanumeric strings as names (no longer treated as legacy IDs)", () => {
    // After sid_ migration, bare 10-char strings are no longer recognized as IDs
    expect(formatEntityRef(null, null, null, null, "Tw_Eo226h3").name).toBe("Tw_Eo226h3");
    expect(formatEntityRef(null, null, null, null, "V-55MuswUh").name).toBe("V-55MuswUh");
  });

  it("rejects sid_-prefixed stableId in displayName and falls back to rawId", () => {
    const ref = formatEntityRef(null, null, null, "sid_AbCdEfG12H", "some-org");
    expect(ref.name).toBe("some-org");
  });

  it("returns all null for no inputs", () => {
    const ref = formatEntityRef(null, null, null, null, null);
    expect(ref).toEqual({ entityId: null, slug: null, name: null });
  });
});
