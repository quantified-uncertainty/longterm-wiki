// Zod parity test for QUA-526 — SyncEntitySchema.status must mirror
// chk_entities_status (migration 0218). See QUA-283 for prior incidents
// caused by Zod ↔ CHECK drift.

import { describe, it, expect } from "vitest";
import {
  SyncEntitySchema,
  ENTITY_STATUS_VALUES,
} from "../api-types.js";

const validBase = {
  id: "test-entity",
  stableId: "sid_TEST00001",
  entityType: "organization",
  title: "Test Entity",
};

describe("SyncEntitySchema.status — QUA-526 parity with chk_entities_status", () => {
  it("exports the canonical EntityStatus value list", () => {
    // Source of truth that the migration + data/schema.ts must mirror.
    // Set-equality, not order-equality, so legitimate reorderings don't
    // break this test — the migration parity guard does the same.
    expect([...ENTITY_STATUS_VALUES].sort()).toEqual(
      ["draft", "published", "stub", "verified"].sort(),
    );
  });

  for (const value of ENTITY_STATUS_VALUES) {
    it(`accepts status='${value}'`, () => {
      const parsed = SyncEntitySchema.safeParse({ ...validBase, status: value });
      expect(parsed.success).toBe(true);
    });
  }

  it("accepts status=null", () => {
    const parsed = SyncEntitySchema.safeParse({ ...validBase, status: null });
    expect(parsed.success).toBe(true);
  });

  it("accepts status=undefined (field omitted)", () => {
    const parsed = SyncEntitySchema.safeParse({ ...validBase });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["pending"],
    ["active"],
    ["completed"],
    ["Stub"], // case-sensitive
    [""],
    ["unknown-future-status"],
  ])("rejects invalid status='%s'", (badValue) => {
    const parsed = SyncEntitySchema.safeParse({ ...validBase, status: badValue });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The failure must specifically mention the status field (not a different
      // schema violation that happens to fail too).
      expect(
        parsed.error.issues.some((i) => i.path.includes("status")),
      ).toBe(true);
    }
  });
});
