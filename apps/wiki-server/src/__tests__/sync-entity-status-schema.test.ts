/**
 * Zod parity test for QUA-526 — SyncEntitySchema.status must reject any
 * value outside the EntityStatus enum, matching the chk_entities_status
 * CHECK constraint added in migration 0218.
 *
 * Drift between this Zod enum, the CHECK constraint, and EntityStatus in
 * data/schema.ts has caused real incidents (see QUA-283 / migration 0173).
 * Pin all three together by spot-checking each accepted/rejected value here.
 */

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
    expect([...ENTITY_STATUS_VALUES]).toEqual([
      "stub",
      "draft",
      "published",
      "verified",
    ]);
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
