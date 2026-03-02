import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDbModule } from "./test-utils.js";

// ---- In-memory entity_ids store ----

let entityIdsStore: Map<string, number>; // slug → numeric_id
let nextNumericId: number;

function resetStores() {
  entityIdsStore = new Map();
  nextNumericId = 100; // Start above 0 to detect sentinel bugs
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- entity_ids: INSERT ... ON CONFLICT DO NOTHING ... RETURNING ---
  // numericId uses raw SQL nextval(), so it's embedded in the query string, not in params.
  // Params only contain the slug values — one per row.
  if (q.includes("insert into") && q.includes('"entity_ids"')) {
    const rows: Array<{ slug: string; numeric_id: number }> = [];
    for (const p of params) {
      const slug = p as string;
      if (!entityIdsStore.has(slug)) {
        const id = nextNumericId++;
        entityIdsStore.set(slug, id);
        rows.push({ slug, numeric_id: id });
      }
      // ON CONFLICT DO NOTHING — skip existing slugs (no RETURNING row)
    }
    return rows;
  }

  // --- entity_ids: SELECT WHERE slug IN (...) ---
  if (q.includes('"entity_ids"') && q.includes("where") && q.includes('"slug"')) {
    const results: Array<{ slug: string; numeric_id: number }> = [];
    for (const p of params) {
      const slug = p as string;
      const numericId = entityIdsStore.get(slug);
      if (numericId !== undefined) {
        results.push({ slug, numeric_id: numericId });
      }
    }
    return results;
  }

  // --- entity_ids: SELECT single slug (for resolvePageIntId with LIMIT) ---
  if (q.includes('"entity_ids"') && q.includes("limit")) {
    const slug = params[0] as string;
    const numericId = entityIdsStore.get(slug);
    if (numericId !== undefined) {
      return [{ numeric_id: numericId }];
    }
    return [];
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { resolvePageIntId, resolvePageIntIds, allocateAndResolvePageIntIds } =
  await import("../routes/page-id-helpers.js");
const { getDrizzleDb } = await import("../db.js");

describe("page-id-helpers", () => {
  beforeEach(() => {
    resetStores();
  });

  // ---- resolvePageIntId ----

  describe("resolvePageIntId", () => {
    it("returns null for unknown slug", async () => {
      const db = getDrizzleDb();
      const result = await resolvePageIntId(db, "nonexistent-page");
      expect(result).toBeNull();
    });

    it("returns correct numericId for known slug", async () => {
      entityIdsStore.set("anthropic", 42);
      const db = getDrizzleDb();
      const result = await resolvePageIntId(db, "anthropic");
      expect(result).toBe(42);
    });
  });

  // ---- resolvePageIntIds ----

  describe("resolvePageIntIds", () => {
    it("returns empty map for empty array", async () => {
      const db = getDrizzleDb();
      const result = await resolvePageIntIds(db, []);
      expect(result.size).toBe(0);
    });

    it("returns only existing slugs in result", async () => {
      entityIdsStore.set("anthropic", 42);
      entityIdsStore.set("openai", 99);
      const db = getDrizzleDb();

      const result = await resolvePageIntIds(db, [
        "anthropic",
        "nonexistent",
        "openai",
      ]);
      expect(result.size).toBe(2);
      expect(result.get("anthropic")).toBe(42);
      expect(result.get("openai")).toBe(99);
      expect(result.has("nonexistent")).toBe(false);
    });

    it("deduplicates input slugs", async () => {
      entityIdsStore.set("anthropic", 42);
      const db = getDrizzleDb();

      const result = await resolvePageIntIds(db, [
        "anthropic",
        "anthropic",
        "anthropic",
      ]);
      expect(result.size).toBe(1);
      expect(result.get("anthropic")).toBe(42);
    });
  });

  // ---- allocateAndResolvePageIntIds ----

  describe("allocateAndResolvePageIntIds", () => {
    it("returns empty map for empty array", async () => {
      const db = getDrizzleDb();
      const result = await allocateAndResolvePageIntIds(db, []);
      expect(result.size).toBe(0);
    });

    it("allocates new IDs for missing slugs", async () => {
      const db = getDrizzleDb();
      const result = await allocateAndResolvePageIntIds(db, [
        "new-page-a",
        "new-page-b",
      ]);

      expect(result.size).toBe(2);
      expect(result.has("new-page-a")).toBe(true);
      expect(result.has("new-page-b")).toBe(true);
      // Allocated IDs should be distinct
      expect(result.get("new-page-a")).not.toBe(result.get("new-page-b"));
      // And they should now be in the store
      expect(entityIdsStore.has("new-page-a")).toBe(true);
      expect(entityIdsStore.has("new-page-b")).toBe(true);
    });

    it("returns existing IDs without re-allocating", async () => {
      entityIdsStore.set("anthropic", 42);
      entityIdsStore.set("openai", 99);
      const db = getDrizzleDb();

      const result = await allocateAndResolvePageIntIds(db, [
        "anthropic",
        "openai",
      ]);

      expect(result.size).toBe(2);
      expect(result.get("anthropic")).toBe(42);
      expect(result.get("openai")).toBe(99);
      // nextNumericId should not have been incremented
      expect(nextNumericId).toBe(100);
    });

    it("handles mix of existing and new slugs", async () => {
      entityIdsStore.set("anthropic", 42);
      const db = getDrizzleDb();

      const result = await allocateAndResolvePageIntIds(db, [
        "anthropic",
        "new-page",
      ]);

      expect(result.size).toBe(2);
      expect(result.get("anthropic")).toBe(42); // existing, unchanged
      expect(result.has("new-page")).toBe(true); // newly allocated
      expect(result.get("new-page")).toBeGreaterThanOrEqual(100); // from our counter
    });

    it("deduplicates input slugs", async () => {
      const db = getDrizzleDb();

      const result = await allocateAndResolvePageIntIds(db, [
        "page-a",
        "page-a",
        "page-b",
        "page-b",
      ]);

      expect(result.size).toBe(2);
      // Only 2 IDs allocated, not 4
      expect(nextNumericId).toBe(102);
    });
  });
});
