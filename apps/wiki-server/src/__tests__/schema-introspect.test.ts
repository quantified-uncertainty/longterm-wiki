import { describe, it, expect } from "vitest";
import { introspectSchema } from "../schema-introspect.js";

describe("introspectSchema", () => {
  const { tables, otherExports } = introspectSchema();

  it("finds the full table set (sanity floor — schema only grows)", () => {
    // Guards against the introspection silently returning nothing (e.g. a
    // broken drizzle import). The exact count is asserted by the generated-doc
    // drift gate; here we just require a realistic floor.
    expect(tables.length).toBeGreaterThan(100);
  });

  it("returns tables sorted by name (output must be byte-stable)", () => {
    const names = tables.map((t) => t.tableName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("gives every table at least one column", () => {
    for (const t of tables) {
      expect(t.columns.length, `${t.tableName} has columns`).toBeGreaterThan(0);
    }
  });

  it("resolves every foreign key to a table that exists in the schema", () => {
    const tableNames = new Set(tables.map((t) => t.tableName));
    for (const t of tables) {
      for (const fk of t.foreignKeys) {
        expect(
          tableNames.has(fk.refTable),
          `${t.tableName}.${fk.columns.join(",")} → ${fk.refTable}`
        ).toBe(true);
        expect(fk.columns.length).toBe(fk.refColumns.length);
      }
    }
  });

  it("marks primary-key columns consistently with primaryKeyColumns", () => {
    for (const t of tables) {
      const flagged = t.columns.filter((c) => c.primaryKey).map((c) => c.name).sort();
      expect(flagged).toEqual([...t.primaryKeyColumns].sort());
    }
  });

  it("captures composite primary keys (more than one PK column)", () => {
    const composite = tables.filter((t) => t.primaryKeyColumns.length > 1);
    expect(composite.length).toBeGreaterThan(0);
  });

  it("includes the things_search materialized view among non-table exports", () => {
    expect(otherExports.some((o) => o.objectName === "things_search")).toBe(true);
  });
});
