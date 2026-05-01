/**
 * Tests for validate-policy-stakeholders-strict (QUA-964).
 *
 * The validator reads `data/entities/*.yaml` directly, so the smoke test
 * is "current YAML passes". Schema-level coverage (catching the QUA-941
 * `position: reform` regression) is exercised against the SyncStakeholderItemSchema
 * directly so the test doesn't need to mutate real YAML.
 */

import { describe, it, expect } from "vitest";
import {
  runCheck,
  evaluatePolicies,
} from "./validate-policy-stakeholders-strict.ts";
import {
  SyncStakeholderItemSchema,
  VALID_POSITIONS,
  VALID_IMPORTANCE,
} from "../../apps/wiki-server/src/routes/tablebase/policy-stakeholders-schema.ts";

const SRC = "/synthetic.yaml";
function policy(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-policy",
    type: "policy",
    stableId: "sid_TestPolicy",
    stakeholders: [],
    _sourceFile: SRC,
    ...overrides,
  };
}

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

  it("VALID_IMPORTANCE matches sync schema", () => {
    expect(VALID_IMPORTANCE).toEqual(["high", "medium", "low"]);
  });
});

describe("evaluatePolicies (negative paths)", () => {
  it("returns empty findings for current valid input", () => {
    const policies = [
      policy({
        stakeholders: [{ name: "Alice", position: "support" }],
      }),
    ];
    const r = evaluatePolicies(policies);
    expect(r.findings).toHaveLength(0);
    expect(r.checkedStakeholders).toBe(1);
    expect(r.checkedPolicies).toBe(1);
    expect(r.skippedPolicies).toBe(0);
  });

  it("emits a finding for position: reform (the QUA-941 regressor)", () => {
    const policies = [
      policy({
        stakeholders: [{ name: "Alice", position: "reform" }],
      }),
    ];
    const r = evaluatePolicies(policies);
    expect(r.findings.length).toBeGreaterThan(0);
    const positionFinding = r.findings.find((f) => f.field === "position");
    expect(positionFinding).toBeDefined();
    expect(positionFinding!.policyId).toBe("test-policy");
    expect(positionFinding!.stakeholder).toBe("Alice");
    expect(positionFinding!.message).toMatch(/Invalid enum value/);
  });

  it("emits a finding when stakeholder name is missing (Zod rejects displayName)", () => {
    const policies = [
      policy({
        stakeholders: [{ position: "support" } as Record<string, unknown>],
      }),
    ];
    const r = evaluatePolicies(policies);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.field.includes("stakeholderDisplayName"))).toBe(true);
  });

  it("emits a finding when entityId is a number (helper-vs-validator drift fix)", () => {
    // The runtime helper would forward `entityId: 42` via `s.entityId || null` →
    // 42 (truthy). The route's Zod schema requires string-or-null. The
    // validator must catch this same drift at PR time, not silently coerce
    // to null and pass.
    const policies = [
      policy({
        stakeholders: [
          { name: "Alice", position: "support", entityId: 42 } as Record<string, unknown>,
        ],
      }),
    ];
    const r = evaluatePolicies(policies);
    expect(r.findings.some((f) => f.field === "stakeholderEntityId")).toBe(true);
  });

  it("emits a finding when context is a string (route schema requires array)", () => {
    const policies = [
      policy({
        stakeholders: [
          { name: "Alice", position: "support", context: "single" } as Record<
            string,
            unknown
          >,
        ],
      }),
    ];
    const r = evaluatePolicies(policies);
    expect(r.findings.some((f) => f.field.startsWith("context"))).toBe(true);
  });

  it("skips policies missing stableId (mirrors helper)", () => {
    const policies = [
      policy({
        stableId: undefined,
        stakeholders: [{ name: "Alice", position: "support" }],
      }),
    ];
    const r = evaluatePolicies(policies);
    expect(r.skippedPolicies).toBe(1);
    expect(r.checkedPolicies).toBe(0);
    expect(r.findings).toHaveLength(0);
  });

  it("emits multiple findings per policy (each Zod issue → separate finding)", () => {
    const policies = [
      policy({
        stakeholders: [
          // Both position invalid AND name missing — should produce 2+ findings.
          { position: "reform" } as Record<string, unknown>,
        ],
      }),
    ];
    const r = evaluatePolicies(policies);
    expect(r.findings.length).toBeGreaterThanOrEqual(2);
  });

  it("non-empty findings flow through runCheck()", async () => {
    // runCheck() reads real YAML — it must currently pass. This is the
    // smoke test that runCheck still wires `evaluatePolicies` correctly.
    const r = await runCheck();
    expect(r.passed).toBe(true);
    expect(r.errors).toBe(0);
  });
});
