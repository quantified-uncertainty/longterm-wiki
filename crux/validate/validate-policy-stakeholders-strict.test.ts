/**
 * Tests for validate-policy-stakeholders-strict (QUA-964).
 *
 * The validator reads `data/entities/*.yaml` directly, so the smoke test
 * is "current YAML passes". Schema-level coverage (catching the QUA-941
 * `position: reform` regression) is exercised against the SyncStakeholderItemSchema
 * directly so the test doesn't need to mutate real YAML.
 */

import { describe, it, expect } from "vitest";
import { runCheck } from "./validate-policy-stakeholders-strict.ts";
import {
  SyncStakeholderItemSchema,
  VALID_POSITIONS,
} from "../../apps/wiki-server/src/routes/tablebase/policy-stakeholders-schema.ts";

describe("validate-policy-stakeholders-strict", () => {
  it("passes against current data/entities/", async () => {
    const res = await runCheck();
    expect(res.passed).toBe(true);
    expect(res.errors).toBe(0);
    // Sanity: there should be at least a handful of policies/stakeholders.
    expect(res.checkedPolicies).toBeGreaterThan(0);
    expect(res.checkedStakeholders).toBeGreaterThan(0);
  });

  it("VALID_POSITIONS does not include the QUA-941 regressor 'reform'", () => {
    // If this changes, either the route schema widened (then update the
    // test) or someone re-introduced the bad value (then this test catches it).
    expect(VALID_POSITIONS).toEqual(["support", "oppose", "neutral", "mixed"]);
    expect(VALID_POSITIONS as readonly string[]).not.toContain("reform");
  });

  it("rejects position: reform via the imported sync schema (QUA-941)", () => {
    const result = SyncStakeholderItemSchema.safeParse({
      id: "abcdef0123",
      policyEntityId: "sid_test",
      stakeholderDisplayName: "Test",
      position: "reform",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const positionError = result.error.issues.find(
        (i) => i.path.join(".") === "position",
      );
      expect(positionError).toBeDefined();
      expect(positionError!.message).toMatch(/Invalid enum value/);
    }
  });

  it("rejects empty stakeholderDisplayName", () => {
    const result = SyncStakeholderItemSchema.safeParse({
      id: "abcdef0123",
      policyEntityId: "sid_test",
      stakeholderDisplayName: "",
      position: "support",
    });
    expect(result.success).toBe(false);
  });

  it("rejects id of wrong length", () => {
    const result = SyncStakeholderItemSchema.safeParse({
      id: "tooshort",
      policyEntityId: "sid_test",
      stakeholderDisplayName: "Test",
      position: "support",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a fully-populated valid row", () => {
    const result = SyncStakeholderItemSchema.safeParse({
      id: "abcdef0123",
      policyEntityId: "sid_test",
      stakeholderEntityId: "sid_target",
      stakeholderDisplayName: "Test Person",
      position: "support",
      importance: "high",
      reason: "rationale",
      source: "https://example.com",
      context: ["a", "b"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a minimal row (only required fields)", () => {
    const result = SyncStakeholderItemSchema.safeParse({
      id: "abcdef0123",
      policyEntityId: "sid_test",
      stakeholderDisplayName: "Test",
      position: "neutral",
    });
    expect(result.success).toBe(true);
  });
});
