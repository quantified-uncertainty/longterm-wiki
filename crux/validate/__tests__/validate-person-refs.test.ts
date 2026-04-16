import { describe, it, expect } from "vitest";
import { validatePersonRefs } from "../validate-person-refs.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTempDirs() {
  const base = mkdtempSync(join(tmpdir(), "person-refs-test-"));
  const thingsDir = join(base, "fb-entities");
  const entitiesDir = join(base, "entities");
  mkdirSync(thingsDir);
  mkdirSync(entitiesDir);
  return { thingsDir, entitiesDir };
}

function writeEntities(
  entitiesDir: string,
  entities: Array<{ id: string; stableId: string; type: string; title: string }>,
) {
  const yaml = entities
    .map(
      (e) =>
        `- id: ${e.id}\n  stableId: ${e.stableId}\n  type: ${e.type}\n  title: ${e.title}`,
    )
    .join("\n");
  writeFileSync(join(entitiesDir, "people.yaml"), yaml);
}

function writeFactFile(thingsDir: string, filename: string, content: string) {
  writeFileSync(join(thingsDir, filename), content);
}

describe("validate-person-refs", () => {
  it("passes when all !ref person targets resolve with names", () => {
    const { thingsDir, entitiesDir } = makeTempDirs();

    writeEntities(entitiesDir, [
      { id: "alice-smith", stableId: "sid_AAAAAAAAAA", type: "person", title: "Alice Smith" },
    ]);

    writeFactFile(
      thingsDir,
      "acme-corp.yaml",
      `entity: sid_BBBBBBBBBB
facts:
  - id: f_test001
    property: founded-by
    value:
      - !ref sid_AAAAAAAAAA
`,
    );

    const result = validatePersonRefs(thingsDir, entitiesDir);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.totalRefValues).toBe(1);
  });

  it("errors when !ref target is missing from entity registry", () => {
    const { thingsDir, entitiesDir } = makeTempDirs();

    // No entity entries at all
    writeFileSync(join(entitiesDir, "people.yaml"), "[]");

    writeFactFile(
      thingsDir,
      "acme-corp.yaml",
      `entity: sid_BBBBBBBBBB
facts:
  - id: f_test002
    property: founded-by
    value:
      - !ref sid_CCCCCCCCCC
`,
    );

    const result = validatePersonRefs(thingsDir, entitiesDir);
    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe("unresolved-ref");
    expect(result.errors[0].value).toBe("sid_CCCCCCCCCC");
  });

  it("errors when entity exists but has no displayable name", () => {
    const { thingsDir, entitiesDir } = makeTempDirs();

    writeEntities(entitiesDir, [
      { id: "mystery-person", stableId: "sid_DDDDDDDDDD", type: "person", title: "Unknown" },
    ]);

    writeFactFile(
      thingsDir,
      "acme-corp.yaml",
      `entity: sid_BBBBBBBBBB
facts:
  - id: f_test003
    property: key-person
    value:
      - !ref sid_DDDDDDDDDD
`,
    );

    const result = validatePersonRefs(thingsDir, entitiesDir);
    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe("no-displayable-name");
  });

  it("warns on text-based person values (not using !ref)", () => {
    const { thingsDir, entitiesDir } = makeTempDirs();

    writeFileSync(join(entitiesDir, "people.yaml"), "[]");

    writeFactFile(
      thingsDir,
      "acme-corp.yaml",
      `entity: sid_BBBBBBBBBB
facts:
  - id: f_test004
    property: ceo
    value: "Jane Doe"
`,
    );

    const result = validatePersonRefs(thingsDir, entitiesDir);
    expect(result.passed).toBe(true); // Warnings don't block
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].kind).toBe("text-person-ref");
    expect(result.warnings[0].value).toBe("Jane Doe");
    expect(result.stats.totalTextValues).toBe(1);
  });

  it("ignores non-person properties", () => {
    const { thingsDir, entitiesDir } = makeTempDirs();

    writeFileSync(join(entitiesDir, "people.yaml"), "[]");

    writeFactFile(
      thingsDir,
      "acme-corp.yaml",
      `entity: sid_BBBBBBBBBB
facts:
  - id: f_test005
    property: headquarters
    value: "New York, NY"
`,
    );

    const result = validatePersonRefs(thingsDir, entitiesDir);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.stats.totalPersonFacts).toBe(0);
  });

  it("handles multiple refs in a single fact", () => {
    const { thingsDir, entitiesDir } = makeTempDirs();

    writeEntities(entitiesDir, [
      { id: "alice", stableId: "sid_AAAAAAAAAA", type: "person", title: "Alice" },
      { id: "bob", stableId: "sid_EEEEEEEEEE", type: "person", title: "Bob" },
    ]);

    writeFactFile(
      thingsDir,
      "acme-corp.yaml",
      `entity: sid_BBBBBBBBBB
facts:
  - id: f_test006
    property: founded-by
    value:
      - !ref sid_AAAAAAAAAA
      - !ref sid_EEEEEEEEEE
`,
    );

    const result = validatePersonRefs(thingsDir, entitiesDir);
    expect(result.passed).toBe(true);
    expect(result.stats.totalRefValues).toBe(2);
  });

  it("handles empty things directory gracefully", () => {
    const { thingsDir, entitiesDir } = makeTempDirs();
    writeFileSync(join(entitiesDir, "people.yaml"), "[]");

    const result = validatePersonRefs(thingsDir, entitiesDir);
    expect(result.passed).toBe(true);
    expect(result.stats.totalFactbaseFiles).toBe(0);
  });
});
