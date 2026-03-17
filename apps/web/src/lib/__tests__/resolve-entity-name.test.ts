import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock FactBase functions before importing the module under test
vi.mock("@/data/factbase", () => ({
  getKBEntity: vi.fn(),
  getKBEntitySlug: vi.fn(),
}));

import { resolveEntityName } from "../resolve-entity-name";
import { getKBEntity, getKBEntitySlug } from "@/data/factbase";

const mockGetKBEntity = vi.mocked(getKBEntity);
const mockGetKBEntitySlug = vi.mocked(getKBEntitySlug);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("resolveEntityName", () => {
  it("returns displayName when provided, even if entityId is null", () => {
    const result = resolveEntityName(null, "Charlotte Stix");
    expect(result).toEqual({ name: "Charlotte Stix", href: null });
  });

  it("returns displayName and resolves href via FactBase when entityId matches", () => {
    mockGetKBEntity.mockReturnValue({
      id: "dario-amodei",
      name: "Dario Amodei",
      type: "person",
    } as ReturnType<typeof getKBEntity>);
    mockGetKBEntitySlug.mockReturnValue("dario-amodei");

    const result = resolveEntityName("3KjUCZCV8w", "Dario Amodei");
    expect(result).toEqual({
      name: "Dario Amodei",
      href: "/people/dario-amodei",
    });
  });

  it("resolves known FactBase entity by stableId", () => {
    mockGetKBEntity.mockReturnValue({
      id: "anthropic",
      name: "Anthropic",
      type: "organization",
    } as ReturnType<typeof getKBEntity>);
    mockGetKBEntitySlug.mockReturnValue("anthropic");

    const result = resolveEntityName("3KjUCZCV8w");
    expect(result).toEqual({
      name: "Anthropic",
      href: "/organizations/anthropic",
    });
  });

  it("resolves known FactBase entity by slug", () => {
    mockGetKBEntity.mockReturnValue({
      id: "miri",
      name: "Machine Intelligence Research Institute",
      type: "organization",
    } as ReturnType<typeof getKBEntity>);
    mockGetKBEntitySlug.mockReturnValue("miri");

    const result = resolveEntityName("miri");
    expect(result).toEqual({
      name: "Machine Intelligence Research Institute",
      href: "/organizations/miri",
    });
  });

  it("returns 'Unknown' for unknown stableId (uppercase, 10 chars)", () => {
    mockGetKBEntity.mockReturnValue(undefined);

    const result = resolveEntityName("3KjUCZCV8w");
    expect(result).toEqual({ name: "Unknown", href: null });
  });

  it("does NOT treat 10-char lowercase slug as stableId (no uppercase)", () => {
    mockGetKBEntity.mockReturnValue(undefined);

    const result = resolveEntityName("bioweapons");
    expect(result).toEqual({ name: "Bioweapons", href: null });
  });

  it("does NOT treat 'conjecture' as stableId (lowercase only)", () => {
    mockGetKBEntity.mockReturnValue(undefined);

    const result = resolveEntityName("conjecture");
    expect(result).toEqual({ name: "Conjecture", href: null });
  });

  it("strips 'new:' prefix and returns the name", () => {
    mockGetKBEntity.mockReturnValue(undefined);

    const result = resolveEntityName("new:Charlotte Stix");
    expect(result).toEqual({ name: "Charlotte Stix", href: null });
  });

  it("humanizes slug-format IDs", () => {
    mockGetKBEntity.mockReturnValue(undefined);

    const result = resolveEntityName("jan-leike");
    expect(result).toEqual({ name: "Jan Leike", href: null });
  });

  it("returns 'Unknown' for null/undefined entityId with no displayName", () => {
    expect(resolveEntityName(null)).toEqual({ name: "Unknown", href: null });
    expect(resolveEntityName(undefined)).toEqual({ name: "Unknown", href: null });
  });

  it("returns 'Unknown' for empty string entityId", () => {
    const result = resolveEntityName("");
    expect(result).toEqual({ name: "Unknown", href: null });
  });

  it("prefers displayName over FactBase lookup", () => {
    mockGetKBEntity.mockReturnValue({
      id: "some-entity",
      name: "FactBase Name",
      type: "person",
    } as ReturnType<typeof getKBEntity>);
    mockGetKBEntitySlug.mockReturnValue("some-entity");

    const result = resolveEntityName("some-entity", "Override Name");
    expect(result.name).toBe("Override Name");
    // Still gets href from FactBase
    expect(result.href).toBe("/people/some-entity");
  });

  it("handles entity with empty name in FactBase", () => {
    mockGetKBEntity.mockReturnValue({
      id: "empty-name",
      name: "",
      type: "organization",
    } as ReturnType<typeof getKBEntity>);
    mockGetKBEntitySlug.mockReturnValue("empty-name");

    // Empty name in FactBase falls through to slug humanization
    const result = resolveEntityName("empty-name");
    expect(result.name).toBe("Empty Name");
  });

  it("returns factbase entity path for non-org/person types", () => {
    mockGetKBEntity.mockReturnValue({
      id: "some-concept",
      name: "Some Concept",
      type: "concept",
    } as ReturnType<typeof getKBEntity>);
    mockGetKBEntitySlug.mockReturnValue("some-concept");

    const result = resolveEntityName("some-concept");
    expect(result).toEqual({
      name: "Some Concept",
      href: "/factbase/entity/some-concept",
    });
  });

  it("trims whitespace from displayName", () => {
    const result = resolveEntityName(null, "  ");
    // Empty after trim -> falls through
    expect(result).toEqual({ name: "Unknown", href: null });
  });
});
