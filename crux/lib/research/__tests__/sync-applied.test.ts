import { describe, it, expect } from "vitest";
import { applyVerdictsToPolicy, type VerifiedVerdict } from "../apply-verdicts.ts";
import type { PolicyEntity } from "../gap-analyzer.ts";
import { convertAppliedToStakeholderSync } from "../sync-applied.ts";
import { SyncStakeholderItemSchema } from "../../../../apps/wiki-server/src/routes/tablebase/policy-stakeholders-schema.ts";

const POLICY_ID = "sid_TestPolicy01";

function basePolicy(over: Partial<PolicyEntity> = {}): PolicyEntity {
  return {
    id: "test-policy",
    type: "policy",
    stableId: POLICY_ID,
    title: "Test Policy",
    stakeholders: [],
    ...over,
  };
}

function v(over: Partial<VerifiedVerdict>): VerifiedVerdict {
  return {
    targetField: "stakeholder.aclu",
    claimText: "ACLU opposes the bill on civil liberties grounds",
    extractedValue: null,
    proposedValue: null,
    sourceUrl: "https://aclu.org/statement",
    status: "verified",
    displayHint: "ACLU",
    position: "oppose",
    positionConfidence: 0.9,
    ...over,
  };
}

describe("convertAppliedToStakeholderSync", () => {
  // ─── Empty / no-op cases ───────────────────────────────────────────────

  it("returns empty items when applied is empty", () => {
    const apply = applyVerdictsToPolicy(basePolicy(), []);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("ignores non-stakeholder applied entries", () => {
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "scalar.description", claimText: "A description" }),
      v({ targetField: "tag.civil-liberties", claimText: "civil-liberties" }),
      v({ targetField: "provision.section-1", claimText: "Provision text" }),
    ]);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items).toEqual([]);
  });

  it("drops applied entries with action='skipped'", () => {
    // First apply seeds an existing stakeholder; second apply with the same
    // displayHint and a shorter reason will skip — same targetField, but
    // action='skipped' should not produce an item.
    const seeded = basePolicy({
      stakeholders: [
        {
          name: "ACLU",
          position: "oppose",
          importance: "medium",
          reason: "Existing very long detailed reason that is much longer than what we'll feed in",
          source: "https://existing.example",
        },
      ],
    });
    const apply = applyVerdictsToPolicy(seeded, [
      v({ targetField: "stakeholder.aclu", claimText: "Short" }),
    ]);
    // Sanity-check that the apply produced a "skipped" entry, not an update.
    expect(apply.applied[0]?.action).toBe("skipped");
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items).toEqual([]);
  });

  // ─── Happy path ──────────────────────────────────────────────────────

  it("emits one item per added stakeholder", () => {
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "stakeholder.aclu", displayHint: "ACLU" }),
      v({
        targetField: "stakeholder.eff",
        displayHint: "EFF",
        claimText: "EFF opposes",
      }),
    ]);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.stakeholderDisplayName).sort()).toEqual([
      "ACLU",
      "EFF",
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("produces items that pass the canonical Zod schema", () => {
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "stakeholder.aclu", displayHint: "ACLU" }),
    ]);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items).toHaveLength(1);
    const parsed = SyncStakeholderItemSchema.safeParse(result.items[0]);
    expect(parsed.success).toBe(true);
  });

  it("generates deterministic 10-char IDs from policyId+name", () => {
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "stakeholder.aclu", displayHint: "ACLU" }),
    ]);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items[0].id).toHaveLength(10);
    // Re-converting should produce the same ID (determinism).
    const result2 = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result2.items[0].id).toBe(result.items[0].id);
  });

  it("propagates entityId from resolveStakeholderEntity", () => {
    const apply = applyVerdictsToPolicy(
      basePolicy(),
      [v({ targetField: "stakeholder.aclu", displayHint: "ACLU" })],
      {
        // canonicalSlug("ACLU") → "american-civil-liberties-union" via the alias index
        resolveStakeholderEntity: (canonical) =>
          canonical === "american-civil-liberties-union" ? "sid_AclueId01" : null,
      },
    );
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items[0].stakeholderEntityId).toBe("sid_AclueId01");
  });

  it("preserves importance when the YAML enum value is valid", () => {
    const seeded = basePolicy({
      stakeholders: [
        {
          name: "ACLU",
          position: "oppose",
          importance: "high",
          reason: "short",
          source: "https://aclu.org",
        },
      ],
    });
    // Trigger an update by feeding a longer reason for the same stakeholder.
    const apply = applyVerdictsToPolicy(seeded, [
      v({
        targetField: "stakeholder.aclu",
        displayHint: "ACLU",
        claimText:
          "ACLU has issued a much-longer-than-existing detailed statement opposing this bill",
      }),
    ]);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items[0].importance).toBe("high");
  });

  // ─── Position handling ──────────────────────────────────────────────

  it("drops stakeholders with no position and emits a warning", () => {
    // Verdict with low confidence → position is left unset on the new
    // stakeholder. PG schema requires position, so the converter drops it.
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({
        targetField: "stakeholder.aclu",
        displayHint: "ACLU",
        position: "oppose",
        positionConfidence: 0.1, // below MIN_POSITION_CONFIDENCE = 0.6
      }),
    ]);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/no position on post-apply entity/);
  });

  it("drops stakeholders with non-PG-enum position values and emits a warning", () => {
    // 'reform' is in the YAML enum but NOT in the PG enum (QUA-875 phaseout).
    // Seed an entity with reform stakeholder so the post-apply state has it,
    // then trigger an update verdict on that stakeholder.
    const seeded = basePolicy({
      stakeholders: [
        {
          name: "Reform Group",
          position: "reform",
          importance: "medium",
          reason: "short",
          source: "https://example.com",
        },
      ],
    });
    const apply = applyVerdictsToPolicy(seeded, [
      v({
        targetField: "stakeholder.reform-group",
        displayHint: "Reform Group",
        claimText:
          "Reform Group has a much longer position than the seeded one to trigger update",
      }),
    ]);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/position='reform'/);
  });

  // ─── Slug aliasing ──────────────────────────────────────────────────

  it("matches applied targetField to canonical stakeholder name (alias)", () => {
    // The applier itself dedupes 'fbi' and 'federal-bureau-of-investigation'
    // to one stakeholder. The converter should resolve either applied
    // targetField to the same post-apply row.
    const seeded = basePolicy({
      stakeholders: [
        {
          name: "Federal Bureau of Investigation",
          position: "support",
          importance: "high",
          reason: "Existing reason on the FBI",
          source: "https://fbi.gov",
        },
      ],
    });
    const apply = applyVerdictsToPolicy(seeded, [
      // The verdict uses the alias slug "fbi" — applier should match the
      // existing row, the converter should follow the same canonicalization.
      v({
        targetField: "stakeholder.fbi",
        displayHint: "FBI",
        claimText:
          "FBI has issued a longer statement supporting the bill's enforcement provisions in detail",
      }),
    ]);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].stakeholderDisplayName).toBe(
      "Federal Bureau of Investigation",
    );
  });

  it("dedupes when multiple applied entries resolve to the same stakeholder", () => {
    const seeded = basePolicy({
      stakeholders: [
        {
          name: "Federal Bureau of Investigation",
          position: "support",
          importance: "high",
          reason: "Existing reason",
          source: "https://fbi.gov",
        },
      ],
    });
    const apply = applyVerdictsToPolicy(seeded, [
      v({
        targetField: "stakeholder.fbi",
        displayHint: "FBI",
        claimText:
          "FBI longer position one with much more substance than what is currently on file",
      }),
      v({
        targetField: "stakeholder.federal-bureau-of-investigation",
        displayHint: "Federal Bureau of Investigation",
        claimText:
          "FBI longer position two ALSO substantially exceeds the existing seed reason length",
      }),
    ]);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    // Two applied entries → one item (dedup by id).
    expect(result.items).toHaveLength(1);
  });

  it("warns when applied stakeholder slug has no match in post-apply entity", () => {
    // Construct an apply result by hand to simulate the pathological
    // case: applied lists "stakeholder.ghost" but the entity has no
    // stakeholders. (This shouldn't happen in real flows, but we want
    // the converter to be defensive rather than throw.)
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: {
        entity: basePolicy(),
        applied: [{ targetField: "stakeholder.ghost", action: "added" }],
        warnings: [],
      },
    });
    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/no matching stakeholder/);
  });

  // ─── Field preservation (parity with build-data helper) ──────────────

  it("preserves a string-array context field when present", () => {
    const seeded = basePolicy({
      stakeholders: [
        {
          name: "ACLU",
          position: "oppose",
          importance: "high",
          reason: "short",
          source: "https://aclu.org",
          // The gap-analyzer PolicyEntity type omits `context` but the
          // route schema accepts it; YAML in the wild may carry it.
          context: ["civil-liberties", "constitutional-law"],
        } as unknown as NonNullable<PolicyEntity["stakeholders"]>[number],
      ],
    });
    const apply = applyVerdictsToPolicy(seeded, [
      v({
        targetField: "stakeholder.aclu",
        displayHint: "ACLU",
        claimText:
          "ACLU has issued a much-longer-than-existing detailed statement opposing this bill",
      }),
    ]);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items[0].context).toEqual([
      "civil-liberties",
      "constitutional-law",
    ]);
  });

  it("emits context: null when the YAML field is missing or malformed", () => {
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "stakeholder.aclu", displayHint: "ACLU" }),
    ]);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    // PolicyEntity type doesn't include context; converter should default.
    expect(result.items[0].context).toBeNull();
  });

  // ─── Importance handling ─────────────────────────────────────────────

  it("warns and drops the importance field when the YAML value is not in the PG enum", () => {
    const seeded = basePolicy({
      stakeholders: [
        {
          name: "ACLU",
          position: "oppose",
          importance: "critical" as unknown as "high",
          reason: "short",
          source: "https://aclu.org",
        },
      ],
    });
    const apply = applyVerdictsToPolicy(seeded, [
      v({
        targetField: "stakeholder.aclu",
        displayHint: "ACLU",
        claimText:
          "ACLU has issued a much-longer-than-existing detailed statement opposing this bill",
      }),
    ]);
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: apply,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].importance).toBeUndefined();
    const importanceWarning = result.warnings.find((w) =>
      /importance='critical'/.test(w),
    );
    expect(importanceWarning).toBeDefined();
  });

  // ─── Stakeholder map collisions ──────────────────────────────────────

  it("warns when the post-apply entity has two stakeholders that canonicalize to the same slug", () => {
    // Hand-construct an ApplyResult to bypass the applier's own dedup.
    const result = convertAppliedToStakeholderSync({
      policyEntityId: POLICY_ID,
      applyResult: {
        entity: basePolicy({
          stakeholders: [
            {
              name: "FBI",
              position: "support",
              importance: "high",
              reason: "first",
              source: "https://fbi.gov",
            },
            {
              name: "Federal Bureau of Investigation",
              position: "oppose",
              importance: "high",
              reason: "second",
              source: "https://fbi.gov",
            },
          ],
        }),
        applied: [{ targetField: "stakeholder.fbi", action: "added" }],
        warnings: [],
      },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].stakeholderDisplayName).toBe("FBI"); // first-write-wins
    const collisionWarning = result.warnings.find((w) =>
      /canonicalize to/.test(w),
    );
    expect(collisionWarning).toBeDefined();
  });
});
