import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  exportPolicyStakeholdersToYaml,
  pgRowToYamlStakeholder,
  rebuildStakeholdersForPolicy,
} from "./export-policy-stakeholders-to-yaml.ts";

const FIXTURE_YAML = `- id: example-bill
  stableId: sid_AAAAA01
  type: policy
  title: Example Bill
  stakeholders:
    - name: Senator A
      entityId: sid_BBBBB02
      position: support
      role: Co-sponsor
      importance: high
      reason: Authored the bill
    - name: Senator B
      position: oppose
      reason: Opposed on civil-liberties grounds
`;

const PG_ROWS_FOR_EXAMPLE = [
  {
    id: "row-A",
    policyEntityId: "sid_AAAAA01",
    stakeholderEntityId: "sid_BBBBB02",
    stakeholderDisplayName: "Senator A",
    position: "support",
    importance: "high",
    reason: "Authored the bill",
    source: null,
    context: null,
  },
  {
    id: "row-B",
    policyEntityId: "sid_AAAAA01",
    stakeholderEntityId: null,
    stakeholderDisplayName: "Senator B",
    position: "oppose",
    importance: null,
    reason: "Opposed on civil-liberties grounds",
    source: null,
    context: null,
  },
];

describe("pgRowToYamlStakeholder", () => {
  it("emits all populated YAML fields", () => {
    const out = pgRowToYamlStakeholder(
      {
        id: "x",
        policyEntityId: "p",
        stakeholderEntityId: "sid_xy",
        stakeholderDisplayName: "ACLU",
        position: "oppose",
        importance: "high",
        reason: "Civil liberties concerns",
        source: "https://aclu.org/article",
        context: ["Filed amicus brief"],
      },
      undefined,
    );
    expect(out).toEqual({
      name: "ACLU",
      entityId: "sid_xy",
      position: "oppose",
      importance: "high",
      reason: "Civil liberties concerns",
      source: "https://aclu.org/article",
      context: ["Filed amicus brief"],
    });
  });

  it("omits null/empty fields rather than emitting null", () => {
    const out = pgRowToYamlStakeholder(
      {
        id: "x",
        policyEntityId: "p",
        stakeholderEntityId: null,
        stakeholderDisplayName: "Group",
        position: "support",
        importance: null,
        reason: null,
        source: null,
        context: null,
      },
      undefined,
    );
    expect(out).toEqual({ name: "Group", position: "support" });
    expect(out.entityId).toBeUndefined();
    expect(out.context).toBeUndefined();
  });

  it("omits empty context arrays (no `context: []` round-trip)", () => {
    const out = pgRowToYamlStakeholder(
      {
        id: "x",
        policyEntityId: "p",
        stakeholderEntityId: null,
        stakeholderDisplayName: "Group",
        position: "support",
        importance: null,
        reason: null,
        source: null,
        context: [],
      },
      undefined,
    );
    expect(out.context).toBeUndefined();
  });

  it("attaches preserved YAML role when present (QUA-984 workaround)", () => {
    const out = pgRowToYamlStakeholder(
      {
        id: "x",
        policyEntityId: "p",
        stakeholderEntityId: "sid_xy",
        stakeholderDisplayName: "Senator A",
        position: "support",
        importance: null,
        reason: null,
        source: null,
        context: null,
      },
      "Co-sponsor",
    );
    expect(out.role).toBe("Co-sponsor");
  });
});

describe("rebuildStakeholdersForPolicy", () => {
  it("sorts by position bucket then name", () => {
    const rows = [
      { id: "1", policyEntityId: "p", stakeholderEntityId: null, stakeholderDisplayName: "Zee", position: "support", importance: null, reason: null, source: null, context: null },
      { id: "2", policyEntityId: "p", stakeholderEntityId: null, stakeholderDisplayName: "Bob", position: "oppose", importance: null, reason: null, source: null, context: null },
      { id: "3", policyEntityId: "p", stakeholderEntityId: null, stakeholderDisplayName: "Ada", position: "support", importance: null, reason: null, source: null, context: null },
    ];
    const result = rebuildStakeholdersForPolicy(rows, undefined);
    expect(result.map((s) => s.name)).toEqual(["Ada", "Zee", "Bob"]);
  });

  it("preserves role from existing YAML by name", () => {
    const rows = [
      { id: "1", policyEntityId: "p", stakeholderEntityId: null, stakeholderDisplayName: "Senator A", position: "support", importance: null, reason: null, source: null, context: null },
    ];
    const existing = [
      { name: "Senator A", position: "support", role: "Primary Author / Sponsor" },
    ];
    const result = rebuildStakeholdersForPolicy(rows, existing);
    expect(result[0].role).toBe("Primary Author / Sponsor");
  });
});

describe("exportPolicyStakeholdersToYaml", () => {
  it("rebuilds YAML stakeholder blocks from PG rows", async () => {
    const result = await exportPolicyStakeholdersToYaml({
      yamlInput: FIXTURE_YAML,
      rows: PG_ROWS_FOR_EXAMPLE,
      dryRun: true,
    });
    const parsed = parseYaml(result.yamlAfter) as Array<{
      id: string;
      stakeholders?: Array<{ name: string; position: string; role?: string }>;
    }>;
    expect(parsed[0].stakeholders).toHaveLength(2);
    expect(parsed[0].stakeholders![0].name).toBe("Senator A");
    expect(parsed[0].stakeholders![0].position).toBe("support");
    // Role is preserved from the original YAML (QUA-984 workaround)
    expect(parsed[0].stakeholders![0].role).toBe("Co-sponsor");
    expect(result.policiesUpdated).toBe(1);
    expect(result.policiesSkipped).toBe(0);
  });

  it("round-trip: PG → YAML → PG produces stable PG payload (excluding ids)", async () => {
    // The interesting invariant: re-importing the rebuilt YAML and converting
    // back to PG payload yields the same stakeholders (same names, positions,
    // reasons, sources). This is the rollback-fidelity test.
    const result = await exportPolicyStakeholdersToYaml({
      yamlInput: FIXTURE_YAML,
      rows: PG_ROWS_FOR_EXAMPLE,
      dryRun: true,
    });
    const parsed = parseYaml(result.yamlAfter) as Array<{
      stableId: string;
      stakeholders?: Array<Record<string, unknown>>;
    }>;
    const policy = parsed.find((p) => p.stableId === "sid_AAAAA01");
    expect(policy).toBeDefined();
    expect(policy!.stakeholders).toHaveLength(PG_ROWS_FOR_EXAMPLE.length);

    const reExtracted = (policy!.stakeholders ?? []).map((s) => ({
      name: s.name,
      entityId: s.entityId ?? null,
      position: s.position,
      reason: s.reason ?? null,
      source: s.source ?? null,
    }));
    const expected = [...PG_ROWS_FOR_EXAMPLE]
      .sort((a, b) => {
        const order: Record<string, number> = { support: 0, oppose: 1, mixed: 2, neutral: 3 };
        return (order[a.position] ?? 99) - (order[b.position] ?? 99);
      })
      .map((r) => ({
        name: r.stakeholderDisplayName,
        entityId: r.stakeholderEntityId,
        position: r.position,
        reason: r.reason,
        source: r.source,
      }));
    expect(reExtracted).toEqual(expected);
  });

  it("skips policies with no PG rows (no destructive overwrite)", async () => {
    const result = await exportPolicyStakeholdersToYaml({
      yamlInput: FIXTURE_YAML,
      rows: [],
      dryRun: true,
    });
    expect(result.policiesUpdated).toBe(0);
    expect(result.policiesSkipped).toBe(1);
    // YAML stakeholders must remain in place — rollback should never delete
    // YAML rows that PG happens not to know about.
    const parsed = parseYaml(result.yamlAfter) as Array<{
      stakeholders?: Array<{ name: string }>;
    }>;
    expect(parsed[0].stakeholders).toHaveLength(2);
  });

  it("ignores non-policy entities", async () => {
    const yamlIn = `- id: some-org
  stableId: sid_ZZZZZZ
  type: organization
  title: Acme Corp
- id: example-bill
  stableId: sid_AAAAA01
  type: policy
  title: Example Bill
  stakeholders:
    - name: Old Stakeholder
      position: support
`;
    const result = await exportPolicyStakeholdersToYaml({
      yamlInput: yamlIn,
      rows: PG_ROWS_FOR_EXAMPLE,
      dryRun: true,
    });
    expect(result.policiesUpdated).toBe(1);
    const parsed = parseYaml(result.yamlAfter) as Array<{ id: string; type: string }>;
    expect(parsed[0].id).toBe("some-org");
    expect(parsed[0].type).toBe("organization");
    // The org was not touched.
    expect((parsed[0] as Record<string, unknown>).stakeholders).toBeUndefined();
  });
});
