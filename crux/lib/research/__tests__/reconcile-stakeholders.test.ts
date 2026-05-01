import { describe, it, expect } from "vitest";
import {
  reconcilePolicyStakeholders,
  type PgStakeholderRow,
  type PolicyEntityForReconcile,
} from "../reconcile-stakeholders.ts";

const POLICY_A = "sid_PolicyA";
const POLICY_B = "sid_PolicyB";

function pgRow(over: Partial<PgStakeholderRow> = {}): PgStakeholderRow {
  return {
    id: "abc1234567",
    policyEntityId: POLICY_A,
    stakeholderEntityId: null,
    stakeholderDisplayName: "ACLU",
    position: "oppose",
    importance: null,
    reason: null,
    source: null,
    context: null,
    ...over,
  };
}

describe("reconcilePolicyStakeholders", () => {
  it("returns zero diffs in steady state (YAML and PG agree on the same rows)", () => {
    const policies: PolicyEntityForReconcile[] = [
      {
        id: "policy-a",
        type: "policy",
        stableId: POLICY_A,
        stakeholders: [
          { name: "ACLU", position: "oppose" },
          { name: "EFF", position: "oppose" },
        ],
      },
    ];
    const pg = new Map<string, PgStakeholderRow[]>([
      [
        POLICY_A,
        [
          pgRow({ id: "1", stakeholderDisplayName: "ACLU" }),
          pgRow({ id: "2", stakeholderDisplayName: "EFF" }),
        ],
      ],
    ]);
    const r = reconcilePolicyStakeholders(policies, pg);
    expect(r.entitiesScanned).toBe(1);
    expect(r.entitiesNonEmpty).toBe(1);
    expect(r.entitiesWithDiff).toBe(0);
    expect(r.entitiesNonEmptyWithDiff).toBe(0);
    expect(r.diffs).toEqual([]);
  });

  it("flags missingFromPg when YAML has a stakeholder PG doesn't", () => {
    const policies: PolicyEntityForReconcile[] = [
      {
        id: "policy-a",
        type: "policy",
        stableId: POLICY_A,
        stakeholders: [
          { name: "ACLU", position: "oppose" },
          { name: "EFF", position: "oppose" },
        ],
      },
    ];
    const pg = new Map<string, PgStakeholderRow[]>([
      [POLICY_A, [pgRow({ id: "1", stakeholderDisplayName: "ACLU" })]],
    ]);
    const r = reconcilePolicyStakeholders(policies, pg);
    expect(r.entitiesWithDiff).toBe(1);
    expect(r.entitiesNonEmptyWithDiff).toBe(1);
    expect(r.diffs[0].missingFromPg).toEqual(["EFF"]);
  });

  it("flags missingFromYaml when PG has a stakeholder YAML doesn't", () => {
    const policies: PolicyEntityForReconcile[] = [
      {
        id: "policy-a",
        type: "policy",
        stableId: POLICY_A,
        stakeholders: [{ name: "ACLU", position: "oppose" }],
      },
    ];
    const pg = new Map<string, PgStakeholderRow[]>([
      [
        POLICY_A,
        [
          pgRow({ id: "1", stakeholderDisplayName: "ACLU" }),
          pgRow({ id: "2", stakeholderDisplayName: "EFF" }),
        ],
      ],
    ]);
    const r = reconcilePolicyStakeholders(policies, pg);
    expect(r.diffs[0].missingFromYaml).toEqual(["EFF"]);
  });

  it("ignores legacy `position: reform` in YAML (drops at normalize)", () => {
    const policies: PolicyEntityForReconcile[] = [
      {
        id: "policy-a",
        type: "policy",
        stableId: POLICY_A,
        stakeholders: [{ name: "ACLU", position: "reform" }],
      },
    ];
    const pg = new Map<string, PgStakeholderRow[]>(); // PG has none.
    const r = reconcilePolicyStakeholders(policies, pg);
    // Reform-position YAML entry is dropped pre-compare → no diff, and
    // entitiesNonEmpty is 0 because the YAML had no PG-eligible stakeholders.
    expect(r.entitiesNonEmpty).toBe(0);
    expect(r.entitiesWithDiff).toBe(0);
  });

  it("does NOT count empty-YAML diffs toward `entitiesNonEmptyWithDiff` (red-team #4)", () => {
    // Policy A: empty YAML, PG has one row → diff exists, but it's an
    // "empty-YAML" diff. Should NOT trigger the Phase 4 precondition.
    const policies: PolicyEntityForReconcile[] = [
      {
        id: "policy-a",
        type: "policy",
        stableId: POLICY_A,
        stakeholders: [],
      },
    ];
    const pg = new Map<string, PgStakeholderRow[]>([
      [POLICY_A, [pgRow({ id: "1", stakeholderDisplayName: "ACLU" })]],
    ]);
    const r = reconcilePolicyStakeholders(policies, pg);
    expect(r.entitiesNonEmpty).toBe(0);
    expect(r.entitiesWithDiff).toBe(1);
    expect(r.entitiesNonEmptyWithDiff).toBe(0);
  });

  it("emits per-field diffs when normalized values disagree", () => {
    const policies: PolicyEntityForReconcile[] = [
      {
        id: "policy-a",
        type: "policy",
        stableId: POLICY_A,
        stakeholders: [
          { name: "ACLU", position: "oppose", importance: "high" },
        ],
      },
    ];
    const pg = new Map<string, PgStakeholderRow[]>([
      [
        POLICY_A,
        [
          pgRow({
            id: "1",
            stakeholderDisplayName: "ACLU",
            position: "support", // <— differs
            importance: "high",
          }),
        ],
      ],
    ]);
    const r = reconcilePolicyStakeholders(policies, pg);
    expect(r.diffs[0].fieldDiffs).toHaveLength(1);
    expect(r.diffs[0].fieldDiffs[0].field).toBe("position");
    expect(r.diffs[0].fieldDiffs[0].yaml).toBe("oppose");
    expect(r.diffs[0].fieldDiffs[0].pg).toBe("support");
  });

  it("skips entities without a stableId (cannot diff against PG by definition)", () => {
    const policies: PolicyEntityForReconcile[] = [
      {
        id: "policy-no-sid",
        type: "policy",
        // no stableId
        stakeholders: [{ name: "ACLU", position: "oppose" }],
      },
    ];
    const pg = new Map<string, PgStakeholderRow[]>();
    const r = reconcilePolicyStakeholders(policies, pg);
    expect(r.entitiesScanned).toBe(0);
    expect(r.diffs).toEqual([]);
  });

  it("ignores non-policy entity types (organizations, etc.)", () => {
    const policies: PolicyEntityForReconcile[] = [
      {
        id: "openai",
        type: "organization",
        stableId: POLICY_B,
        stakeholders: [{ name: "stray", position: "oppose" }],
      },
    ];
    const pg = new Map<string, PgStakeholderRow[]>();
    const r = reconcilePolicyStakeholders(policies, pg);
    expect(r.entitiesScanned).toBe(0);
  });
});
