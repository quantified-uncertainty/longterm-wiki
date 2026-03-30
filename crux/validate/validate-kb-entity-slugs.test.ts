/**
 * Tests for KB entity slug validator.
 *
 * Tests both the core validation logic (unit tests with fixture data)
 * and the CLI (subprocess integration tests against real data).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  loadEntityRegistry,
  scanFactbaseRefs,
  extractRefValues,
  fixMissingEntities,
  validateKbEntitySlugs,
} from "./validate-kb-entity-slugs.ts";

const REPO_ROOT = `${__dirname}/../..`;

function createFixtureDir(): {
  root: string;
  entitiesDir: string;
  thingsDir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "kb-entity-slugs-test-"));
  const entitiesDir = join(root, "data", "entities");
  const thingsDir = join(root, "packages", "factbase", "data", "things");
  mkdirSync(entitiesDir, { recursive: true });
  mkdirSync(thingsDir, { recursive: true });

  return {
    root,
    entitiesDir,
    thingsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Unit tests: loadEntityRegistry
// ---------------------------------------------------------------------------

describe("loadEntityRegistry", () => {
  let fixture: ReturnType<typeof createFixtureDir>;

  beforeEach(() => { fixture = createFixtureDir(); });
  afterEach(() => { fixture.cleanup(); });

  it("loads stableIds from YAML entity files", () => {
    writeFileSync(
      join(fixture.entitiesDir, "orgs.yaml"),
      "- id: anthropic\n  stableId: sid_mK9pX3rQ7n\n  type: organization\n  title: Anthropic\n- id: openai\n  stableId: sid_zR4nW8xB2f\n  type: organization\n  title: OpenAI\n"
    );

    const registry = loadEntityRegistry(fixture.entitiesDir);
    expect(registry.stableIds.size).toBe(2);
    expect(registry.stableIds.has("sid_mK9pX3rQ7n")).toBe(true);
    expect(registry.stableIds.has("sid_zR4nW8xB2f")).toBe(true);
    expect(registry.slugToStableId.get("anthropic")).toBe("sid_mK9pX3rQ7n");
    expect(registry.stableIdToSlug.get("sid_mK9pX3rQ7n")).toBe("anthropic");
  });

  it("returns empty sets for missing directory", () => {
    const registry = loadEntityRegistry("/nonexistent/path");
    expect(registry.stableIds.size).toBe(0);
    expect(registry.slugToStableId.size).toBe(0);
  });

  it("handles empty YAML files gracefully", () => {
    writeFileSync(join(fixture.entitiesDir, "empty.yaml"), "");
    const registry = loadEntityRegistry(fixture.entitiesDir);
    expect(registry.stableIds.size).toBe(0);
  });

  it("handles malformed YAML gracefully", () => {
    writeFileSync(join(fixture.entitiesDir, "bad.yaml"), "{ invalid: yaml: content");
    const registry = loadEntityRegistry(fixture.entitiesDir);
    expect(registry.stableIds.size).toBe(0);
  });

  it("handles entities without stableId", () => {
    writeFileSync(
      join(fixture.entitiesDir, "minimal.yaml"),
      "- id: no-stable\n  type: concept\n  title: No StableId\n"
    );
    const registry = loadEntityRegistry(fixture.entitiesDir);
    expect(registry.stableIds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: extractRefValues
// ---------------------------------------------------------------------------

describe("extractRefValues", () => {
  it("extracts !ref values from YAML content", () => {
    const content = "entity: sid_aBcDeFgHiJ\nfacts:\n  - id: f_emp1234567\n    property: employed-by\n    value: !ref sid_mK9pX3rQ7n\n    asOf: 2021-01\n";
    const refs = extractRefValues(content);
    expect(refs.length).toBe(1);
    expect(refs[0].stableId).toBe("sid_mK9pX3rQ7n");
    expect(refs[0].propertyId).toBe("employed-by");
  });

  it("strips slug hints from !ref tags", () => {
    const content = "entity: sid_aBcDeFgHiJ\nfacts:\n  - id: f_ref1234567\n    property: employed-by\n    value: !ref sid_mK9pX3rQ7n:anthropic\n";
    const refs = extractRefValues(content);
    expect(refs.length).toBe(1);
    expect(refs[0].stableId).toBe("sid_mK9pX3rQ7n");
  });

  it("extracts multiple refs from refs-type facts", () => {
    const content = "entity: sid_aBcDeFgHiJ\nfacts:\n  - id: f_fnd1234567\n    property: founded-by\n    value:\n      - !ref sid_tKMznr07QA\n      - !ref sid_zR4nW8xB2f\n";
    const refs = extractRefValues(content);
    expect(refs.length).toBe(2);
    expect(refs[0].stableId).toBe("sid_tKMznr07QA");
    expect(refs[1].stableId).toBe("sid_zR4nW8xB2f");
  });

  it("ignores non-stableId !ref values", () => {
    const content = "entity: sid_aBcDeFgHiJ\nfacts:\n  - id: f_bad1234567\n    property: employed-by\n    value: !ref short\n";
    const refs = extractRefValues(content);
    expect(refs.length).toBe(0);
  });

  it("returns empty array for content without refs", () => {
    const content = "entity: sid_aBcDeFgHiJ\nfacts:\n  - id: f_txt1234567\n    property: description\n    value: No refs here\n";
    const refs = extractRefValues(content);
    expect(refs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: scanFactbaseRefs
// ---------------------------------------------------------------------------

describe("scanFactbaseRefs", () => {
  let fixture: ReturnType<typeof createFixtureDir>;

  beforeEach(() => { fixture = createFixtureDir(); });
  afterEach(() => { fixture.cleanup(); });

  it("extracts entity stableIds from entity: format", () => {
    writeFileSync(
      join(fixture.thingsDir, "anthropic.yaml"),
      "entity: sid_mK9pX3rQ7n\nfacts:\n  - id: f_abc1234567\n    property: revenue\n    value: 1e9\n"
    );

    const result = scanFactbaseRefs(fixture.thingsDir);
    expect(result.entityStableIds.size).toBe(1);
    expect(result.entityStableIds.has("sid_mK9pX3rQ7n")).toBe(true);
    expect(result.entityStableIds.get("sid_mK9pX3rQ7n")?.slug).toBe("anthropic");
  });

  it("extracts !ref values from facts", () => {
    writeFileSync(
      join(fixture.thingsDir, "dario.yaml"),
      "entity: sid_tKMznr07QA\nfacts:\n  - id: f_emp1234567\n    property: employed-by\n    value: !ref sid_mK9pX3rQ7n\n    asOf: 2021-01\n"
    );

    const result = scanFactbaseRefs(fixture.thingsDir);
    expect(result.totalRefs).toBe(1);
    expect(result.referencedStableIds.has("sid_mK9pX3rQ7n")).toBe(true);
    const refs = result.referencedStableIds.get("sid_mK9pX3rQ7n")!;
    expect(refs.length).toBe(1);
    expect(refs[0].sourceFile).toBe("dario.yaml");
  });

  it("returns empty results for missing directory", () => {
    const result = scanFactbaseRefs("/nonexistent/path");
    expect(result.entityStableIds.size).toBe(0);
    expect(result.totalRefs).toBe(0);
  });

  it("does not extract nested type: values as entity type from entity: format", () => {
    // Real-world pattern: entity: format files have nested `type: range` / `type: number`
    // inside structured fact values. These must NOT be extracted as the entity type.
    writeFileSync(
      join(fixture.thingsDir, "quri.yaml"),
      [
        "entity: sid_xQ1rT2sU3v",
        "facts:",
        "  - id: f_hc1234567a",
        "    property: headcount",
        "    value:",
        "      type: range",
        "      low: 3",
        "      high: 5",
        "    asOf: 2026-03",
        "  - id: f_fr1234567a",
        "    property: funding-received",
        "    value:",
        "      type: number",
        "      value: 650000",
        "      unit: USD",
        "",
      ].join("\n")
    );

    const result = scanFactbaseRefs(fixture.thingsDir);
    expect(result.entityStableIds.size).toBe(1);
    const info = result.entityStableIds.get("sid_xQ1rT2sU3v");
    expect(info).toBeDefined();
    expect(info!.slug).toBe("quri");
    // entity: format should NOT have type extracted from nested value types
    expect(info!.type).toBeUndefined();
    expect(info!.name).toBeUndefined();
  });

  it("extracts name and type from thing: format files", () => {
    writeFileSync(
      join(fixture.thingsDir, "test-thing.yaml"),
      [
        "thing:",
        "  id: aB3cD4eF5g",
        "  slug: test-thing",
        "  type: organization",
        "  name: Test Thing Org",
        "facts:",
        "  - id: f_abc1234567",
        "    property: revenue",
        "    value: 1e6",
        "",
      ].join("\n")
    );

    const result = scanFactbaseRefs(fixture.thingsDir);
    expect(result.entityStableIds.size).toBe(1);
    const info = result.entityStableIds.get("aB3cD4eF5g");
    expect(info).toBeDefined();
    expect(info!.type).toBe("organization");
    expect(info!.name).toBe("Test Thing Org");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: fixMissingEntities
// ---------------------------------------------------------------------------

describe("fixMissingEntities", () => {
  let fixture: ReturnType<typeof createFixtureDir>;

  beforeEach(() => { fixture = createFixtureDir(); });
  afterEach(() => { fixture.cleanup(); });

  it("creates entries in the correct YAML files based on entity type", () => {
    writeFileSync(
      join(fixture.entitiesDir, "people.yaml"),
      "- id: existing-person\n  stableId: ExStBlId01\n  type: person\n  title: Existing Person\n"
    );

    const fixed = fixMissingEntities(fixture.entitiesDir, [
      { stableId: "NewPerson01", slug: "new-person", entityType: "person", name: "New Person" },
    ]);

    expect(fixed).toBe(1);
    const content = readFileSync(join(fixture.entitiesDir, "people.yaml"), "utf-8");
    const parsed = parseYaml(content) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(2);
    expect(parsed[1].stableId).toBe("NewPerson01");
    expect(parsed[1].title).toBe("New Person");
  });

  it("does not duplicate existing entries", () => {
    writeFileSync(
      join(fixture.entitiesDir, "organizations.yaml"),
      "- id: existing-org\n  stableId: sid_ExStBlId02\n  type: organization\n  title: Existing Org\n"
    );

    const fixed = fixMissingEntities(fixture.entitiesDir, [
      { stableId: "sid_ExStBlId02", slug: "existing-org", entityType: "organization", name: "Existing Org" },
    ]);

    expect(fixed).toBe(0);
  });

  it("creates new YAML file when target file does not exist", () => {
    const fixed = fixMissingEntities(fixture.entitiesDir, [
      { stableId: "sid_NewConcpt01", slug: "new-concept", entityType: "concept", name: "New Concept" },
    ]);

    expect(fixed).toBe(1);
    expect(existsSync(join(fixture.entitiesDir, "concepts.yaml"))).toBe(true);
  });

  it("returns 0 when given empty array", () => {
    const fixed = fixMissingEntities(fixture.entitiesDir, []);
    expect(fixed).toBe(0);
  });

  it("preserves YAML comments when appending entries", () => {
    const originalContent =
      "# Organizations Entities\n# Auto-generated\n\n- id: existing-org\n  stableId: sid_ExStBlId02\n  type: organization\n  title: Existing Org\n";
    writeFileSync(join(fixture.entitiesDir, "organizations.yaml"), originalContent);

    fixMissingEntities(fixture.entitiesDir, [
      { stableId: "NewOrgId001", slug: "new-org", entityType: "organization", name: "New Org" },
    ]);

    const result = readFileSync(join(fixture.entitiesDir, "organizations.yaml"), "utf-8");
    // Comments must be preserved
    expect(result).toContain("# Organizations Entities");
    expect(result).toContain("# Auto-generated");
    // Original and new entries must both be present
    expect(result).toContain("ExStBlId02");
    expect(result).toContain("NewOrgId001");
    // Must be valid YAML that parses as an array
    const parsed = parseYaml(result) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: validateKbEntitySlugs (end-to-end with fixtures)
// ---------------------------------------------------------------------------

describe("validateKbEntitySlugs", () => {
  let fixture: ReturnType<typeof createFixtureDir>;

  beforeEach(() => { fixture = createFixtureDir(); });
  afterEach(() => { fixture.cleanup(); });

  it("reports no missing when all refs have registry entries", () => {
    writeFileSync(
      join(fixture.entitiesDir, "orgs.yaml"),
      "- id: anthropic\n  stableId: sid_mK9pX3rQ7n\n  type: organization\n  title: Anthropic\n"
    );
    writeFileSync(
      join(fixture.entitiesDir, "people.yaml"),
      "- id: person\n  stableId: sid_aBcDeFgHiJ\n  type: person\n  title: A Person\n"
    );
    writeFileSync(
      join(fixture.thingsDir, "person.yaml"),
      "entity: sid_aBcDeFgHiJ\nfacts:\n  - id: f_emp1234567\n    property: employed-by\n    value: !ref sid_mK9pX3rQ7n\n"
    );

    const result = validateKbEntitySlugs(fixture.entitiesDir, fixture.thingsDir, false);
    expect(result.uniqueMissing.size).toBe(0);
    expect(result.stats.missingCount).toBe(0);
    expect(result.stats.totalRefsChecked).toBe(1);
  });

  it("reports missing when ref target has no registry entry", () => {
    writeFileSync(join(fixture.entitiesDir, "orgs.yaml"), "[]");
    writeFileSync(
      join(fixture.thingsDir, "person.yaml"),
      "entity: sid_aBcDeFgHiJ\nfacts:\n  - id: f_emp1234567\n    property: employed-by\n    value: !ref sid_mK9pX3rQ7n\n"
    );

    const result = validateKbEntitySlugs(fixture.entitiesDir, fixture.thingsDir, false);
    expect(result.uniqueMissing.size).toBe(2);
    expect(result.uniqueMissing.has("sid_mK9pX3rQ7n")).toBe(true);
    expect(result.uniqueMissing.has("sid_aBcDeFgHiJ")).toBe(true);
  });

  it("fixes missing entries with --fix mode (thing: format)", () => {
    writeFileSync(
      join(fixture.thingsDir, "test-org.yaml"),
      "thing:\n  id: TestOrg001\n  slug: test-org\n  type: organization\n  name: Test Organization\nfacts:\n  - id: f_rev1234567\n    property: revenue\n    value: 1e6\n"
    );

    const result = validateKbEntitySlugs(fixture.entitiesDir, fixture.thingsDir, true);
    expect(result.stats.fixedCount).toBe(1);
    expect(existsSync(join(fixture.entitiesDir, "organizations.yaml"))).toBe(true);

    // Verify the created entry has correct type from thing: format
    const content = readFileSync(join(fixture.entitiesDir, "organizations.yaml"), "utf-8");
    const parsed = parseYaml(content) as Array<Record<string, unknown>>;
    expect(parsed[0].type).toBe("organization");
  });

  it("fixes missing entries with --fix mode (entity: format)", () => {
    writeFileSync(
      join(fixture.thingsDir, "test-entity.yaml"),
      "entity: sid_TestEnt001\nfacts:\n  - id: f_rev1234567\n    property: revenue\n    value: 1e6\n"
    );

    const result = validateKbEntitySlugs(fixture.entitiesDir, fixture.thingsDir, true);
    expect(result.stats.fixedCount).toBe(1);
    // entity: format has no type metadata, so it defaults to "concept"
    const entry = result.uniqueMissing.get("sid_TestEnt001");
    expect(entry).toBeDefined();
    expect(entry!.entityType).toBe("concept");
  });

  it("does not misidentify nested type: values as entity type", () => {
    // entity: format file with nested `type: range` in fact values
    writeFileSync(
      join(fixture.entitiesDir, "orgs.yaml"),
      "- id: test-org\n  stableId: sid_xQ1rT2sU3v\n  type: organization\n  title: Test Org\n"
    );
    writeFileSync(
      join(fixture.thingsDir, "test-org.yaml"),
      [
        "entity: sid_xQ1rT2sU3v",
        "facts:",
        "  - id: f_hc1234567a",
        "    property: headcount",
        "    value:",
        "      type: range",
        "      low: 3",
        "      high: 5",
        "  - id: f_emp1234567",
        "    property: employed-by",
        "    value: !ref sid_MissngRef0",
        "",
      ].join("\n")
    );

    const result = validateKbEntitySlugs(fixture.entitiesDir, fixture.thingsDir, false);
    // sid_xQ1rT2sU3v is in registry, so only sid_MissngRef0 should be missing
    expect(result.uniqueMissing.size).toBe(1);
    expect(result.uniqueMissing.has("sid_MissngRef0")).toBe(true);
    // The missing ref should NOT have type "range" from the nested value
    const missing = result.uniqueMissing.get("sid_MissngRef0")!;
    expect(missing.entityType).not.toBe("range");
    // It should default to "concept" since entity: format has no type metadata
    expect(missing.entityType).toBe("concept");
  });
});

// ---------------------------------------------------------------------------
// Integration tests: CLI subprocess
// ---------------------------------------------------------------------------

function run(cmd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`${cmd} 2>&1`, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 60_000,
    });
    return { stdout, exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout || "", exitCode: err.status ?? 1 };
  }
}

describe("validate-kb-entity-slugs CLI", () => {
  it(
    "runs successfully in report mode (exit 0 when all refs resolve)",
    () => {
      const result = run("npx tsx crux/validate/validate-kb-entity-slugs.ts");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("KB Entity Slug Validation");
      expect(result.stdout).toContain("FactBase entities:");
    },
    60_000
  );

  it(
    "produces valid JSON in --ci mode",
    () => {
      const result = run("npx tsx crux/validate/validate-kb-entity-slugs.ts --ci");
      expect(result.exitCode).toBe(0);

      const jsonLines = result.stdout.split("\n").filter((l) => l.startsWith("{"));
      expect(jsonLines.length).toBeGreaterThanOrEqual(1);

      const data = JSON.parse(jsonLines[jsonLines.length - 1]);
      expect(data).toHaveProperty("passed", true);
      expect(data).toHaveProperty("totalFactbaseEntities");
      expect(data).toHaveProperty("totalRefsChecked");
      expect(typeof data.totalFactbaseEntities).toBe("number");
      expect(data.totalFactbaseEntities).toBeGreaterThan(0);
      expect(data.totalRefsChecked).toBeGreaterThan(0);
    },
    60_000
  );
});
