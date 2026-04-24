import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadAssessmentsFile,
  loadAllAssessments,
  assessmentIdFor,
  VALID_ASSESSORS,
} from "./sync-entity-assessments.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "entity-assessments-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeFile(name: string, contents: string): string {
  const p = join(tmp, name);
  writeFileSync(p, contents);
  return p;
}

describe("assessmentIdFor", () => {
  it("produces a deterministic 10-char ID", () => {
    const id = assessmentIdFor("sid_abc1234567", "mission-alignment", "editorial");
    expect(id).toHaveLength(10);
    expect(
      assessmentIdFor("sid_abc1234567", "mission-alignment", "editorial"),
    ).toBe(id);
  });

  it("produces different IDs for different inputs", () => {
    const a = assessmentIdFor("sid_abc1234567", "mission-alignment", "editorial");
    const b = assessmentIdFor("sid_abc1234567", "technical-capabilities", "editorial");
    const c = assessmentIdFor("sid_xyz9876543", "mission-alignment", "editorial");
    const d = assessmentIdFor("sid_abc1234567", "mission-alignment", "llm");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it("matches the server-side natural key (entityId, dimension, assessor)", () => {
    // Editing rating does not change the ID — this is intentional so the
    // sync is an upsert that matches uq_entity_assessment_natural_key.
    const id1 = assessmentIdFor("sid_abc1234567", "speed", "editorial");
    const id2 = assessmentIdFor("sid_abc1234567", "speed", "editorial");
    expect(id1).toBe(id2);
  });
});

describe("loadAssessmentsFile", () => {
  const validYaml = `
entityId: sid_abc1234567
entityDisplayName: Test Org
assessments:
  - dimension: mission-alignment
    rating: Public benefit corp
    evidence: Board structure with safety governance
    assessor: editorial
    source: https://example.com
  - dimension: research-output
    rating: High
`;

  it("parses a valid file", () => {
    const f = writeFile("test.yaml", validYaml);
    const assessments = loadAssessmentsFile(f);
    expect(assessments).toHaveLength(2);
    expect(assessments[0]).toMatchObject({
      entityId: "sid_abc1234567",
      entityDisplayName: "Test Org",
      dimension: "mission-alignment",
      rating: "Public benefit corp",
      evidence: "Board structure with safety governance",
      assessor: "editorial",
      source: "https://example.com",
      notes: null,
      assessedAt: null,
    });
    expect(assessments[0].id).toHaveLength(10);
  });

  it("defaults assessor to editorial and other fields to null when absent", () => {
    const f = writeFile("t.yaml", validYaml);
    const assessments = loadAssessmentsFile(f);
    expect(assessments[1].assessor).toBe("editorial");
    expect(assessments[1].evidence).toBeNull();
    expect(assessments[1].source).toBeNull();
    expect(assessments[1].notes).toBeNull();
    expect(assessments[1].assessedAt).toBeNull();
  });

  it("produces deterministic IDs across calls", () => {
    const f = writeFile("t.yaml", validYaml);
    const a = loadAssessmentsFile(f);
    const b = loadAssessmentsFile(f);
    expect(a[0].id).toBe(b[0].id);
    expect(a[1].id).toBe(b[1].id);
  });

  it("accepts YYYY-MM-DD for assessedAt", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
assessments:
  - { dimension: speed, rating: Fast, assessedAt: "2026-04-24" }
`,
    );
    const assessments = loadAssessmentsFile(f);
    expect(assessments[0].assessedAt).toBe("2026-04-24");
  });

  it("rejects non-YYYY-MM-DD assessedAt values", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
assessments:
  - { dimension: speed, rating: Fast, assessedAt: "2026-04" }
`,
    );
    expect(() => loadAssessmentsFile(f)).toThrow(/assessedAt/);
  });

  it("rejects non-kebab-case dimensions", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
assessments:
  - { dimension: "Mission Alignment", rating: Good }
`,
    );
    expect(() => loadAssessmentsFile(f)).toThrow(/dimension.*kebab-case/);
  });

  it("rejects unknown assessors", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
assessments:
  - { dimension: speed, rating: Fast, assessor: bogus }
`,
    );
    expect(() => loadAssessmentsFile(f)).toThrow(/assessor/);
  });

  it("rejects empty rating", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
assessments:
  - { dimension: speed, rating: "" }
`,
    );
    expect(() => loadAssessmentsFile(f)).toThrow(/rating/);
  });

  it("rejects missing entityId", () => {
    const f = writeFile(
      "t.yaml",
      `
assessments:
  - { dimension: speed, rating: Fast }
`,
    );
    expect(() => loadAssessmentsFile(f)).toThrow(/entityId/);
  });

  it("rejects assessments that is not an array", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
assessments: "oops"
`,
    );
    expect(() => loadAssessmentsFile(f)).toThrow(/assessments.*array/);
  });

  it("rejects non-object top-level YAML", () => {
    const f = writeFile("t.yaml", `- foo`);
    expect(() => loadAssessmentsFile(f)).toThrow(/object/);
  });

  it("rejects duplicate (dimension, assessor) within a single file", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
assessments:
  - { dimension: speed, rating: Fast }
  - { dimension: speed, rating: Slow }
`,
    );
    expect(() => loadAssessmentsFile(f)).toThrow(/duplicate/i);
  });

  it("allows the same dimension across different assessors", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
assessments:
  - { dimension: speed, rating: Fast, assessor: editorial }
  - { dimension: speed, rating: Slow, assessor: llm }
`,
    );
    const assessments = loadAssessmentsFile(f);
    expect(assessments).toHaveLength(2);
    expect(assessments[0].id).not.toBe(assessments[1].id);
  });

  it("includes the file path in error messages", () => {
    const f = writeFile(
      "broken.yaml",
      `
entityId: sid_abc1234567
assessments:
  - { dimension: "Bad Dimension", rating: X }
`,
    );
    expect(() => loadAssessmentsFile(f)).toThrow(/broken\.yaml/);
  });

  it("accepts every documented assessor", () => {
    for (const s of VALID_ASSESSORS) {
      const f = writeFile(
        `${s}.yaml`,
        `
entityId: sid_abc1234567
assessments:
  - { dimension: speed, rating: X, assessor: ${s} }
`,
      );
      expect(loadAssessmentsFile(f)[0].assessor).toBe(s);
    }
  });
});

describe("loadAllAssessments", () => {
  it("returns empty when directory does not exist", () => {
    const result = loadAllAssessments(join(tmp, "missing"));
    expect(result.assessments).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it("aggregates assessments across multiple files", () => {
    writeFile(
      "a.yaml",
      `
entityId: sid_aaaaaaa111
assessments:
  - { dimension: speed, rating: Fast }
  - { dimension: transparency, rating: High }
`,
    );
    writeFile(
      "b.yaml",
      `
entityId: sid_bbbbbbb222
assessments:
  - { dimension: speed, rating: Slow }
`,
    );
    const result = loadAllAssessments(tmp);
    expect(result.files).toEqual(["a.yaml", "b.yaml"]);
    expect(result.assessments).toHaveLength(3);
    expect(result.assessments.map((a) => a.entityId).sort()).toEqual([
      "sid_aaaaaaa111",
      "sid_aaaaaaa111",
      "sid_bbbbbbb222",
    ]);
  });

  it("ignores non-yaml files", () => {
    writeFile("notes.md", "hello");
    writeFile(
      "c.yaml",
      `
entityId: sid_ccccccc333
assessments:
  - { dimension: speed, rating: Fast }
`,
    );
    const result = loadAllAssessments(tmp);
    expect(result.files).toEqual(["c.yaml"]);
    expect(result.assessments).toHaveLength(1);
  });

  it("throws on duplicate IDs across files", () => {
    writeFile(
      "a.yaml",
      `
entityId: sid_dupdupdup1
assessments:
  - { dimension: speed, rating: Fast }
`,
    );
    writeFile(
      "b.yaml",
      `
entityId: sid_dupdupdup1
assessments:
  - { dimension: speed, rating: Slow }
`,
    );
    expect(() => loadAllAssessments(tmp)).toThrow(/Duplicate assessment ID/);
  });

  it("propagates per-file validation errors", () => {
    writeFile(
      "bad.yaml",
      `
entityId: sid_eeeeeeee44
assessments:
  - { dimension: "Bad Dim", rating: X }
`,
    );
    expect(() => loadAllAssessments(tmp)).toThrow(/bad\.yaml/);
  });

  it("loads .yml as well as .yaml", () => {
    writeFile(
      "x.yml",
      `
entityId: sid_yyyyyyy777
assessments:
  - { dimension: speed, rating: Fast }
`,
    );
    const result = loadAllAssessments(tmp);
    expect(result.files).toEqual(["x.yml"]);
    expect(result.assessments).toHaveLength(1);
  });
});
