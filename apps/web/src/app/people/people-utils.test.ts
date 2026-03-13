import { describe, expect, it, vi, beforeEach } from "vitest";

import type { KBRecordEntry } from "@/data/kb";

// Mock the KB data layer
vi.mock("@/data/kb", () => ({
  getKBRecords: vi.fn(() => []),
  getAllKBRecords: vi.fn(() => []),
  getKBEntity: vi.fn(() => undefined),
  getKBEntitySlug: vi.fn(() => undefined),
  resolveKBSlug: vi.fn(() => undefined),
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
  getKBEntity,
  getKBEntitySlug,
  resolveKBSlug,
} from "@/data/kb";

// Typed mocks for convenience
const mockGetKBRecords = vi.mocked(getKBRecords);
const mockGetAllKBRecords = vi.mocked(getAllKBRecords);
const mockGetKBEntity = vi.mocked(getKBEntity);
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

function makeEntity(overrides: { id: string; name: string; type?: string; aliases?: string[] }) {
  return {
    id: overrides.id,
    name: overrides.name,
    type: overrides.type ?? "organization",
    aliases: overrides.aliases,
  } as ReturnType<typeof getKBEntity> & object;
}

// ── Reset mocks ──────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  // Re-establish defaults after reset
  mockGetKBRecords.mockReturnValue([]);
  mockGetAllKBRecords.mockReturnValue([]);
  mockGetKBEntity.mockReturnValue(undefined);
  mockGetKBEntitySlug.mockReturnValue(undefined);
  mockResolveKBSlug.mockReturnValue(undefined);
});

// ═══════════════════════════════════════════════════════════════════
// getOrgRolesForPerson
// ═══════════════════════════════════════════════════════════════════

describe("getOrgRolesForPerson", () => {
  it("returns key-person records matching the person entity ID", () => {
    const orgEntity = makeEntity({ id: "org1", name: "Anthropic", type: "organization" });

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

    mockGetKBEntity.mockImplementation((id: string) => {
      if (id === "org1") return orgEntity as any;
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
    const orgEntity = makeEntity({ id: "org1", name: "DeepMind" });

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

    mockGetKBEntity.mockImplementation((id: string) => {
      if (id === "org1") return orgEntity as any;
      return undefined;
    });

    const result = getOrgRolesForPerson("person1");
    expect(result).toHaveLength(1);
    expect(result[0].org.name).toBe("DeepMind");
  });

  it("defaults org type to 'organization' when entity has no type", () => {
    const orgEntity = { id: "org1", name: "SomeOrg", type: undefined } as any;

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

    mockGetKBEntity.mockImplementation((id: string) => {
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

    // getKBEntity returns undefined for unknown-org
    const result = getOrgRolesForPerson("person1");
    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// getBoardSeatsForPerson
// ═══════════════════════════════════════════════════════════════════

describe("getBoardSeatsForPerson", () => {
  it("returns board-seat records matching the person entity ID", () => {
    const orgEntity = makeEntity({ id: "org1", name: "OpenAI", type: "organization" });

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

    mockGetKBEntity.mockImplementation((id: string) => {
      if (id === "org1") return orgEntity as any;
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
    const orgEntity = makeEntity({ id: "org1", name: "Meta" });

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

    mockGetKBEntity.mockImplementation((id: string) => {
      if (id === "org1") return orgEntity as any;
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

  it("sorts by start date descending within same end-date category", () => {
    mockGetKBRecords.mockReturnValue([
      makeRecord({
        key: "ch1",
        ownerEntityId: "person1",
        fields: { organization: "org1", title: "Older", start: "2018-01", end: "2020-01" },
      }),
      makeRecord({
        key: "ch2",
        ownerEntityId: "person1",
        fields: { organization: "org2", title: "Newer", start: "2020-06", end: "2022-01" },
      }),
    ]);

    const result = getCareerHistory("person1");
    expect(result[0].title).toBe("Newer");
    expect(result[1].title).toBe("Older");
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
    aliases?: string[];
    careerRecords?: KBRecordEntry[];
    keyPersonRecords?: KBRecordEntry[];
    boardSeatRecords?: KBRecordEntry[];
    grantRecords?: KBRecordEntry[];
  }) {
    const personEntity = makeEntity({
      id: "person1",
      name: "Alice Smith",
      type: "person",
      aliases: opts?.aliases,
    });
    const orgEntity = makeEntity({ id: "org1", name: "Anthropic", type: "organization" });

    mockGetKBEntity.mockImplementation((id: string) => {
      if (id === "person1") return personEntity as any;
      if (id === "org1") return orgEntity as any;
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
    mockGetKBEntity.mockReturnValue(undefined);
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
      expect(result[0].viaOrg).toEqual({ id: "org1", name: "Anthropic", slug: "anthropic" });
    });

    it("resolves counterparty for gave grants", () => {
      const recipientEntity = makeEntity({ id: "rec1", name: "MIRI", type: "organization" });

      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Grant A", amount: 500000, recipient: "rec1" },
          }),
        ],
      });

      // Override getKBEntity to also resolve the recipient
      const personEntity = makeEntity({ id: "person1", name: "Alice Smith", type: "person" });
      const orgEntity = makeEntity({ id: "org1", name: "Anthropic", type: "organization" });
      mockGetKBEntity.mockImplementation((id: string) => {
        if (id === "person1") return personEntity as any;
        if (id === "org1") return orgEntity as any;
        if (id === "rec1") return recipientEntity as any;
        return undefined;
      });

      mockGetKBEntitySlug.mockImplementation((id: string) => {
        if (id === "person1") return "alice-smith";
        if (id === "org1") return "anthropic";
        if (id === "rec1") return "miri";
        return undefined;
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].counterparty).toEqual({
        name: "MIRI",
        href: "/organizations/miri",
      });
    });
  });

  // ── "received" direction ───────────────────────────────────────

  describe("received direction", () => {
    it("identifies grants where person's affiliated org is the recipient", () => {
      const funderEntity = makeEntity({ id: "funder1", name: "Open Philanthropy", type: "organization" });

      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "funder1", // funder1 = grant owner (funder)
            fields: { name: "Research Grant", amount: 2000000, recipient: "org1" },
          }),
        ],
      });

      // Override getKBEntity to also resolve the funder
      const personEntity = makeEntity({ id: "person1", name: "Alice Smith", type: "person" });
      const orgEntity = makeEntity({ id: "org1", name: "Anthropic", type: "organization" });
      mockGetKBEntity.mockImplementation((id: string) => {
        if (id === "person1") return personEntity as any;
        if (id === "org1") return orgEntity as any;
        if (id === "funder1") return funderEntity as any;
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
      expect(result[0].viaOrg).toEqual({ id: "org1", name: "Anthropic", slug: "anthropic" });
      expect(result[0].counterparty).toEqual({
        name: "Open Philanthropy",
        href: "/organizations/open-philanthropy",
      });
    });

    it("resolves received grants by slug matching when entity lookup fails", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "funder1",
            fields: { name: "Grant B", amount: 100000, recipient: "anthropic" }, // slug, not entity ID
          }),
        ],
      });

      // getKBEntity for "anthropic" (the slug) returns undefined — not found by direct ID
      // but getKBEntitySlug("org1") returns "anthropic" which matches
      const personEntity = makeEntity({ id: "person1", name: "Alice Smith", type: "person" });
      const orgEntity = makeEntity({ id: "org1", name: "Anthropic", type: "organization" });
      mockGetKBEntity.mockImplementation((id: string) => {
        if (id === "person1") return personEntity as any;
        if (id === "org1") return orgEntity as any;
        if (id === "funder1") return undefined; // funder not in KB
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

      const personEntity = makeEntity({ id: "person1", name: "Alice Smith", type: "person" });
      const orgEntity = makeEntity({ id: "org1", name: "Anthropic", type: "organization" });
      mockGetKBEntity.mockImplementation((id: string) => {
        if (id === "person1") return personEntity as any;
        if (id === "org1") return orgEntity as any;
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

    it("resolves received grants by alias matching", () => {
      const orgEntity = {
        id: "org1",
        name: "Anthropic",
        type: "organization",
        aliases: ["Anthropic PBC"],
      } as any;

      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "funder1",
            fields: { name: "Grant D", amount: 25000, recipient: "Anthropic PBC" },
          }),
        ],
      });

      const personEntity = makeEntity({ id: "person1", name: "Alice Smith", type: "person" });
      mockGetKBEntity.mockImplementation((id: string) => {
        if (id === "person1") return personEntity as any;
        if (id === "org1") return orgEntity;
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

    it("matches personal grants by alias", () => {
      setupPerson({
        aliases: ["A. Smith", "Alice S."],
        careerRecords: [],
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "funder1",
            fields: { name: "Fellowship", amount: 20000, recipient: "A. Smith" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
      expect(result[0].direction).toBe("personal");
    });

    it("resolves funder as counterparty for personal grants", () => {
      const funderEntity = makeEntity({ id: "funder1", name: "NSF", type: "organization" });

      setupPerson({
        careerRecords: [],
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "funder1",
            fields: { name: "NSF Fellowship", amount: 100000, recipient: "person1" },
          }),
        ],
      });

      const personEntity = makeEntity({ id: "person1", name: "Alice Smith", type: "person" });
      mockGetKBEntity.mockImplementation((id: string) => {
        if (id === "person1") return personEntity as any;
        if (id === "funder1") return funderEntity as any;
        return undefined;
      });

      mockGetKBEntitySlug.mockImplementation((id: string) => {
        if (id === "person1") return "alice-smith";
        if (id === "funder1") return "nsf";
        return undefined;
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].counterparty).toEqual({
        name: "NSF",
        href: "/organizations/nsf",
      });
    });
  });

  // ── Deduplication ──────────────────────────────────────────────

  describe("deduplication", () => {
    it("deduplicates grants appearing through multiple affiliations", () => {
      // Person has org1 through both career history AND key-persons
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

      // org1 shows up from both career-history and key-persons
      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
    });

    it("uses composite key (ownerEntityId-recordKey) for deduplication", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Grant A", amount: 100000, recipient: "rec1" },
          }),
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Grant A Duplicate", amount: 100000, recipient: "rec1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      // Both have same composite key "org1-g1", so only first appears
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Grant A");
    });
  });

  // ── Null amounts ───────────────────────────────────────────────

  describe("null amounts", () => {
    it("returns amount as null when grant has no amount", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "No Amount Grant", recipient: "rec1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].amount).toBeNull();
    });

    it("returns amount as null when amount is a string", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "String Amount", amount: "one million", recipient: "rec1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].amount).toBeNull();
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

  // ── Counterparty resolution ────────────────────────────────────

  describe("counterparty resolution", () => {
    it("resolves organization counterparty with href", () => {
      const recipientEntity = makeEntity({ id: "rec1", name: "ARC", type: "organization" });

      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Grant", amount: 100000, recipient: "rec1" },
          }),
        ],
      });

      const personEntity = makeEntity({ id: "person1", name: "Alice Smith", type: "person" });
      const orgEntity = makeEntity({ id: "org1", name: "Anthropic", type: "organization" });
      mockGetKBEntity.mockImplementation((id: string) => {
        if (id === "person1") return personEntity as any;
        if (id === "org1") return orgEntity as any;
        if (id === "rec1") return recipientEntity as any;
        return undefined;
      });

      mockGetKBEntitySlug.mockImplementation((id: string) => {
        if (id === "person1") return "alice-smith";
        if (id === "org1") return "anthropic";
        if (id === "rec1") return "arc";
        return undefined;
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].counterparty).toEqual({
        name: "ARC",
        href: "/organizations/arc",
      });
    });

    it("resolves person counterparty with /people/ href", () => {
      const recipientEntity = makeEntity({ id: "rec1", name: "Bob Jones", type: "person" });

      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Grant", amount: 100000, recipient: "rec1" },
          }),
        ],
      });

      const personEntity = makeEntity({ id: "person1", name: "Alice Smith", type: "person" });
      const orgEntity = makeEntity({ id: "org1", name: "Anthropic", type: "organization" });
      mockGetKBEntity.mockImplementation((id: string) => {
        if (id === "person1") return personEntity as any;
        if (id === "org1") return orgEntity as any;
        if (id === "rec1") return recipientEntity as any;
        return undefined;
      });

      mockGetKBEntitySlug.mockImplementation((id: string) => {
        if (id === "person1") return "alice-smith";
        if (id === "org1") return "anthropic";
        if (id === "rec1") return "bob-jones";
        return undefined;
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].counterparty).toEqual({
        name: "Bob Jones",
        href: "/people/bob-jones",
      });
    });

    it("falls back to title-cased slug for unknown counterparty", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Grant", amount: 100000, recipient: "some-unknown-org" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].counterparty).toEqual({
        name: "Some Unknown Org",
        href: null,
      });
    });

    it("returns null counterparty when grant has no recipient", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "No Recipient Grant", amount: 100000 },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].counterparty).toBeNull();
    });

    it("uses /kb/entity/ href when entity type is neither person nor organization", () => {
      const recipientEntity = makeEntity({ id: "rec1", name: "Some Risk", type: "risk" });

      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Grant", amount: 100000, recipient: "rec1" },
          }),
        ],
      });

      const personEntity = makeEntity({ id: "person1", name: "Alice Smith", type: "person" });
      const orgEntity = makeEntity({ id: "org1", name: "Anthropic", type: "organization" });
      mockGetKBEntity.mockImplementation((id: string) => {
        if (id === "person1") return personEntity as any;
        if (id === "org1") return orgEntity as any;
        if (id === "rec1") return recipientEntity as any;
        return undefined;
      });

      mockGetKBEntitySlug.mockImplementation((id: string) => {
        if (id === "person1") return "alice-smith";
        if (id === "org1") return "anthropic";
        if (id === "rec1") return "some-risk";
        return undefined;
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].counterparty).toEqual({
        name: "Some Risk",
        href: "/kb/entity/rec1",
      });
    });
  });

  // ── Affiliated orgs from multiple sources ──────────────────────

  describe("affiliated org collection", () => {
    it("collects affiliated orgs from career history", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Grant via career", amount: 100000, recipient: "rec1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
      expect(result[0].direction).toBe("gave");
    });

    it("collects affiliated orgs from key-person records", () => {
      setupPerson({
        careerRecords: [], // no career history
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
            fields: { name: "Grant via key-person", amount: 200000, recipient: "rec1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
      expect(result[0].direction).toBe("gave");
    });

    it("collects affiliated orgs from board seats", () => {
      setupPerson({
        careerRecords: [], // no career history
        boardSeatRecords: [
          makeRecord({
            key: "bs1",
            ownerEntityId: "org1",
            fields: { member: "person1" },
          }),
        ],
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Grant via board seat", amount: 300000, recipient: "rec1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
      expect(result[0].direction).toBe("gave");
    });
  });

  // ── Priority: gave > personal > received ───────────────────────

  describe("direction priority", () => {
    it("gave takes priority over personal when person's org is the funder and person is recipient", () => {
      // A grant from org1 (person's org) to person1 — the "gave" check runs first
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1", // org1 is person's affiliated org → gave check wins
            fields: { name: "Self Grant", amount: 100000, recipient: "person1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result).toHaveLength(1);
      // "gave" check fires first because affiliatedOrgIds.has(funderOrgId) is true
      expect(result[0].direction).toBe("gave");
    });
  });

  // ── Grant field parsing ────────────────────────────────────────

  describe("grant field parsing", () => {
    it("uses record key as name when name field is missing", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "grant-without-name",
            ownerEntityId: "org1",
            fields: { amount: 100000, recipient: "rec1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].name).toBe("grant-without-name");
    });

    it("parses all optional fields (date, program, status, source)", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: {
              name: "Full Grant",
              amount: 100000,
              recipient: "rec1",
              date: "2024-01",
              program: "AI Safety",
              status: "completed",
              source: "https://example.com/grant",
            },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].date).toBe("2024-01");
      expect(result[0].program).toBe("AI Safety");
      expect(result[0].status).toBe("completed");
      expect(result[0].source).toBe("https://example.com/grant");
    });

    it("uses period field when date is missing", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: {
              name: "Grant",
              amount: 100000,
              recipient: "rec1",
              period: "2023-2024",
            },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].date).toBe("2023-2024");
    });

    it("returns null for missing optional fields", () => {
      setupPerson({
        grantRecords: [
          makeRecord({
            key: "g1",
            ownerEntityId: "org1",
            fields: { name: "Minimal Grant", recipient: "rec1" },
          }),
        ],
      });

      const result = getFundingConnectionsForPerson("person1");
      expect(result[0].amount).toBeNull();
      expect(result[0].date).toBeNull();
      expect(result[0].program).toBeNull();
      expect(result[0].status).toBeNull();
      expect(result[0].source).toBeNull();
    });
  });
});
