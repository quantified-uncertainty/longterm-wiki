import { describe, expect, it, vi, beforeEach } from "vitest";

import type { KBRecordEntry } from "@/data/factbase";

// Mock the KB data layer
vi.mock("@/data/factbase", () => ({
  getKBRecords: vi.fn(() => []),
  getAllKBRecords: vi.fn(() => []),
  getKBEntitySlug: vi.fn(() => undefined),
  resolveKBSlug: vi.fn(() => undefined),
}));

// Mock the TableBase data layer
vi.mock("@/data/tablebase", () => ({
  getTypedEntityById: vi.fn(() => undefined),
}));

// Mock directory-utils (used by resolvePersonBySlug / getPersonSlugs)
vi.mock("@/lib/directory-utils", () => ({
  resolveEntityBySlug: vi.fn(() => undefined),
  getEntitySlugs: vi.fn(() => []),
}));

import {
  getOrgRolesForPerson,
  getBoardSeatsForPerson,
  getCareerHistory,
  getFundingConnectionsForPerson,
} from "./people-utils";

import {
  getKBRecords,
  getAllKBRecords,
  getKBEntitySlug,
  resolveKBSlug,
} from "@/data/factbase";

import { getTypedEntityById } from "@/data/tablebase";

// Typed mocks for convenience
const mockGetKBRecords = vi.mocked(getKBRecords);
const mockGetAllKBRecords = vi.mocked(getAllKBRecords);
const mockGetTypedEntityById = vi.mocked(getTypedEntityById);
const mockGetKBEntitySlug = vi.mocked(getKBEntitySlug);
const mockResolveKBSlug = vi.mocked(resolveKBSlug);

// ── Helpers ──────────────────────────────────────────────────────

function makeRecord(
  overrides: Partial<KBRecordEntry> & { key: string; ownerEntityId: string },
): KBRecordEntry {
  return {
    schema: "test-schema",
    fields: {},
    ...overrides,
  };
}

/** Make a typed entity compatible with the AnyEntity shape from TableBase. */
function makeTypedEntity(overrides: {
  id: string;
  title: string;
  entityType?: string;
  stableId?: string;
  wikiId?: string;
}) {
  return {
    id: overrides.id,
    stableId: overrides.stableId ?? overrides.id,
    title: overrides.title,
    entityType: overrides.entityType ?? "organization",
    wikiId: overrides.wikiId,
    tags: [],
    clusters: [],
    relatedEntries: [],
    sources: [],
    customFields: [],
    relatedTopics: [],
  } as unknown as ReturnType<typeof getTypedEntityById>;
}

// ── Reset mocks ──────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  // Re-establish defaults after reset
  mockGetKBRecords.mockReturnValue([]);
  mockGetAllKBRecords.mockReturnValue([]);
  mockGetTypedEntityById.mockReturnValue(undefined);
  mockGetKBEntitySlug.mockReturnValue(undefined);
  mockResolveKBSlug.mockReturnValue(undefined);
});

// ═══════════════════════════════════════════════════════════════════
// getOrgRolesForPerson
// ═══════════════════════════════════════════════════════════════════

describe("getOrgRolesForPerson", () => {
  it("returns key-person records matching the person entity ID", () => {
    const orgEntity = makeTypedEntity({ id: "org1", title: "Anthropic", entityType: "organization" });

    mockGetAllKBRecords.mockImplementation((collection: string) => {
      if (collection === "key-persons") {
        return [
          makeRecord({
            key: "kp1",
            ownerEntityId: "org1",
            fields: { person: "person1", role: "CEO" },
          }),
          makeRecord({
            key: "kp2",
            ownerEntityId: "org2",
            fields: { person: "person2", role: "CTO" },
          }),
        ];
      }
      return [];
    });

    mockGetTypedEntityById.mockImplementation((id: string) => {
      if (id === "org1") return orgEntity;
      return undefined;
    });

    const result = getOrgRolesForPerson("person1");
    expect(result).toHaveLength(1);
    expect(result[0].org).toEqual({ id: "org1", name: "Anthropic", type: "organization" });
    expect(result[0].record.key).toBe("kp1");
    expect(result[0].record.fields.role).toBe("CEO");
  });

  it("returns empty array when no key-person records match", () => {
    mockGetAllKBRecords.mockReturnValue([
      makeRecord({
        key: "kp1",
        ownerEntityId: "org1",
        fields: { person: "other-person" },
      }),
    ]);

    expect(getOrgRolesForPerson("person1")).toEqual([]);
  });

  it("resolves slug-based person field via resolveKBSlug", () => {
    const orgEntity = makeTypedEntity({ id: "org1", title: "DeepMind" });

    mockGetAllKBRecords.mockImplementation((collection: string) => {
      if (collection === "key-persons") {
        return [
          makeRecord({
            key: "kp1",
            ownerEntityId: "org1",
            fields: { person: "dario-amodei" }, // slug, not entity ID
          }),
        ];
      }
      return [];
    });

    // resolveKBSlug("dario-amodei") → "person1"
    mockResolveKBSlug.mockImplementation((slug: string) => {
      if (slug === "dario-amodei") return "person1";
      return undefined;
    });

    mockGetTypedEntityById.mockImplementation((id: string) => {
      if (id === "org1") return orgEntity;
      return undefined;
    });

    const result = getOrgRolesForPerson("person1");
    expect(result).toHaveLength(1);
    expect(result[0].org.name).toBe("DeepMind");
  });

  it("defaults org type to 'organization' when entity has default type", () => {
    const orgEntity = makeTypedEntity({ id: "org1", title: "SomeOrg" });

    mockGetAllKBRecords.mockImplementation((collection: string) => {
      if (collection === "key-persons") {
        return [
          makeRecord({
            key: "kp1",
            ownerEntityId: "org1",
            fields: { person: "person1" },
          }),
        ];
      }
      return [];
    });

    mockGetTypedEntityById.mockImplementation((id: string) => {
      if (id === "org1") return orgEntity;
      return undefined;
    });

    const result = getOrgRolesForPerson("person1");
    expect(result[0].org.type).toBe("organization");
  });

  it("skips records when org entity cannot be resolved", () => {
    mockGetAllKBRecords.mockImplementation((collection: string) => {
      if (collection === "key-persons") {
        return [
          makeRecord({
            key: "kp1",
            ownerEntityId: "unknown-org",
            fields: { person: "person1" },
          }),
        ];
      }
      return [];
    });

    // getTypedEntityById returns undefined for unknown-org
    const result = getOrgRolesForPerson("person1");
    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// getBoardSeatsForPerson
// ═══════════════════════════════════════════════════════════════════

describe("getBoardSeatsForPerson", () => {
  it("returns board-seat records matching the person entity ID", () => {
    const orgEntity = makeTypedEntity({ id: "org1", title: "OpenAI", entityType: "organization" });

    mockGetAllKBRecords.mockImplementation((collection: string) => {
      if (collection === "board-seats") {
        return [
          makeRecord({
            key: "bs1",
            ownerEntityId: "org1",
            fields: { member: "person1", role: "Board Member" },
          }),
          makeRecord({
            key: "bs2",
            ownerEntityId: "org2",
            fields: { member: "person2" },
          }),
        ];
      }
      return [];
    });

    mockGetTypedEntityById.mockImplementation((id: string) => {
      if (id === "org1") return orgEntity;
      return undefined;
    });

    const result = getBoardSeatsForPerson("person1");
    expect(result).toHaveLength(1);
    expect(result[0].org).toEqual({ id: "org1", name: "OpenAI", type: "organization" });
    expect(result[0].record.key).toBe("bs1");
    expect(result[0].record.fields.member).toBe("person1");
  });

  it("returns empty array when no board-seat records match", () => {
    mockGetAllKBRecords.mockReturnValue([]);
    expect(getBoardSeatsForPerson("person1")).toEqual([]);
  });

  it("resolves slug-based member field via resolveKBSlug", () => {
    const orgEntity = makeTypedEntity({ id: "org1", title: "Meta" });

    mockGetAllKBRecords.mockImplementation((collection: string) => {
      if (collection === "board-seats") {
        return [
          makeRecord({
            key: "bs1",
            ownerEntityId: "org1",
            fields: { member: "yann-lecun" },
          }),
        ];
      }
      return [];
    });

    mockResolveKBSlug.mockImplementation((slug: string) => {
      if (slug === "yann-lecun") return "person1";
      return undefined;
    });

    mockGetTypedEntityById.mockImplementation((id: string) => {
      if (id === "org1") return orgEntity;
      return undefined;
    });

    const result = getBoardSeatsForPerson("person1");
    expect(result).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// getCareerHistory
// ═══════════════════════════════════════════════════════════════════

describe("getCareerHistory", () => {
  it("returns career history entries from KB records", () => {
    mockGetKBRecords.mockImplementation((entityId: string, collection: string) => {
      if (entityId === "person1" && collection === "career-history") {
        return [
          makeRecord({
            key: "ch1",
            ownerEntityId: "person1",
            fields: {
              organization: "org1",
              title: "Engineer",
              start: "2020-01",
              end: "2022-06",
              source: "https://example.com",
              notes: "First role",
            },
          }),
        ];
      }
      return [];
    });

    const result = getCareerHistory("person1");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      key: "ch1",
      organization: "org1",
      title: "Engineer",
      startDate: "2020-01",
      endDate: "2022-06",
      source: "https://example.com",
      notes: "First role",
    });
  });

  it("sorts current roles (no endDate) before past roles", () => {
    mockGetKBRecords.mockReturnValue([
      makeRecord({
        key: "ch1",
        ownerEntityId: "person1",
        fields: { organization: "org1", title: "Past Role", start: "2022-01", end: "2023-01" },
      }),
      makeRecord({
        key: "ch2",
        ownerEntityId: "person1",
        fields: { organization: "org2", title: "Current Role", start: "2023-06" },
      }),
    ]);

    const result = getCareerHistory("person1");
    expect(result[0].title).toBe("Current Role");
    expect(result[1].title).toBe("Past Role");
  });

  it("handles missing fields gracefully", () => {
    mockGetKBRecords.mockReturnValue([
      makeRecord({
        key: "ch1",
        ownerEntityId: "person1",
        fields: {},
      }),
    ]);

    const result = getCareerHistory("person1");
    expect(result[0]).toEqual({
      key: "ch1",
      organization: "",
      title: "",
      startDate: null,
      endDate: null,
      source: null,
      notes: null,
    });
  });

  it("returns empty array for person with no career history", () => {
    mockGetKBRecords.mockReturnValue([]);
    expect(getCareerHistory("person1")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// getFundingConnectionsForPerson
// ═══════════════════════════════════════════════════════════════════

describe("getFundingConnectionsForPerson", () => {
  // Common setup for most tests:
  // person1 = "Alice Smith" at org "org1" ("Anthropic")
  function setupPerson(opts?: {
    careerRecords?: KBRecordEntry[];
    keyPersonRecords?: KBRecordEntry[];
    boardSeatRecords?: KBRecordEntry[];
    grantRecords?: KBRecordEntry[];
  }) {
    const personEntity = makeTypedEntity({
      id: "person1",
      title: "Alice Smith",
      entityType: "person",
    });
    const orgEntity = makeTypedEntity({ id: "org1", title: "Anthropic", entityType: "organization" });

    mockGetTypedEntityById.mockImplementation((id: string) => {
      if (id === "person1") return personEntity;
      if (id === "org1") return orgEntity;
      return undefined;
    });

    mockGetKBEntitySlug.mockImplementation((id: string) => {
      if (id === "person1") return "alice-smith";
      if (id === "org1") return "anthropic";
      return undefined;
    });

    // Career history records (for affiliated orgs)
    mockGetKBRecords.mockImplementation((entityId: string, collection: string) => {
      if (entityId === "person1" && collection === "career-history") {
        return opts?.careerRecords ?? [
          makeRecord({
            key: "ch1",
            ownerEntityId: "person1",
            fields: { organization: "org1", title: "CEO", start: "2020-01" },
          }),
        ];
      }
      return [];
    });

    // Key-persons, board-seats, and grants
    mockGetAllKBRecords.mockImplementation((collection: string) => {
      if (collection === "key-persons") return opts?.keyPersonRecords ?? [];
      if (collection === "board-seats") return opts?.boardSeatRecords ?? [];
      if (collection === "grants") return opts?.grantRecords ?? [];
      return [];
    });
  }

  it("returns empty array when person entity does not exist", () => {
    mockGetTypedEntityById.mockReturnValue(undefined);
    expect(getFundingConnectionsForPerson("nonexistent")).toEqual([]);
  });

  it("returns empty array when person has no affiliations and no personal grants", () => {
    setupPerson({ careerRecords: [] });
    expect(getFundingConnectionsForPerson("person1")).toEqual([]);
  });

  // ── "gave" direction ──────────────────────────────────────────

  describe("gave direction", () => {
    it("identifies grants where person's affiliated org is the funder", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1", // org1 = person's employer = funder
            fields: { name: "AI Safety Grant", amount: 1000000, recipient: "recipient-org" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
      expect(result[0].direction).toBe("gave");
      expect(result[0].name).toBe("AI Safety Grant");
      expect(result[0].amount).toBe(1000000);
      expect(result[0].viaOrg).toEqual({ id: "org1", name: "Anthropic", slug: "org1" });
    });

    it("resolves counterparty for gave grants", () => {
      const recipientEntity = makeTypedEntity({ id: "rec1", title: "MIRI", entityType: "organization" });

      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Grant A", amount: 500000, recipient: "rec1" },
          }),
        ],
      });

      // Override getTypedEntityById to also resolve the recipient
      const personEntity = makeTypedEntity({ id: "person1", title: "Alice Smith", entityType: "person" });
      const orgEntity = makeTypedEntity({ id: "org1", title: "Anthropic", entityType: "organization" });
      mockGetTypedEntityById.mockImplementation((id: string) => {
        if (id === "person1") return personEntity;
        if (id === "org1") return orgEntity;
        if (id === "rec1") return recipientEntity;
        return undefined;
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].counterparty).toEqual({
        name: "MIRI",
        href: "/organizations/rec1",
      });
    });
  });

  // ── "received" direction ───────────────────────────────────────

  describe("received direction", () => {
    it("identifies grants where person's affiliated org is the recipient", () => {
      const funderEntity = makeTypedEntity({ id: "funder1", title: "Open Philanthropy", entityType: "organization" });

      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "funder1", // funder1 = grant owner (funder)
            fields: { name: "Research Grant", amount: 2000000, recipient: "org1" },
          }),
        ],
      });

      // Override to also resolve the funder
      const personEntity = makeTypedEntity({ id: "person1", title: "Alice Smith", entityType: "person" });
      const orgEntity = makeTypedEntity({ id: "org1", title: "Anthropic", entityType: "organization" });
      mockGetTypedEntityById.mockImplementation((id: string) => {
        if (id === "person1") return personEntity;
        if (id === "org1") return orgEntity;
        if (id === "funder1") return funderEntity;
        return undefined;
      });

      mockGetKBEntitySlug.mockImplementation((id: string) => {
        if (id === "person1") return "alice-smith";
        if (id === "org1") return "anthropic";
        if (id === "funder1") return "open-philanthropy";
        return undefined;
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
      expect(result[0].direction).toBe("received");
      expect(result[0].viaOrg).toEqual({ id: "org1", name: "Anthropic", slug: "org1" });
      expect(result[0].counterparty).toEqual({
        name: "Open Philanthropy",
        href: "/organizations/funder1",
      });
    });

    it("resolves received grants by slug matching when entity lookup matches by title", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "funder1",
            fields: { name: "Grant B", amount: 100000, recipient: "anthropic" }, // slug
          }),
        ],
      });

      const personEntity = makeTypedEntity({ id: "person1", title: "Alice Smith", entityType: "person" });
      const orgEntity = makeTypedEntity({ id: "org1", title: "Anthropic", entityType: "organization" });
      mockGetTypedEntityById.mockImplementation((id: string) => {
        if (id === "person1") return personEntity;
        if (id === "org1") return orgEntity;
        if (id === "funder1") return undefined;
        return undefined;
      });

      mockGetKBEntitySlug.mockImplementation((id: string) => {
        if (id === "person1") return "alice-smith";
        if (id === "org1") return "anthropic";
        return undefined;
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
      expect(result[0].direction).toBe("received");
      expect(result[0].viaOrg!.id).toBe("org1");
    });

    it("resolves received grants by name matching", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "funder1",
            fields: { name: "Grant C", amount: 50000, recipient: "Anthropic" }, // name, not ID
          }),
        ],
      });

      const personEntity = makeTypedEntity({ id: "person1", title: "Alice Smith", entityType: "person" });
      const orgEntity = makeTypedEntity({ id: "org1", title: "Anthropic", entityType: "organization" });
      mockGetTypedEntityById.mockImplementation((id: string) => {
        if (id === "person1") return personEntity;
        if (id === "org1") return orgEntity;
        return undefined; // "Anthropic" as ID won't resolve
      });

      mockGetKBEntitySlug.mockImplementation((id: string) => {
        if (id === "person1") return "alice-smith";
        if (id === "org1") return "anthropic";
        return undefined;
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
      expect(result[0].direction).toBe("received");
    });
  });

  // ── "personal" direction ───────────────────────────────────────

  describe("personal direction", () => {
    it("identifies grants where person is the direct recipient by entity ID", () => {
      setupPerson({
        careerRecords: [], // no org affiliations
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "funder1",
            fields: { name: "Personal Fellowship", amount: 75000, recipient: "person1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
      expect(result[0].direction).toBe("personal");
      expect(result[0].viaOrg).toBeNull();
    });

    it("matches personal grants by person name (case-insensitive)", () => {
      setupPerson({
        careerRecords: [],
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "funder1",
            fields: { name: "Fellowship", amount: 50000, recipient: "alice smith" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
      expect(result[0].direction).toBe("personal");
    });

    it("matches personal grants by slug", () => {
      setupPerson({
        careerRecords: [],
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "funder1",
            fields: { name: "Fellowship", amount: 30000, recipient: "alice-smith" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
      expect(result[0].direction).toBe("personal");
    });
  });

  // ── Deduplication ──────────────────────────────────────────────

  describe("deduplication", () => {
    it("deduplicates grants appearing through multiple affiliations", () => {
      setupPerson({
        keyPersonRecords: [
          makeRecord({
            key: "kp1",
            ownerEntityId: "org1",
            fields: { person: "person1" },
          }),
        ],
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Grant A", amount: 500000, recipient: "rec1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
    });
  });

  // ── Sorting ────────────────────────────────────────────────────

  describe("sorting", () => {
    it("sorts results by amount descending", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Small", amount: 100000, recipient: "rec1" },
          }),
          makeRecord({
            key: "g2",
            ownerEntityId: "org1",
            fields: { name: "Large", amount: 5000000, recipient: "rec1" },
          }),
          makeRecord({
            key: "g3",
            ownerEntityId: "org1",
            fields: { name: "Medium", amount: 1000000, recipient: "rec1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result.map((r) => r.name)).toEqual(["Large", "Medium", "Small"]);
    });

    it("puts grants with null amounts last", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "No Amount", recipient: "rec1" },
          }),
          makeRecord({
            key: "g2",
            ownerEntityId: "org1",
            fields: { name: "Has Amount", amount: 50000, recipient: "rec1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].name).toBe("Has Amount");
      expect(result[1].name).toBe("No Amount");
    });
  });
});
