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

    const entries = pgPersonnelToEntries([row]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
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

    const entries = pgPersonnelToEntries([row]);
    expect(entries[0].name).toBe("Resolved Name");
  });

  it("uses personId as last-resort fallback name", () => {
    const row = makeRow({
      personId: "fallback-id",
      person: { entityId: null, slug: null, name: null },
      personResolvedName: null,
    });

    const entries = pgPersonnelToEntries([row]);
    expect(entries[0].name).toBe("fallback-id");
  });

  it("sets isCurrent=false when endDate is present", () => {
    const row = makeRow({ endDate: "2023-12-31" });
    const entries = pgPersonnelToEntries([row]);
    expect(entries[0].isCurrent).toBe(false);
    expect(entries[0].end).toBe("2023-12-31");
  });

  it("marks board members correctly", () => {
    const row = makeRow({ roleType: "board" });
    const entries = pgPersonnelToEntries([row]);
    expect(entries[0].isBoard).toBe(true);
    expect(entries[0].roleType).toBe("board");
  });

  it("sets roleType to undefined for invalid roleType values", () => {
    const row = makeRow({ roleType: "unknown-type" as string });
    const entries = pgPersonnelToEntries([row]);
    expect(entries[0].roleType).toBeUndefined();
  });

  it("handles empty array input", () => {
    const entries = pgPersonnelToEntries([]);
    expect(entries).toEqual([]);
  });

  it("sets entityType only when slug is present", () => {
    const withSlug = makeRow({
      person: { entityId: "e1", slug: "alice", name: "Alice" },
    });
    const withoutSlug = makeRow({
      person: { entityId: null, slug: null, name: "Bob" },
    });

    const entries = pgPersonnelToEntries([withSlug, withoutSlug]);
    expect(entries[0].entityType).toBe("person");
    expect(entries[1].entityType).toBeUndefined();
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
