import { describe, expect, it, vi, beforeEach } from "vitest";

import type { Entity } from "@longterm-wiki/kb";

// Mock the KB data layer
vi.mock("@/data/kb", () => ({
  getKBEntity: vi.fn(() => undefined),
  getKBEntities: vi.fn(() => []),
  resolveKBSlug: vi.fn(() => undefined),
  getKBSlugMap: vi.fn(() => ({})),
}));

// Mock the typed entity data layer
vi.mock("@/data", () => ({
  getTypedEntities: vi.fn(() => []),
  isOrganization: vi.fn((e: { entityType?: string }) => e.entityType === "organization"),
}));

import { resolveOrgBySlug, getOrgSlugs } from "./org-utils";
import { getKBEntity, getKBEntities, resolveKBSlug, getKBSlugMap } from "@/data/kb";
import { getTypedEntities } from "@/data";

// Typed mocks for convenience
const mockGetKBEntity = vi.mocked(getKBEntity);
const mockGetKBEntities = vi.mocked(getKBEntities);
const mockResolveKBSlug = vi.mocked(resolveKBSlug);
const mockGetKBSlugMap = vi.mocked(getKBSlugMap);
const mockGetTypedEntities = vi.mocked(getTypedEntities);

// ── Helpers ──────────────────────────────────────────────────────

function mockEntity(overrides: Partial<Entity> & { id: string; name: string }): Entity {
  return {
    type: "organization",
    stableId: overrides.id,
    ...overrides,
  } as Entity;
}

// ── Reset mocks ──────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  mockGetKBEntity.mockReturnValue(undefined);
  mockGetKBEntities.mockReturnValue([]);
  mockResolveKBSlug.mockReturnValue(undefined);
  mockGetKBSlugMap.mockReturnValue({});
  mockGetTypedEntities.mockReturnValue([]);
});

// ═══════════════════════════════════════════════════════════════════
// resolveOrgBySlug
// ═══════════════════════════════════════════════════════════════════

describe("resolveOrgBySlug", () => {
  it("returns the entity when slug resolves to an organization", () => {
    const entity = mockEntity({ id: "org1", name: "Anthropic", type: "organization" });

    mockResolveKBSlug.mockReturnValue("org1");
    mockGetKBEntity.mockReturnValue(entity);

    const result = resolveOrgBySlug("anthropic");
    expect(result).toEqual(entity);
    expect(mockResolveKBSlug).toHaveBeenCalledWith("anthropic");
    expect(mockGetKBEntity).toHaveBeenCalledWith("org1");
  });

  it("returns undefined when slug does not resolve to any entity", () => {
    mockResolveKBSlug.mockReturnValue(undefined);

    expect(resolveOrgBySlug("nonexistent")).toBeUndefined();
    expect(mockGetKBEntity).not.toHaveBeenCalled();
  });

  it("returns undefined when slug resolves to a non-organization entity", () => {
    const personEntity = mockEntity({ id: "p1", name: "Alice", type: "person" });

    mockResolveKBSlug.mockReturnValue("p1");
    mockGetKBEntity.mockReturnValue(personEntity);

    expect(resolveOrgBySlug("alice")).toBeUndefined();
  });

  it("returns undefined when entity lookup returns undefined", () => {
    mockResolveKBSlug.mockReturnValue("org1");
    mockGetKBEntity.mockReturnValue(undefined);

    expect(resolveOrgBySlug("anthropic")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// getOrgSlugs
// ═══════════════════════════════════════════════════════════════════

describe("getOrgSlugs", () => {
  it("returns slugs only for organization entities", () => {
    mockGetKBEntities.mockReturnValue([
      mockEntity({ id: "org1", name: "Anthropic", type: "organization" }),
      mockEntity({ id: "org2", name: "OpenAI", type: "organization" }),
      mockEntity({ id: "p1", name: "Alice", type: "person" }),
    ]);

    mockGetKBSlugMap.mockReturnValue({
      anthropic: "org1",
      openai: "org2",
      alice: "p1",
    });

    const slugs = getOrgSlugs();
    expect(slugs).toContain("anthropic");
    expect(slugs).toContain("openai");
    expect(slugs).not.toContain("alice");
    expect(slugs).toHaveLength(2);
  });

  it("returns empty array when no organizations exist", () => {
    mockGetKBEntities.mockReturnValue([
      mockEntity({ id: "p1", name: "Alice", type: "person" }),
    ]);

    mockGetKBSlugMap.mockReturnValue({
      alice: "p1",
    });

    expect(getOrgSlugs()).toEqual([]);
  });

  it("returns empty array when no entities exist", () => {
    mockGetKBEntities.mockReturnValue([]);
    mockGetKBSlugMap.mockReturnValue({});

    expect(getOrgSlugs()).toEqual([]);
  });

  it("handles entities without slugs in the slug map", () => {
    mockGetKBEntities.mockReturnValue([
      mockEntity({ id: "org1", name: "Anthropic", type: "organization" }),
      mockEntity({ id: "org2", name: "SecretOrg", type: "organization" }),
    ]);

    // Only org1 has a slug mapping
    mockGetKBSlugMap.mockReturnValue({
      anthropic: "org1",
    });

    const slugs = getOrgSlugs();
    expect(slugs).toEqual(["anthropic"]);
  });

  it("handles multiple slugs pointing to the same organization", () => {
    mockGetKBEntities.mockReturnValue([
      mockEntity({ id: "org1", name: "Anthropic", type: "organization" }),
    ]);

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
