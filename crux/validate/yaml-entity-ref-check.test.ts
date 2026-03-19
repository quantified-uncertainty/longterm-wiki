import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateYamlEntityRefs,
  loadEntitySlugs,
  loadExpertSlugs,
  loadOrgSlugs,
} from "./yaml-entity-ref-check.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "yaml-entity-ref-test-"));
  mkdirSync(join(dir, "data", "entities"), { recursive: true });
  return dir;
}

function writeYaml(dir: string, relativePath: string, content: string): void {
  const fullPath = join(dir, relativePath);
  writeFileSync(fullPath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// loadEntitySlugs
// ---------------------------------------------------------------------------

describe("loadEntitySlugs", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "entity-slugs-test-"));
    mkdirSync(join(tempDir, "entities"), { recursive: true });

    writeFileSync(
      join(tempDir, "entities", "orgs.yaml"),
      `
- id: anthropic
  type: organization
  title: Anthropic
- id: openai
  type: organization
  title: OpenAI
`,
      "utf-8"
    );

    writeFileSync(
      join(tempDir, "entities", "people.yaml"),
      `
- id: dario-amodei
  type: person
  title: Dario Amodei
`,
      "utf-8"
    );
  });

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  it("loads slugs from multiple YAML files", () => {
    const slugs = loadEntitySlugs(join(tempDir, "entities"));
    expect(slugs.size).toBe(3);
    expect(slugs.has("anthropic")).toBe(true);
    expect(slugs.has("openai")).toBe(true);
    expect(slugs.has("dario-amodei")).toBe(true);
  });

  it("returns empty set for non-existent directory", () => {
    const slugs = loadEntitySlugs("/nonexistent/path");
    expect(slugs.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadExpertSlugs
// ---------------------------------------------------------------------------

describe("loadExpertSlugs", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "expert-slugs-test-"));
    writeFileSync(
      join(tempDir, "experts.yaml"),
      `
- id: alice
  name: Alice
  affiliation: acme
- id: bob
  name: Bob
`,
      "utf-8"
    );
  });

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  it("loads expert slugs", () => {
    const slugs = loadExpertSlugs(join(tempDir, "experts.yaml"));
    expect(slugs.size).toBe(2);
    expect(slugs.has("alice")).toBe(true);
    expect(slugs.has("bob")).toBe(true);
  });

  it("returns empty set for missing file", () => {
    const slugs = loadExpertSlugs("/nonexistent/experts.yaml");
    expect(slugs.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadOrgSlugs
// ---------------------------------------------------------------------------

describe("loadOrgSlugs", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "org-slugs-test-"));
    writeFileSync(
      join(tempDir, "organizations.yaml"),
      `
- id: acme-corp
  name: ACME Corp
- id: widget-inc
  name: Widget Inc
`,
      "utf-8"
    );
  });

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  it("loads organization slugs", () => {
    const slugs = loadOrgSlugs(join(tempDir, "organizations.yaml"));
    expect(slugs.size).toBe(2);
    expect(slugs.has("acme-corp")).toBe(true);
    expect(slugs.has("widget-inc")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateYamlEntityRefs — core validation
// ---------------------------------------------------------------------------

describe("validateYamlEntityRefs", () => {
  describe("valid references (no errors)", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();

      writeYaml(
        tempDir,
        "data/entities/orgs.yaml",
        `
- id: anthropic
  type: organization
  title: Anthropic
  relatedEntries:
    - id: dario-amodei
      type: person
- id: openai
  type: organization
  title: OpenAI
`
      );

      writeYaml(
        tempDir,
        "data/entities/people.yaml",
        `
- id: dario-amodei
  type: person
  title: Dario Amodei
  relatedEntries:
    - id: anthropic
      type: organization
`
      );

      writeYaml(
        tempDir,
        "data/entities/models.yaml",
        `
- id: claude-3
  type: ai-model
  title: Claude 3
  developer: anthropic
`
      );

      writeYaml(
        tempDir,
        "data/experts.yaml",
        `
- id: dario-amodei
  name: Dario Amodei
  affiliation: anthropic
`
      );

      writeYaml(
        tempDir,
        "data/organizations.yaml",
        `
- id: anthropic
  name: Anthropic
  keyPeople:
    - dario-amodei
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("reports no errors when all references are valid", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      expect(errors).toHaveLength(0);
    });

    it("counts references correctly", () => {
      const result = validateYamlEntityRefs(tempDir);
      // relatedEntries: 2 (anthropic->dario, dario->anthropic)
      // developer: 1 (claude-3->anthropic)
      // affiliation: 1 (dario->anthropic)
      // keyPeople: 1 (anthropic->dario)
      expect(result.stats.totalRefsChecked).toBe(5);
      expect(result.stats.validRefs).toBe(5);
    });
  });

  describe("dangling relatedEntries reference", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/orgs.yaml",
        `
- id: anthropic
  type: organization
  title: Anthropic
  relatedEntries:
    - id: nonexistent-person
      type: person
    - id: anthropic
      type: organization
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("detects dangling relatedEntries reference", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].refValue).toBe("nonexistent-person");
      expect(errors[0].fieldName).toBe("relatedEntries[].id");
      expect(errors[0].sourceId).toBe("anthropic");
      expect(errors[0].expectedType).toBe("person");
    });
  });

  describe("dangling developer reference", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/models.yaml",
        `
- id: gpt-5
  type: ai-model
  title: GPT-5
  developer: nonexistent-lab
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("detects dangling developer reference", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].refValue).toBe("nonexistent-lab");
      expect(errors[0].fieldName).toBe("developer");
      expect(errors[0].expectedType).toBe("organization");
    });
  });

  describe("dangling organization reference", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/projects.yaml",
        `
- id: squiggle
  type: project
  title: Squiggle
  organization: nonexistent-org
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("detects dangling organization reference", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].refValue).toBe("nonexistent-org");
      expect(errors[0].fieldName).toBe("organization");
    });
  });

  describe("dangling parentOrg reference", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/orgs.yaml",
        `
- id: some-division
  type: organization
  title: Some Division
  parentOrg: nonexistent-parent
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("detects dangling parentOrg reference", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].refValue).toBe("nonexistent-parent");
      expect(errors[0].fieldName).toBe("parentOrg");
    });
  });

  describe("dangling expert affiliation reference", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/orgs.yaml",
        `
- id: real-org
  type: organization
  title: Real Org
`
      );
      writeYaml(
        tempDir,
        "data/experts.yaml",
        `
- id: alice
  name: Alice
  affiliation: forethought
- id: bob
  name: Bob
  affiliation: real-org
- id: charlie
  name: Charlie
  affiliation: independent
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("detects dangling affiliation but skips 'independent'", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].refValue).toBe("forethought");
      expect(errors[0].fieldName).toBe("affiliation");
      expect(errors[0].sourceId).toBe("alice");
    });
  });

  describe("dangling keyPeople reference in organizations.yaml", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/people.yaml",
        `
- id: real-person
  type: person
  title: Real Person
`
      );
      writeYaml(
        tempDir,
        "data/organizations.yaml",
        `
- id: acme
  name: ACME
  keyPeople:
    - real-person
    - ghost-person
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("detects dangling keyPeople reference", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].refValue).toBe("ghost-person");
      expect(errors[0].fieldName).toBe("keyPeople[]");
      expect(errors[0].expectedType).toBe("person");
    });
  });

  describe("summaryPage is a warning, not an error", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/orgs.yaml",
        `
- id: anthropic
  type: organization
  title: Anthropic
  summaryPage: labs-overview
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("reports summaryPage as warning, not error", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      const warnings = result.danglingRefs.filter(
        (r) => r.severity === "warning"
      );
      expect(errors).toHaveLength(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].fieldName).toBe("summaryPage");
    });
  });

  describe("cross-file references resolve", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();

      // Entity in entities YAML
      writeYaml(
        tempDir,
        "data/entities/orgs.yaml",
        `
- id: anthropic
  type: organization
  title: Anthropic
`
      );

      // Expert references entity via affiliation
      writeYaml(
        tempDir,
        "data/experts.yaml",
        `
- id: dario
  name: Dario
  affiliation: anthropic
`
      );

      // Organization references expert in keyPeople
      writeYaml(
        tempDir,
        "data/organizations.yaml",
        `
- id: anthropic
  name: Anthropic
  keyPeople:
    - dario
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("resolves cross-file references without errors", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      expect(errors).toHaveLength(0);
    });
  });

  describe("empty and malformed inputs", () => {
    it("handles empty entities directory", () => {
      const tempDir = createTempProject();
      // No YAML files written — just empty directories
      const result = validateYamlEntityRefs(tempDir);
      expect(result.stats.totalEntities).toBe(0);
      expect(result.stats.totalRefsChecked).toBe(0);
      expect(result.danglingRefs).toHaveLength(0);
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("handles malformed YAML gracefully", () => {
      const tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/bad.yaml",
        `
this is not: valid: yaml: [[[
`
      );
      // Should not throw, should just skip the malformed file
      const result = validateYamlEntityRefs(tempDir);
      expect(result.stats.totalEntities).toBe(0);
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("handles entities with missing id fields", () => {
      const tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/no-id.yaml",
        `
- title: No ID Entity
  type: organization
- id: has-id
  title: Has ID
  type: organization
`
      );
      const result = validateYamlEntityRefs(tempDir);
      // Only the entity with id should be counted
      expect(result.stats.totalEntities).toBe(1);
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("handles null entities in arrays", () => {
      const tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/nulls.yaml",
        `
- id: real
  type: organization
  title: Real
-
- id: also-real
  type: person
  title: Also Real
`
      );
      const result = validateYamlEntityRefs(tempDir);
      expect(result.stats.totalEntities).toBe(2);
      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("dangling stakeholders[].entityId reference", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/orgs.yaml",
        `
- id: real-org
  type: organization
  title: Real Org
`
      );
      writeYaml(
        tempDir,
        "data/entities/responses.yaml",
        `
- id: sb-1047
  type: policy
  title: SB 1047
  stakeholders:
    - name: Real Org
      entityId: real-org
      position: support
    - name: Ghost Org
      entityId: ghost-org
      position: oppose
    - name: No Entity Link
      position: neutral
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("detects dangling stakeholder entityId but ignores entries without entityId", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].refValue).toBe("ghost-org");
      expect(errors[0].fieldName).toBe("stakeholders[].entityId");
      expect(errors[0].sourceId).toBe("sb-1047");
    });

    it("counts valid stakeholder entityId references", () => {
      const result = validateYamlEntityRefs(tempDir);
      // relatedEntries: 0, developer: 0, stakeholders: 2 (real-org valid, ghost-org dangling)
      // The "No Entity Link" entry has no entityId so it's not checked
      expect(result.stats.totalRefsChecked).toBe(2);
      expect(result.stats.validRefs).toBe(1);
    });
  });

  describe("dangling keyPoliticians[].entityId reference", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/people.yaml",
        `
- id: scott-wiener
  type: person
  title: Scott Wiener
`
      );
      writeYaml(
        tempDir,
        "data/entities/responses.yaml",
        `
- id: sb-1047
  type: policy
  title: SB 1047
  keyPoliticians:
    - name: Senator Scott Wiener
      entityId: scott-wiener
      role: Primary Author
    - name: Governor Unknown
      entityId: nonexistent-politician
      role: Vetoed
    - name: Senator No Link
      role: Co-author
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("detects dangling keyPoliticians entityId", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].refValue).toBe("nonexistent-politician");
      expect(errors[0].fieldName).toBe("keyPoliticians[].entityId");
      expect(errors[0].expectedType).toBe("person");
    });
  });

  describe("valid stakeholders and keyPoliticians pass", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();
      writeYaml(
        tempDir,
        "data/entities/orgs.yaml",
        `
- id: anthropic
  type: organization
  title: Anthropic
`
      );
      writeYaml(
        tempDir,
        "data/entities/people.yaml",
        `
- id: gavin-newsom
  type: person
  title: Gavin Newsom
`
      );
      writeYaml(
        tempDir,
        "data/entities/responses.yaml",
        `
- id: sb-1047
  type: policy
  title: SB 1047
  stakeholders:
    - name: Anthropic
      entityId: anthropic
      position: mixed
  keyPoliticians:
    - name: Governor Gavin Newsom
      entityId: gavin-newsom
      role: Vetoed
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("reports no errors when all entityId references are valid", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      expect(errors).toHaveLength(0);
      // 2 entityId checks: anthropic (stakeholder) + gavin-newsom (keyPolitician)
      expect(result.stats.totalRefsChecked).toBe(2);
      expect(result.stats.validRefs).toBe(2);
    });
  });

  describe("multiple errors across files", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = createTempProject();

      writeYaml(
        tempDir,
        "data/entities/orgs.yaml",
        `
- id: real-org
  type: organization
  title: Real Org
  relatedEntries:
    - id: ghost-1
      type: person
    - id: ghost-2
      type: organization
`
      );

      writeYaml(
        tempDir,
        "data/entities/models.yaml",
        `
- id: some-model
  type: ai-model
  title: Some Model
  developer: phantom-lab
`
      );

      writeYaml(
        tempDir,
        "data/experts.yaml",
        `
- id: expert-1
  name: Expert One
  affiliation: vapor-org
`
      );
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it("collects errors from multiple files", () => {
      const result = validateYamlEntityRefs(tempDir);
      const errors = result.danglingRefs.filter((r) => r.severity === "error");
      expect(errors.length).toBeGreaterThanOrEqual(4);
      // Should have refs from entity files AND experts file
      const fileNames = [...new Set(errors.map((r) => r.sourceFile))];
      expect(fileNames).toContain("data/entities/orgs.yaml");
      expect(fileNames).toContain("data/entities/models.yaml");
      expect(fileNames).toContain("data/experts.yaml");
    });
  });
});
