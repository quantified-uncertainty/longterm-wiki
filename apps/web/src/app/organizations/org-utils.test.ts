import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the KB data layer
vi.mock("@/data/factbase", () => ({
  getKBEntities: vi.fn(() => []),
  resolveKBSlug: vi.fn(() => undefined),
  getKBSlugMap: vi.fn(() => ({})),
}));

// Mock the data layer (for getTypedEntities/isOrganization/getTypedEntityById)
vi.mock("@/data", () => ({
  getTypedEntities: vi.fn(() => []),
  getTypedEntityById: vi.fn(() => undefined),
  isOrganization: vi.fn(() => false),
}));

import { resolveOrgBySlug, getOrgSlugs } from "./org-utils";
import { getKBEntities, resolveKBSlug, getKBSlugMap } from "@/data/factbase";
import { getTypedEntities, getTypedEntityById, isOrganization } from "@/data";

// Typed mocks for convenience
const mockGetKBEntities = vi.mocked(getKBEntities);
const mockResolveKBSlug = vi.mocked(resolveKBSlug);
const mockGetKBSlugMap = vi.mocked(getKBSlugMap);
const mockGetTypedEntities = vi.mocked(getTypedEntities);
const mockGetTypedEntityById = vi.mocked(getTypedEntityById);
const mockIsOrganization = vi.mocked(isOrganization);

// ── Helpers ──────────────────────────────────────────────────────

function mockOrgEntity(overrides: { id: string; title: string; entityType?: string }) {
  return {
    id: overrides.id,
    stableId: overrides.id,
    title: overrides.title,
    entityType: overrides.entityType ?? "organization",
    tags: [],
    clusters: [],
    relatedEntries: [],
    sources: [],
    customFields: [],
    relatedTopics: [],
  } as unknown as ReturnType<typeof getTypedEntityById>;
}

function mockKBEntity(overrides: { id: string; name: string; type?: string }) {
  return {
    id: overrides.id,
    stableId: overrides.id,
    name: overrides.name,
    type: overrides.type ?? "organization",
  };
}

// ── Reset mocks ──────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  mockGetTypedEntityById.mockReturnValue(undefined);
  mockGetKBEntities.mockReturnValue([]);
  mockResolveKBSlug.mockReturnValue(undefined);
  mockGetKBSlugMap.mockReturnValue({});
  mockGetTypedEntities.mockReturnValue([]);
  mockIsOrganization.mockReturnValue(false);
});

// ═══════════════════════════════════════════════════════════════════
// resolveOrgBySlug
// ═══════════════════════════════════════════════════════════════════

describe("resolveOrgBySlug", () => {
  it("returns the entity when slug directly resolves in TableBase", () => {
    const entity = mockOrgEntity({ id: "anthropic", title: "Anthropic", entityType: "organization" });

    mockGetTypedEntityById.mockImplementation((id: string) => {
      if (id === "anthropic") return entity;
      return undefined;
    });
    mockIsOrganization.mockReturnValue(true);

    const result = resolveOrgBySlug("anthropic");
    expect(result).toEqual(entity);
  });

  it("returns undefined when slug does not resolve to any entity", () => {
    mockResolveKBSlug.mockReturnValue(undefined);

    expect(resolveOrgBySlug("nonexistent")).toBeUndefined();
  });

  it("returns undefined when slug resolves to a non-organization entity", () => {
    const personEntity = mockOrgEntity({ id: "alice", title: "Alice", entityType: "person" });

    mockGetTypedEntityById.mockImplementation((id: string) => {
      if (id === "alice") return personEntity;
      return undefined;
    });
    mockIsOrganization.mockReturnValue(false);

    expect(resolveOrgBySlug("alice")).toBeUndefined();
  });

  it("falls back to FactBase slug resolution", () => {
    const entity = mockOrgEntity({ id: "anthropic", title: "Anthropic", entityType: "organization" });

    // Direct lookup fails
    mockGetTypedEntityById.mockImplementation((id: string) => {
      if (id === "anthropic") return entity;
      if (id === "some-alias") return undefined;
      return undefined;
    });
    mockResolveKBSlug.mockImplementation((slug: string) => {
      if (slug === "some-alias") return "anthropic";
      return undefined;
    });
    mockIsOrganization.mockReturnValue(true);

    // "some-alias" doesn't match directly, but resolveKBSlug maps it to "anthropic"
    expect(resolveOrgBySlug("some-alias")?.title).toBe("Anthropic");
  });
});

// ═══════════════════════════════════════════════════════════════════
// getOrgSlugs
// ═══════════════════════════════════════════════════════════════════

describe("getOrgSlugs", () => {
  it("returns slugs from both KB and typed entities", () => {
    // KB has org1 with slug "anthropic"
    mockGetKBEntities.mockReturnValue([
      mockKBEntity({ id: "org1", name: "Anthropic", type: "organization" }),
    ] as any);
    mockGetKBSlugMap.mockReturnValue({ anthropic: "org1" });

    // Typed entities have an additional org not in KB
    mockGetTypedEntities.mockReturnValue([
      { id: "small-org", entityType: "organization", title: "Small Org" },
    ] as any);
    mockIsOrganization.mockImplementation(
      (e: any) => e.entityType === "organization",
    );

    const slugs = getOrgSlugs();
    expect(slugs).toContain("anthropic");
    expect(slugs).toContain("small-org");
    expect(slugs).toHaveLength(2);
  });

  it("deduplicates slugs present in both KB and typed entities", () => {
    mockGetKBEntities.mockReturnValue([
      mockKBEntity({ id: "org1", name: "Anthropic", type: "organization" }),
    ] as any);
    mockGetKBSlugMap.mockReturnValue({ anthropic: "org1" });

    // Same org also exists in typed entities with the slug as id
    mockGetTypedEntities.mockReturnValue([
      { id: "anthropic", entityType: "organization", title: "Anthropic" },
    ] as any);
    mockIsOrganization.mockReturnValue(true);

    const slugs = getOrgSlugs();
    expect(slugs).toContain("anthropic");
    // "anthropic" appears from both KB slug map and typed entities, but should be deduped
    expect(slugs).toHaveLength(1);
  });

  it("returns KB slugs only for organization entities", () => {
    mockGetKBEntities.mockReturnValue([
      mockKBEntity({ id: "org1", name: "Anthropic", type: "organization" }),
      mockKBEntity({ id: "p1", name: "Alice", type: "person" }),
    ] as any);
    mockGetKBSlugMap.mockReturnValue({
      anthropic: "org1",
      alice: "p1",
    });

    const slugs = getOrgSlugs();
    expect(slugs).toContain("anthropic");
    expect(slugs).not.toContain("alice");
  });

  it("returns empty array when no organizations exist", () => {
    mockGetKBEntities.mockReturnValue([
      mockKBEntity({ id: "p1", name: "Alice", type: "person" }),
    ] as any);
    mockGetKBSlugMap.mockReturnValue({ alice: "p1" });

    expect(getOrgSlugs()).toEqual([]);
  });

  it("returns empty array when no entities exist", () => {
    expect(getOrgSlugs()).toEqual([]);
  });

  it("handles multiple slugs pointing to the same organization", () => {
    mockGetKBEntities.mockReturnValue([
      mockKBEntity({ id: "org1", name: "Anthropic", type: "organization" }),
    ] as any);
    mockGetKBSlugMap.mockReturnValue({
      anthropic: "org1",
      "anthropic-pbc": "org1",
    });

    const slugs = getOrgSlugs();
    expect(slugs).toContain("anthropic");
    expect(slugs).toContain("anthropic-pbc");
    expect(slugs).toHaveLength(2);
  });
});
