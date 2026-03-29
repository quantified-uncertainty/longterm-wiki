import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock FactBase functions before importing the module under test
vi.mock("@/data/factbase", () => ({
  getKBEntity: vi.fn(),
  getKBEntitySlug: vi.fn(),
}));

// Mock TableBase functions
vi.mock("@/data/tablebase", () => ({
  getTypedEntityById: vi.fn(),
}));

// Mock entity-nav — getEntityHref builds directory URLs from slugs
vi.mock("@/data/entity-nav", () => ({
  getEntityHref: vi.fn(),
}));

import { resolveEntityName } from "../resolve-entity-name";
import { getKBEntity, getKBEntitySlug } from "@/data/factbase";
import { getTypedEntityById } from "@/data/tablebase";
import { getEntityHref } from "@/data/entity-nav";

const mockGetKBEntity = vi.mocked(getKBEntity);
const mockGetKBEntitySlug = vi.mocked(getKBEntitySlug);
const mockGetTypedEntityById = vi.mocked(getTypedEntityById);
const mockGetEntityHref = vi.mocked(getEntityHref);

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
    mockGetEntityHref.mockReturnValue("/people/dario-amodei");

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
    mockGetEntityHref.mockReturnValue("/organizations/anthropic");

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
    mockGetEntityHref.mockReturnValue("/organizations/miri");

    const result = resolveEntityName("miri");
    expect(result).toEqual({
      name: "Machine Intelligence Research Institute",
      href: "/organizations/miri",
    });
  });

  it("returns 'Unknown' for unknown stableId (uppercase, 10 chars)", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue(undefined);

    const result = resolveEntityName("3KjUCZCV8w");
    expect(result).toEqual({ name: "Unknown", href: null });
  });

  it("does NOT treat 10-char lowercase slug as stableId (no uppercase)", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue(undefined);

    const result = resolveEntityName("bioweapons");
    expect(result).toEqual({ name: "Bioweapons", href: null });
  });

  it("does NOT treat 'conjecture' as stableId (lowercase only)", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue(undefined);

    const result = resolveEntityName("conjecture");
    expect(result).toEqual({ name: "Conjecture", href: null });
  });

  it("strips 'new:' prefix and returns the name", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue(undefined);

    const result = resolveEntityName("new:Charlotte Stix");
    expect(result).toEqual({ name: "Charlotte Stix", href: null });
  });

  it("humanizes slug-format IDs", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue(undefined);

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
    mockGetEntityHref.mockReturnValue("/people/some-entity");

    const result = resolveEntityName("some-entity", "Override Name");
    expect(result.name).toBe("Override Name");
    // Still gets href from FactBase via getEntityHref
    expect(result.href).toBe("/people/some-entity");
  });

  it("handles entity with empty name in FactBase", () => {
    mockGetKBEntity.mockReturnValue({
      id: "empty-name",
      name: "",
      type: "organization",
    } as ReturnType<typeof getKBEntity>);
    mockGetKBEntitySlug.mockReturnValue("empty-name");
    mockGetTypedEntityById.mockReturnValue(undefined);

    // Empty name in FactBase falls through to slug humanization
    const result = resolveEntityName("empty-name");
    expect(result.name).toBe("Empty Name");
  });

  it("uses getEntityHref for all entity types with slugs (including non-directory types)", () => {
    mockGetKBEntity.mockReturnValue({
      id: "some-concept",
      name: "Some Concept",
      type: "concept",
    } as ReturnType<typeof getKBEntity>);
    mockGetKBEntitySlug.mockReturnValue("some-concept");
    mockGetEntityHref.mockReturnValue("/wiki/E42");

    const result = resolveEntityName("some-concept");
    expect(result).toEqual({
      name: "Some Concept",
      href: "/wiki/E42",
    });
    expect(mockGetEntityHref).toHaveBeenCalledWith("some-concept");
  });

  it("trims whitespace from displayName", () => {
    const result = resolveEntityName(null, "  ");
    // Empty after trim -> falls through
    expect(result).toEqual({ name: "Unknown", href: null });
  });

  it("returns 'Unknown' for pure numeric IDs (not valid slugs)", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue(undefined);

    expect(resolveEntityName("335")).toEqual({ name: "Unknown", href: null });
    expect(resolveEntityName("1234")).toEqual({ name: "Unknown", href: null });
    expect(resolveEntityName("0")).toEqual({ name: "Unknown", href: null });
  });

  it("resolves entity via TableBase when FactBase lookup fails", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue({
      id: "some-org",
      stableId: "Abc1234567",
      title: "Some Organization",
      entityType: "organization",
      aliases: [],
      tags: [],
      clusters: [],
      relatedEntries: [],
      sources: [],
      customFields: [],
      relatedTopics: [],
    });
    mockGetEntityHref.mockReturnValue("/organizations/some-org");

    const result = resolveEntityName("some-org");
    expect(result).toEqual({
      name: "Some Organization",
      href: "/organizations/some-org",
    });
  });

  it("resolves person entity via TableBase when FactBase lookup fails", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue({
      id: "tom-brown",
      stableId: "xY12345678",
      title: "Tom Brown",
      entityType: "person",
      aliases: [],
      tags: [],
      clusters: [],
      relatedEntries: [],
      sources: [],
      customFields: [],
      relatedTopics: [],
    });
    mockGetEntityHref.mockReturnValue("/people/tom-brown");

    const result = resolveEntityName("tom-brown");
    expect(result).toEqual({
      name: "Tom Brown",
      href: "/people/tom-brown",
    });
  });

  it("falls through to slug humanization when both FactBase and TableBase fail", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue(undefined);

    const result = resolveEntityName("jane-doe");
    expect(result).toEqual({ name: "Jane Doe", href: null });
  });

  it("rejects slug-format displayName and resolves via TableBase instead", () => {
    // When the API returns a raw slug like "tom-brown" as displayName,
    // resolveEntityName should NOT use it as-is. It should fall through
    // to the proper resolution pipeline.
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue({
      id: "tom-brown",
      stableId: "4CY8YJCrM7",
      title: "Tom Brown",
      entityType: "person",
      aliases: [],
      tags: [],
      clusters: [],
      relatedEntries: [],
      sources: [],
      customFields: [],
      relatedTopics: [],
    });
    mockGetEntityHref.mockReturnValue("/people/tom-brown");

    const result = resolveEntityName("tom-brown", "tom-brown");
    expect(result.name).toBe("Tom Brown");
    expect(result.href).toBe("/people/tom-brown");
  });

  it("rejects slug-format displayName and falls through to humanization", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue(undefined);

    // When slug displayName can't be resolved, it should be humanized
    const result = resolveEntityName("employee-equity-pool", "employee-equity-pool");
    expect(result.name).toBe("Employee Equity Pool");
  });

  it("returns 'Unknown' for contaminated stableIds", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue(undefined);

    expect(resolveEntityName("D-BpcrbThn")).toEqual({ name: "Unknown", href: null });
    expect(resolveEntityName("Tw_Eo226h3")).toEqual({ name: "Unknown", href: null });
    expect(resolveEntityName("V-55MuswUh")).toEqual({ name: "Unknown", href: null });
  });

  it("rejects contaminated stableId displayNames", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue(undefined);

    const result = resolveEntityName("some-id", "D-BpcrbThn");
    // Falls through to resolve "some-id" via FactBase/TableBase/humanization
    expect(result.name).not.toBe("D-BpcrbThn");
  });

  it("accepts legitimate displayName with spaces (not a slug)", () => {
    const result = resolveEntityName("some-id", "Google");
    expect(result.name).toBe("Google");
  });

  it("accepts single-word displayName that doesn't match entityId", () => {
    // "google" has no hyphens so it's not treated as a slug,
    // and doesn't match the entityId so it's used directly.
    const result = resolveEntityName("some-id", "google");
    expect(result.name).toBe("google");
  });

  it("rejects displayName that exactly matches entityId (echoed slug)", () => {
    // When the API just echoes the raw slug back as displayName,
    // we should resolve via the full pipeline instead.
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue({
      id: "google",
      stableId: "cMNszJMTPX",
      title: "Google / Alphabet",
      entityType: "organization",
      aliases: [],
      tags: [],
      clusters: [],
      relatedEntries: [],
      sources: [],
      customFields: [],
      relatedTopics: [],
    });
    mockGetEntityHref.mockReturnValue("/organizations/google");

    const result = resolveEntityName("google", "google");
    expect(result.name).toBe("Google / Alphabet");
    expect(result.href).toBe("/organizations/google");
  });

  it("falls through to humanization when echoed slug has no entity", () => {
    mockGetKBEntity.mockReturnValue(undefined);
    mockGetTypedEntityById.mockReturnValue(undefined);

    // "amazon" as both entityId and displayName, no entity found
    const result = resolveEntityName("amazon", "amazon");
    expect(result.name).toBe("Amazon"); // humanized via titleCase
  });
});
