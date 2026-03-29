import { describe, it, expect } from "vitest";
import {
  pgPersonnelToEntries,
  mergePgPersonnel,
  type PersonEntry,
} from "./people-section";
import type { RpcPersonnelRow } from "@/lib/wiki-server";

// ── Test helpers ──────────────────────────────────────────────────────

/** Build a minimal RpcPersonnelRow for testing. */
function makeRow(overrides: Partial<RpcPersonnelRow> = {}): RpcPersonnelRow {
  return {
    id: "row-1",
    personId: "person-1",
    organizationId: "org-1",
    role: "Engineer",
    roleType: "key-person",
    startDate: "2020-01-01",
    endDate: null,
    isFounder: false,
    appointedBy: null,
    background: null,
    source: null,
    notes: null,
    person: { entityId: null, slug: null, name: null },
    organization: { entityId: null, slug: null, name: null },
    personEntityId: null,
    personDisplayName: null,
    personResolvedName: null,
    orgEntityId: null,
    orgDisplayName: null,
    orgResolvedName: null,
    syncedAt: "2024-01-01T00:00:00Z",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  } as RpcPersonnelRow;
}

function makeEntry(overrides: Partial<PersonEntry> = {}): PersonEntry {
  return {
    name: "Test Person",
    isFounder: false,
    isBoard: false,
    isCurrent: true,
    ...overrides,
  };
}

// ── pgPersonnelToEntries ──────────────────────────────────────────────

describe("pgPersonnelToEntries", () => {
  it("converts a basic row to a PersonEntry", () => {
    const row = makeRow({
      personId: "alice",
      role: "CEO",
      roleType: "key-person",
      startDate: "2020-01-01",
      endDate: null,
      isFounder: true,
      person: { entityId: "e1", slug: "alice-smith", name: "Alice Smith" },
    });

    const result = pgPersonnelToEntries([row]);
    expect(result.entries).toHaveLength(1);
    expect(result.unresolvedCount).toBe(0);
    expect(result.entries[0]).toEqual({
      name: "Alice Smith",
      title: "CEO",
      slug: "alice-smith",
      entityType: "person",
      isFounder: true,
      isBoard: false,
      isCurrent: true,
      start: "2020-01-01",
      end: undefined,
      roleType: "key-person",
    });
  });

  it("uses personResolvedName as fallback when person.name is null", () => {
    const row = makeRow({
      person: { entityId: null, slug: null, name: null },
      personResolvedName: "Resolved Name",
    });

    const result = pgPersonnelToEntries([row]);
    expect(result.entries[0].name).toBe("Resolved Name");
  });

  it("humanizes slug-format personId as last-resort fallback name", () => {
    const row = makeRow({
      personId: "fallback-id",
      person: { entityId: null, slug: null, name: null },
      personResolvedName: null,
    });

    const result = pgPersonnelToEntries([row]);
    expect(result.entries[0].name).toBe("Fallback Id");
  });

  it("excludes bare stableId personId and counts as unresolved", () => {
    const row = makeRow({
      personId: "AbCdEfG12H",
      person: { entityId: null, slug: null, name: null },
      personResolvedName: null,
    });

    const result = pgPersonnelToEntries([row]);
    expect(result.entries).toHaveLength(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it("excludes contaminated stableId personId (with hyphens) and counts as unresolved", () => {
    const row = makeRow({
      personId: "D-BpcrbThn",
      person: { entityId: null, slug: null, name: null },
      personResolvedName: null,
    });

    const result = pgPersonnelToEntries([row]);
    expect(result.entries).toHaveLength(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it("excludes contaminated stableId personId (with underscores) and counts as unresolved", () => {
    const row = makeRow({
      personId: "Tw_Eo226h3",
      person: { entityId: null, slug: null, name: null },
      personResolvedName: null,
    });

    const result = pgPersonnelToEntries([row]);
    expect(result.entries).toHaveLength(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it("excludes numeric PK personId and counts as unresolved", () => {
    const row = makeRow({
      personId: "12345",
      person: { entityId: null, slug: null, name: null },
      personResolvedName: null,
    });

    const result = pgPersonnelToEntries([row]);
    expect(result.entries).toHaveLength(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it("strips 'new:' prefix from personId fallback", () => {
    const row = makeRow({
      personId: "new:Jane Smith",
      person: { entityId: null, slug: null, name: null },
      personResolvedName: null,
    });

    const result = pgPersonnelToEntries([row]);
    expect(result.entries[0].name).toBe("Jane Smith");
  });

  it("sets isCurrent=false when endDate is present", () => {
    const row = makeRow({ endDate: "2023-12-31" });
    const result = pgPersonnelToEntries([row]);
    expect(result.entries[0].isCurrent).toBe(false);
    expect(result.entries[0].end).toBe("2023-12-31");
  });

  it("marks board members correctly", () => {
    const row = makeRow({ roleType: "board" });
    const result = pgPersonnelToEntries([row]);
    expect(result.entries[0].isBoard).toBe(true);
    expect(result.entries[0].roleType).toBe("board");
  });

  it("sets roleType to undefined for invalid roleType values", () => {
    const row = makeRow({ roleType: "unknown-type" as string });
    const result = pgPersonnelToEntries([row]);
    expect(result.entries[0].roleType).toBeUndefined();
  });

  it("handles empty array input", () => {
    const result = pgPersonnelToEntries([]);
    expect(result.entries).toEqual([]);
    expect(result.unresolvedCount).toBe(0);
  });

  it("sets entityType only when slug is present", () => {
    const withSlug = makeRow({
      person: { entityId: "e1", slug: "alice", name: "Alice" },
    });
    const withoutSlug = makeRow({
      person: { entityId: null, slug: null, name: "Bob" },
    });

    const result = pgPersonnelToEntries([withSlug, withoutSlug]);
    expect(result.entries[0].entityType).toBe("person");
    expect(result.entries[1].entityType).toBeUndefined();
  });

  it("correctly partitions mixed named and unnamed records", () => {
    const rows = [
      makeRow({ personId: "alice", person: { entityId: "e1", slug: "alice", name: "Alice" } }),
      makeRow({ personId: "AbCdEfG12H", person: { entityId: null, slug: null, name: null }, personResolvedName: null }),
      makeRow({ personId: "bob-jones", person: { entityId: null, slug: null, name: null }, personResolvedName: null }),
      makeRow({ personId: "XyZaBcDe99", person: { entityId: null, slug: null, name: null }, personResolvedName: null }),
      makeRow({ personId: "D-BpcrbThn", person: { entityId: null, slug: null, name: null }, personResolvedName: null }),
    ];

    const result = pgPersonnelToEntries(rows);
    expect(result.entries).toHaveLength(2); // Alice + Bob Jones (humanized)
    expect(result.unresolvedCount).toBe(3); // 2 clean stableIds + 1 contaminated
    expect(result.entries[0].name).toBe("Alice");
    expect(result.entries[1].name).toBe("Bob Jones");
  });

  it("rejects stableId in personResolvedName and counts as unresolved", () => {
    const row = makeRow({
      personId: "AbCdEfG12H",
      person: { entityId: null, slug: null, name: null },
      personResolvedName: "AbCdEfG12H", // stableId leaked into display name
    });

    const result = pgPersonnelToEntries([row]);
    expect(result.entries).toHaveLength(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it("rejects stableId in person.name and counts as unresolved", () => {
    const row = makeRow({
      personId: "XyZ1234abc",
      person: { entityId: null, slug: null, name: "XyZ1234abc" }, // stableId as name
      personResolvedName: null,
    });

    const result = pgPersonnelToEntries([row]);
    expect(result.entries).toHaveLength(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it("rejects legacy hyphenated IDs like '8-JZq4lrlD'", () => {
    const row = makeRow({
      personId: "cEOljcVT3g",
      person: { entityId: null, slug: null, name: null },
      personResolvedName: "8-JZq4lrlD", // legacy bug ID with hyphen
    });

    const result = pgPersonnelToEntries([row]);
    expect(result.entries).toHaveLength(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it("accepts real names that happen to be short", () => {
    const row = makeRow({
      personId: "li-wei",
      person: { entityId: null, slug: null, name: null },
      personResolvedName: "Li Wei",
    });

    const result = pgPersonnelToEntries([row]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe("Li Wei");
  });
});

// ── mergePgPersonnel ──────────────────────────────────────────────────

describe("mergePgPersonnel", () => {
  it("adds new entries when no overlap exists", () => {
    const existing = new Map<string, PersonEntry>();
    existing.set("alice", makeEntry({ name: "Alice", slug: "alice" }));

    const pgEntries: PersonEntry[] = [
      makeEntry({ name: "Bob", slug: "bob", title: "Engineer" }),
    ];

    mergePgPersonnel(existing, pgEntries);

    expect(existing.size).toBe(2);
    expect(existing.get("bob")).toBeDefined();
    expect(existing.get("bob")!.name).toBe("Bob");
  });

  it("deduplicates by slug match", () => {
    const existing = new Map<string, PersonEntry>();
    existing.set("key-1", makeEntry({ name: "Alice A.", slug: "alice" }));

    const pgEntries: PersonEntry[] = [
      makeEntry({
        name: "Alice Anderson",
        slug: "alice",
        title: "CEO",
        start: "2020-01-01",
      }),
    ];

    mergePgPersonnel(existing, pgEntries);

    // Should not add duplicate
    expect(existing.size).toBe(1);
    // Should enrich the existing entry
    const alice = existing.get("key-1")!;
    expect(alice.name).toBe("Alice A."); // Keeps original name
    expect(alice.title).toBe("CEO"); // Enriched from PG
    expect(alice.start).toBe("2020-01-01"); // Enriched from PG
  });

  it("deduplicates by case-insensitive name match", () => {
    const existing = new Map<string, PersonEntry>();
    existing.set("person-1", makeEntry({ name: "John Smith" }));

    const pgEntries: PersonEntry[] = [
      makeEntry({ name: "john smith", title: "Director", start: "2019-06-15" }),
    ];

    mergePgPersonnel(existing, pgEntries);

    expect(existing.size).toBe(1);
    const john = existing.get("person-1")!;
    expect(john.title).toBe("Director");
    expect(john.start).toBe("2019-06-15");
  });

  it("enriches existing entry without overwriting present fields", () => {
    const existing = new Map<string, PersonEntry>();
    existing.set("key-1", makeEntry({
      name: "Alice",
      slug: "alice",
      title: "Existing Title",
      start: "2018-01-01",
      isBoard: false,
      isFounder: false,
    }));

    const pgEntries: PersonEntry[] = [
      makeEntry({
        name: "Alice",
        slug: "alice",
        title: "New Title",       // Should NOT overwrite
        start: "2020-01-01",      // Should NOT overwrite
        end: "2023-12-31",        // Should fill in (was missing)
        isBoard: true,            // Should set to true
        isFounder: true,          // Should set to true
      }),
    ];

    mergePgPersonnel(existing, pgEntries);

    const alice = existing.get("key-1")!;
    expect(alice.title).toBe("Existing Title"); // Not overwritten
    expect(alice.start).toBe("2018-01-01");     // Not overwritten
    expect(alice.end).toBe("2023-12-31");       // Filled in
    expect(alice.isBoard).toBe(true);           // Set to true
    expect(alice.isFounder).toBe(true);         // Set to true
  });

  it("handles empty PG entries", () => {
    const existing = new Map<string, PersonEntry>();
    existing.set("alice", makeEntry({ name: "Alice" }));

    mergePgPersonnel(existing, []);

    expect(existing.size).toBe(1);
  });

  it("handles empty existing map", () => {
    const existing = new Map<string, PersonEntry>();

    const pgEntries: PersonEntry[] = [
      makeEntry({ name: "Alice", slug: "alice" }),
      makeEntry({ name: "Bob" }),
    ];

    mergePgPersonnel(existing, pgEntries);

    expect(existing.size).toBe(2);
    expect(existing.has("alice")).toBe(true);
    expect(existing.has("Bob")).toBe(true);
  });

  it("uses name as dedup key when slug is absent", () => {
    const existing = new Map<string, PersonEntry>();

    const pgEntries: PersonEntry[] = [
      makeEntry({ name: "Alice No-Slug" }),
    ];

    mergePgPersonnel(existing, pgEntries);

    expect(existing.has("Alice No-Slug")).toBe(true);
  });

  it("prefers slug match over name match", () => {
    const existing = new Map<string, PersonEntry>();
    // Person exists with slug "alice" but different display name
    existing.set("key-1", makeEntry({ name: "Dr. Alice Smith", slug: "alice" }));
    // Another person with name "Alice Smith" but different slug
    existing.set("key-2", makeEntry({ name: "Alice Smith", slug: "alice-other" }));

    const pgEntries: PersonEntry[] = [
      makeEntry({
        name: "Alice Smith",
        slug: "alice",
        title: "CEO",
      }),
    ];

    mergePgPersonnel(existing, pgEntries);

    // Should match by slug to key-1, not by name to key-2
    expect(existing.size).toBe(2);
    expect(existing.get("key-1")!.title).toBe("CEO");
    expect(existing.get("key-2")!.title).toBeUndefined();
  });
});
