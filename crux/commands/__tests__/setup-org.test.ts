// Tests for `crux tb setup-org`.

import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  buildDivisionRows,
  buildEntityRecord,
  buildFactBaseDoc,
  buildFundingProgramRows,
  formatDivisionsSnippet,
  formatFundingProgramsSnippet,
  formatReport,
  parseConfig,
  planFiles,
  runSetupOrg,
  type SetupOrgConfig,
} from "../setup-org.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

const FULL_CONFIG_YAML = `
slug: aria
name: Advanced Research and Innovation Agency
type: organization
aliases:
  - ARIA
website: https://aria.org.uk
description: UK government R&D funding agency
orgType: government-agency
tags:
  - funder
  - government
relatedEntries:
  - id: sid_xxxxxxxxxx
    type: person
    relationship: leads-to
divisions:
  - name: Programmable Plants
    divisionType: program-area
    status: active
    source: https://aria.org.uk/programmes/programmable-plants
  - name: Loneliness
    divisionType: program-area
    status: active
fundingPrograms:
  - name: Programmable Plants RFP
    programType: rfp
    status: open
    totalBudget: 60000000
    currency: GBP
    deadline: Rolling
    divisionSlug: programmable-plants
facts:
  - property: founded-date
    value: "2023"
    source: https://aria.org.uk/about
`;

const MINIMAL_CONFIG_YAML = `
slug: tiny-org
name: Tiny Org
`;

// ── Config validation ─────────────────────────────────────────────────

describe("parseConfig", () => {
  it("accepts a full YAML config", () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    expect(config.slug).toBe("aria");
    expect(config.name).toBe("Advanced Research and Innovation Agency");
    expect(config.aliases).toEqual(["ARIA"]);
    expect(config.divisions).toHaveLength(2);
    expect(config.fundingPrograms).toHaveLength(1);
    expect(config.facts).toHaveLength(1);
  });

  it("accepts a minimal YAML config", () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    expect(config.slug).toBe("tiny-org");
    expect(config.type).toBe("organization"); // default
    expect(config.divisions).toBeUndefined();
  });

  it("accepts a JSON config", () => {
    const config = parseConfig('{"slug":"json-org","name":"JSON Org"}', "json");
    expect(config.slug).toBe("json-org");
    expect(config.name).toBe("JSON Org");
  });

  it("rejects uppercase slug", () => {
    expect(() => parseConfig('{"slug":"BAD_UPPER","name":"x"}', "json")).toThrow(/kebab-case/);
  });

  it("rejects empty name", () => {
    expect(() => parseConfig('{"slug":"x-y","name":""}', "json")).toThrow();
  });

  it("rejects missing slug", () => {
    expect(() => parseConfig('{"name":"x"}', "json")).toThrow();
  });

  it("rejects unknown divisionType enum", () => {
    const yaml = `
slug: ok-slug
name: ok
divisions:
  - name: Bad Type
    divisionType: not-a-real-type
    status: active
`;
    expect(() => parseConfig(yaml, "yaml")).toThrow();
  });

  it("rejects unknown program status enum", () => {
    const yaml = `
slug: ok-slug
name: ok
fundingPrograms:
  - name: Bad
    programType: rfp
    status: maybe
`;
    expect(() => parseConfig(yaml, "yaml")).toThrow();
  });

  it("rejects non-object root", () => {
    expect(() => parseConfig('"just-a-string"', "json")).toThrow(/object/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseConfig("{not valid json", "json")).toThrow();
  });

  it("rejects relatedEntries.id that is neither sid_-prefixed nor kebab-case", () => {
    const yaml = `
slug: ok-slug
name: ok
relatedEntries:
  - id: "Capital_Letters_And_Underscores"
    type: person
`;
    expect(() => parseConfig(yaml, "yaml")).toThrow(/sid_|kebab-case/);
  });

  it("accepts relatedEntries.id in either sid_ or kebab-case form", () => {
    const yaml = `
slug: ok-slug
name: ok
relatedEntries:
  - id: sid_AAAAAAAAAA
    type: person
  - id: dario-amodei
    type: person
`;
    const config = parseConfig(yaml, "yaml");
    expect(config.relatedEntries).toHaveLength(2);
  });
});

// ── Pure builders ──────────────────────────────────────────────────────

describe("buildEntityRecord", () => {
  it("includes only fields present in the config", () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    const record = buildEntityRecord(config, { wikiId: "E1", stableId: "sid_AAAAAAAAAA" });
    expect(record.id).toBe("tiny-org");
    expect(record.wikiId).toBe("E1");
    expect(record.stableId).toBe("sid_AAAAAAAAAA");
    expect(record.title).toBe("Tiny Org");
    expect(record.aliases).toBeUndefined();
    expect(record.website).toBeUndefined();
    expect(record.relatedEntries).toBeUndefined();
  });

  it("propagates aliases, website, description, tags, orgType, relatedEntries", () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const record = buildEntityRecord(config, { wikiId: "E42", stableId: "sid_BBBBBBBBBB" });
    expect(record.orgType).toBe("government-agency");
    expect(record.aliases).toEqual(["ARIA"]);
    expect(record.website).toBe("https://aria.org.uk");
    expect(record.description).toBe("UK government R&D funding agency");
    expect(record.tags).toEqual(["funder", "government"]);
    expect(record.relatedEntries).toEqual([
      { id: "sid_xxxxxxxxxx", type: "person", relationship: "leads-to" },
    ]);
  });

  it("strips undefined relationship from relatedEntries", () => {
    const config = parseConfig(
      `slug: x-y\nname: X\nrelatedEntries:\n  - id: sid_AAAAAAAAAA\n    type: person\n`,
      "yaml",
    );
    const record = buildEntityRecord(config, { wikiId: "E1", stableId: "sid_BBBBBBBBBB" });
    expect(record.relatedEntries).toEqual([{ id: "sid_AAAAAAAAAA", type: "person" }]);
    expect(record.relatedEntries?.[0]).not.toHaveProperty("relationship");
  });
});

describe("buildFactBaseDoc", () => {
  it("returns entity stub with empty facts when no facts provided", () => {
    const doc = buildFactBaseDoc("sid_zzzzzzzzzz", undefined);
    expect(doc.entity).toBe("sid_zzzzzzzzzz");
    expect(doc.facts).toEqual([]);
  });

  it("emits deterministic fact IDs based on stableId+property+asOf", () => {
    const docA = buildFactBaseDoc("sid_zzzzzzzzzz", [
      { property: "founded-date", value: "2023" },
    ]);
    const docB = buildFactBaseDoc("sid_zzzzzzzzzz", [
      { property: "founded-date", value: "2023" },
    ]);
    expect(docA.facts[0]!.id).toBe(docB.facts[0]!.id);
    expect(docA.facts[0]!.id).toMatch(/^f_[A-Za-z0-9]{10}$/);
  });

  it("differentiates facts with different asOf values", () => {
    const doc = buildFactBaseDoc("sid_zzzzzzzzzz", [
      { property: "revenue", value: 100, asOf: "2024" },
      { property: "revenue", value: 200, asOf: "2025" },
    ]);
    expect(doc.facts[0]!.id).not.toBe(doc.facts[1]!.id);
  });

  it("includes optional fields only when set", () => {
    const doc = buildFactBaseDoc("sid_zzzzzzzzzz", [
      { property: "headquarters", value: "London", source: "https://example.org" },
    ]);
    expect(doc.facts[0]).toMatchObject({
      property: "headquarters",
      value: "London",
      source: "https://example.org",
    });
    expect(doc.facts[0]).not.toHaveProperty("notes");
    expect(doc.facts[0]).not.toHaveProperty("asOf");
  });
});

describe("buildDivisionRows", () => {
  it("returns empty array when no divisions in config", () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    expect(buildDivisionRows(config, "sid_AAAAAAAAAA")).toEqual([]);
  });

  it("derives slug from name when not provided", () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const rows = buildDivisionRows(config, "sid_AAAAAAAAAA");
    expect(rows[0]!.idSeed).toBe("div|aria|programmable-plants");
    expect(rows[1]!.idSeed).toBe("div|aria|loneliness");
  });

  it("emits a 10-char alphanumeric id matching the idSeed convention", () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const rows = buildDivisionRows(config, "sid_AAAAAAAAAA");
    for (const row of rows) {
      expect(row.id).toMatch(/^[A-Za-z0-9]{10}$/);
      expect(row.parentOrgId).toBe("sid_AAAAAAAAAA");
    }
  });

  it("rejects duplicate division slugs in the same config", () => {
    const yaml = `
slug: x-y
name: X
divisions:
  - name: Same Name
    divisionType: lab
    status: active
  - name: Same-Name
    divisionType: lab
    status: active
`;
    const config = parseConfig(yaml, "yaml");
    expect(() => buildDivisionRows(config, "sid_AAAAAAAAAA")).toThrow(/duplicate/);
  });
});

describe("buildFundingProgramRows", () => {
  it("links a program to a division by divisionSlug", () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const divisions = buildDivisionRows(config, "sid_AAAAAAAAAA");
    const programs = buildFundingProgramRows(config, "sid_AAAAAAAAAA", divisions);
    expect(programs).toHaveLength(1);
    expect(programs[0]!.divisionId).toBe(divisions[0]!.id);
    expect(programs[0]!.divisionIdSeed).toBe("div|aria|programmable-plants");
  });

  it("throws when divisionSlug references a missing division", () => {
    const yaml = `
slug: x-y
name: X
fundingPrograms:
  - name: Orphan
    programType: rfp
    status: open
    divisionSlug: missing-division
`;
    const config = parseConfig(yaml, "yaml");
    expect(() => buildFundingProgramRows(config, "sid_AAAAAAAAAA", [])).toThrow(/missing-division/);
  });

  it("leaves divisionId null when the program omits divisionSlug", () => {
    const yaml = `
slug: x-y
name: X
fundingPrograms:
  - name: Standalone
    programType: prize
    status: closed
`;
    const config = parseConfig(yaml, "yaml");
    const rows = buildFundingProgramRows(config, "sid_AAAAAAAAAA", []);
    expect(rows[0]!.divisionId).toBeNull();
    expect(rows[0]!.divisionIdSeed).toBeNull();
  });

  it("rejects duplicate program slugs", () => {
    const yaml = `
slug: x-y
name: X
fundingPrograms:
  - name: Same
    programType: rfp
    status: open
  - name: Same
    programType: prize
    status: closed
`;
    const config = parseConfig(yaml, "yaml");
    expect(() => buildFundingProgramRows(config, "sid_AAAAAAAAAA", [])).toThrow(/duplicate/);
  });
});

// ── Snippet formatters ────────────────────────────────────────────────

describe("formatDivisionsSnippet", () => {
  it("returns empty string when no rows", () => {
    expect(formatDivisionsSnippet([], "any")).toBe("");
  });

  it("emits valid TypeScript object literals with all fields quoted", () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const rows = buildDivisionRows(config, "sid_AAAAAAAAAA");
    const snippet = formatDivisionsSnippet(rows, "aria");
    expect(snippet).toContain('// ---- aria ----');
    expect(snippet).toContain('idSeed: "div|aria|programmable-plants"');
    expect(snippet).toContain('parentOrgId: "sid_AAAAAAAAAA"');
    expect(snippet).toContain('divisionType: "program-area"');
    expect(snippet).toContain('status: "active"');
  });

  it("omits null/undefined optional fields rather than emitting `null`", () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const rows = buildDivisionRows(config, "sid_AAAAAAAAAA");
    const lonelinessSnippet = formatDivisionsSnippet([rows[1]!], "aria");
    expect(lonelinessSnippet).not.toContain("startDate");
    expect(lonelinessSnippet).not.toContain("source:");
    expect(lonelinessSnippet).not.toContain("null");
  });
});

describe("formatFundingProgramsSnippet", () => {
  it("emits valid TypeScript object literals including divisionIdSeed", () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const divisions = buildDivisionRows(config, "sid_AAAAAAAAAA");
    const programs = buildFundingProgramRows(config, "sid_AAAAAAAAAA", divisions);
    const snippet = formatFundingProgramsSnippet(programs, "aria");
    expect(snippet).toContain('idSeed: "prog|aria|programmable-plants-rfp"');
    expect(snippet).toContain('divisionIdSeed: "div|aria|programmable-plants"');
    expect(snippet).toContain("totalBudget: 60000000");
    expect(snippet).toContain('currency: "GBP"');
  });

  it("omits divisionIdSeed when program is unlinked", () => {
    const yaml = `
slug: x-y
name: X
fundingPrograms:
  - name: Standalone Prize
    programType: prize
    status: closed
`;
    const config = parseConfig(yaml, "yaml");
    const programs = buildFundingProgramRows(config, "sid_AAAAAAAAAA", []);
    const snippet = formatFundingProgramsSnippet(programs, "x-y");
    expect(snippet).not.toContain("divisionIdSeed");
  });
});

// ── File planner ──────────────────────────────────────────────────────

describe("planFiles", () => {
  it("computes the YAML paths and contents under the given repo root", () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    const record = buildEntityRecord(config, { wikiId: "E1", stableId: "sid_AAAAAAAAAA" });
    const factbase = buildFactBaseDoc("sid_AAAAAAAAAA", undefined);

    const tmp = mkdtempSync(join(tmpdir(), "setup-org-plan-"));
    try {
      const plan = planFiles(tmp, config, record, factbase);
      expect(plan.entityYamlPath).toBe(join(tmp, "data/entities/tiny-org.yaml"));
      expect(plan.factbaseYamlPath).toBe(
        join(tmp, "packages/factbase/data/fb-entities/tiny-org.yaml"),
      );
      expect(plan.entityYamlExists).toBe(false);
      expect(plan.factbaseYamlExists).toBe(false);
      // Entity YAML is a single-element list, not a map.
      expect(plan.entityYamlContents).toMatch(/^- id: tiny-org/m);
      expect(plan.entityYamlContents).toContain("stableId: sid_AAAAAAAAAA");
      expect(plan.entityYamlContents).toContain("wikiId: E1");
      // FactBase YAML has the entity stub even with empty facts.
      expect(plan.factbaseYamlContents).toMatch(/^entity: sid_AAAAAAAAAA/m);
      expect(plan.factbaseYamlContents).toMatch(/facts: \[\]/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags existing files as willOverwrite", () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    const record = buildEntityRecord(config, { wikiId: "E1", stableId: "sid_AAAAAAAAAA" });
    const factbase = buildFactBaseDoc("sid_AAAAAAAAAA", undefined);
    const tmp = mkdtempSync(join(tmpdir(), "setup-org-plan-"));
    try {
      const entityPath = join(tmp, "data/entities/tiny-org.yaml");
      // Pre-create the file.
      mkdirSync(join(tmp, "data/entities"), { recursive: true });
      writeFileSync(entityPath, "- id: tiny-org\n");

      const plan = planFiles(tmp, config, record, factbase);
      expect(plan.entityYamlExists).toBe(true);
      expect(plan.factbaseYamlExists).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Orchestrator ──────────────────────────────────────────────────────

interface MockDeps {
  getIdBySlug: ReturnType<typeof makeMockGetId>;
  allocateId: ReturnType<typeof makeMockAllocate>;
  syncEntities: ReturnType<typeof makeMockSync>;
  syncDivisions: ReturnType<typeof makeMockSync>;
  syncFundingPrograms: ReturnType<typeof makeMockSync>;
  written: Array<{ path: string; contents: string }>;
}

function makeMockGetId(behavior: "found" | "missing" | "fail") {
  return async (_slug: string) => {
    if (behavior === "fail") {
      return { ok: false as const, message: "wiki-server unreachable" };
    }
    if (behavior === "missing") {
      return { ok: true as const, data: null };
    }
    return { ok: true as const, data: { wikiId: "E999", stableId: "sid_EXISTING01" } };
  };
}

function makeMockAllocate(succeed: boolean) {
  return async (_slug: string) => {
    if (!succeed) return { ok: false as const, message: "allocate failed" };
    return { ok: true as const, data: { wikiId: "E1234", stableId: "sid_NEW0000000" } };
  };
}

function makeMockSync(succeed: boolean) {
  let calls = 0;
  const fn = async (_items: unknown) => {
    calls++;
    if (!succeed) return { ok: false as const, message: "sync failed" };
    return { ok: true as const, data: { upserted: 1 } };
  };
  return Object.assign(fn, { getCalls: () => calls });
}

function makeDeps(
  overrides: {
    getId?: "found" | "missing" | "fail";
    allocate?: boolean;
    sync?: boolean;
  } = {},
  repoRoot = "/tmp/fake-root",
): { deps: Parameters<typeof runSetupOrg>[2]; mock: MockDeps } {
  const written: MockDeps["written"] = [];
  const getIdBySlug = makeMockGetId(overrides.getId ?? "missing");
  const allocateId = makeMockAllocate(overrides.allocate ?? true);
  const syncEntities = makeMockSync(overrides.sync ?? true);
  const syncDivisions = makeMockSync(overrides.sync ?? true);
  const syncFundingPrograms = makeMockSync(overrides.sync ?? true);
  const deps: Parameters<typeof runSetupOrg>[2] = {
    repoRoot,
    getIdBySlug,
    allocateId,
    syncEntities,
    syncDivisions,
    syncFundingPrograms,
    writeFile: (path, contents) => written.push({ path, contents }),
    log: () => {},
  };
  return {
    deps,
    mock: {
      getIdBySlug,
      allocateId,
      syncEntities,
      syncDivisions,
      syncFundingPrograms,
      written,
    },
  };
}

describe("runSetupOrg (dry-run)", () => {
  it("never calls allocateId or sync* in dry-run", async () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const { deps, mock } = makeDeps({ getId: "missing" });
    const report = await runSetupOrg(config, { apply: false }, deps);
    expect(mock.syncEntities.getCalls()).toBe(0);
    expect(mock.syncDivisions.getCalls()).toBe(0);
    expect(mock.syncFundingPrograms.getCalls()).toBe(0);
    expect(mock.written).toHaveLength(0);
    expect(report.applied).toBe(false);
    expect(report.wikiId).toBe("<would-allocate-wiki-id>");
    expect(report.stableId).toBe("<would-allocate-stable-id>");
    // Counts are still computed for the preview.
    expect(report.divisions.ids.length).toBe(2);
    expect(report.fundingPrograms.ids.length).toBe(1);
    expect(report.factbaseFacts).toBe(1);
  });

  it("uses the existing ID when the slug is already allocated", async () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const { deps } = makeDeps({ getId: "found" });
    const report = await runSetupOrg(config, { apply: false }, deps);
    expect(report.wikiId).toBe("E999");
    expect(report.stableId).toBe("sid_EXISTING01");
  });

  it("falls back to placeholders when wiki-server is unreachable", async () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    const { deps } = makeDeps({ getId: "fail" });
    const report = await runSetupOrg(config, { apply: false }, deps);
    expect(report.wikiId).toBe("<would-allocate-wiki-id>");
    expect(report.steps[0]!.status).toBe("skipped");
    expect(report.steps[0]!.detail).toContain("lookup failed");
  });

  it("includes follow-up steps for divisions and programs", async () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const { deps } = makeDeps();
    const report = await runSetupOrg(config, { apply: false }, deps);
    expect(report.followUp.some((f) => f.includes("import-divisions.ts"))).toBe(true);
    expect(report.followUp.some((f) => f.includes("import-funding-programs.ts"))).toBe(true);
    expect(report.followUp.some((f) => f.includes("crux w create"))).toBe(true);
    expect(report.divisionsSnippet).toBeTruthy();
    expect(report.fundingProgramsSnippet).toBeTruthy();
  });
});

describe("runSetupOrg (--apply)", () => {
  it("calls allocateId, writes both YAML files, and syncs entity+divisions+programs", async () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const tmp = mkdtempSync(join(tmpdir(), "setup-org-apply-"));
    try {
      const { deps, mock } = makeDeps({}, tmp);
      const report = await runSetupOrg(config, { apply: true }, deps);
      expect(report.applied).toBe(true);
      expect(report.wikiId).toBe("E1234");
      expect(report.stableId).toBe("sid_NEW0000000");
      expect(mock.syncEntities.getCalls()).toBe(1);
      expect(mock.syncDivisions.getCalls()).toBe(1);
      expect(mock.syncFundingPrograms.getCalls()).toBe(1);
      expect(mock.written.map((w) => w.path)).toEqual([
        join(tmp, "data/entities/aria.yaml"),
        join(tmp, "packages/factbase/data/fb-entities/aria.yaml"),
      ]);
      // No failed steps.
      expect(report.steps.filter((s) => s.status === "failed")).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns with failed allocate-id and does not call any sync*", async () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    const { deps, mock } = makeDeps({ allocate: false });
    const report = await runSetupOrg(config, { apply: true }, deps);
    expect(report.steps[0]!.status).toBe("failed");
    expect(mock.syncEntities.getCalls()).toBe(0);
    expect(mock.written).toHaveLength(0);
  });

  it("reports failed sync-entity-pg AND skips downstream syncs to avoid orphans", async () => {
    // When entity sync fails, divisions/programs reference an org that
    // doesn't exist in PG — writing them anyway produces orphan rows.
    // The orchestrator must skip downstream syncs and report why.
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const tmp = mkdtempSync(join(tmpdir(), "setup-org-fail-"));
    try {
      const { deps, mock } = makeDeps({}, tmp);
      let entitySyncCalls = 0;
      deps.syncEntities = async () => {
        entitySyncCalls++;
        return { ok: false, message: "boom" };
      };
      const report = await runSetupOrg(config, { apply: true }, deps);
      expect(entitySyncCalls).toBe(1);
      // Downstream syncs skipped, NOT attempted.
      expect(mock.syncDivisions.getCalls()).toBe(0);
      expect(mock.syncFundingPrograms.getCalls()).toBe(0);
      const divisionsStep = report.steps.find((s) => s.step === "sync-divisions");
      expect(divisionsStep?.status).toBe("skipped");
      expect(divisionsStep?.detail).toContain("orphan");
      const programsStep = report.steps.find((s) => s.step === "sync-funding-programs");
      expect(programsStep?.status).toBe("skipped");
      const entityStep = report.steps.find((s) => s.step === "sync-entity-pg");
      expect(entityStep?.status).toBe("failed");
      expect(entityStep?.detail).toContain("boom");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite existing YAML without --force", async () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    const tmp = mkdtempSync(join(tmpdir(), "setup-org-overwrite-"));
    try {
      // Pre-create the entity YAML to simulate existing content.
      const entityPath = join(tmp, "data/entities/tiny-org.yaml");
      mkdirSync(dirname(entityPath), { recursive: true });
      writeFileSync(entityPath, "- id: tiny-org\n  hand-curated: yes\n");

      const { deps, mock } = makeDeps({}, tmp);
      const report = await runSetupOrg(config, { apply: true }, deps);

      const writeStep = report.steps.find((s) => s.step === "write-entity-yaml");
      expect(writeStep?.status).toBe("failed");
      expect(writeStep?.detail).toContain("--force");
      // No PG calls happened.
      expect(mock.syncEntities.getCalls()).toBe(0);
      // Hand-curated content NOT clobbered.
      expect(readFileSync(entityPath, "utf-8")).toContain("hand-curated: yes");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("overwrites existing YAML when --force is set", async () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    const tmp = mkdtempSync(join(tmpdir(), "setup-org-force-"));
    try {
      const entityPath = join(tmp, "data/entities/tiny-org.yaml");
      mkdirSync(dirname(entityPath), { recursive: true });
      writeFileSync(entityPath, "- id: tiny-org\n  hand-curated: yes\n");

      const { deps, mock } = makeDeps({}, tmp);
      const report = await runSetupOrg(config, { apply: true, force: true }, deps);

      expect(report.steps.find((s) => s.step === "write-entity-yaml")?.status).toBe("ok");
      expect(mock.syncEntities.getCalls()).toBe(1);
      // File was actually written.
      expect(mock.written.find((w) => w.path === entityPath)).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("converts thrown writeFile errors into failed step results (not unhandled exceptions)", async () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    const { deps, mock } = makeDeps();
    deps.writeFile = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const report = await runSetupOrg(config, { apply: true }, deps);
    const writeStep = report.steps.find((s) => s.step === "write-entity-yaml");
    expect(writeStep?.status).toBe("failed");
    expect(writeStep?.detail).toContain("ENOSPC");
    // PG sync skipped because file write failed first.
    expect(mock.syncEntities.getCalls()).toBe(0);
    // The follow-up section warns about the abort.
    expect(report.followUp.some((f) => f.includes("PG sync skipped"))).toBe(true);
  });

  it("skips download files but still surfaces both file-write attempts", async () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    const { deps } = makeDeps();
    let writeCount = 0;
    deps.writeFile = () => {
      writeCount++;
      throw new Error("EACCES");
    };
    const report = await runSetupOrg(config, { apply: true }, deps);
    // Both write attempts run before we abort downstream — user sees full picture.
    expect(writeCount).toBe(2);
    expect(report.steps.filter((s) => s.status === "failed")).toHaveLength(2);
  });
});

// ── End-to-end file write ────────────────────────────────────────────

describe("apply mode writes valid YAML to disk", () => {
  it("entity YAML round-trips through yaml.parse", async () => {
    const config = parseConfig(FULL_CONFIG_YAML, "yaml");
    const tmp = mkdtempSync(join(tmpdir(), "setup-org-rt-"));
    try {
      const written: Array<{ path: string; contents: string }> = [];
      const deps: Parameters<typeof runSetupOrg>[2] = {
        repoRoot: tmp,
        getIdBySlug: async () => ({ ok: true as const, data: null }),
        allocateId: async () => ({
          ok: true as const,
          data: { wikiId: "E1234", stableId: "sid_NEW0000000" },
        }),
        syncEntities: async () => ({ ok: true as const, data: { upserted: 1 } }),
        syncDivisions: async () => ({ ok: true as const, data: { upserted: 2 } }),
        syncFundingPrograms: async () => ({ ok: true as const, data: { upserted: 1 } }),
        writeFile: (path, contents) => {
          // Persist for round-trip check.
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, contents, "utf-8");
          written.push({ path, contents });
        },
        log: () => {},
      };
      await runSetupOrg(config, { apply: true }, deps);
      expect(written).toHaveLength(2);
      const entityPath = join(tmp, "data/entities/aria.yaml");
      expect(existsSync(entityPath)).toBe(true);
      const parsed = parseYaml(readFileSync(entityPath, "utf-8"));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]).toMatchObject({
        id: "aria",
        wikiId: "E1234",
        stableId: "sid_NEW0000000",
        type: "organization",
        title: "Advanced Research and Innovation Agency",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Shell injection defense ──────────────────────────────────────────

describe("follow-up suggestions are shell-safe", () => {
  it("escapes embedded $(...) and backticks in config.name", async () => {
    const yaml = `
slug: ok-slug
name: "$(rm -rf ~) and \`echo pwned\`"
`;
    const config = parseConfig(yaml, "yaml");
    const { deps } = makeDeps();
    const report = await runSetupOrg(config, { apply: false }, deps);
    // The follow-up suggestion uses single-quotes which prevent shell
    // expansion. The literal $(...)/backticks should appear verbatim
    // inside single quotes, not as an active shell construct.
    const wikiCreate = report.followUp.find((f) => f.includes("crux w create"));
    expect(wikiCreate).toBeDefined();
    expect(wikiCreate).toContain("'$(rm -rf ~) and `echo pwned`'");
    // No double-quote wrapper that would allow $() expansion.
    expect(wikiCreate).not.toContain('"$(rm');
  });

  it("escapes embedded single quotes via the standard '\\\\'' trick", async () => {
    const yaml = `
slug: ok-slug
name: "Bob's R&D Lab"
`;
    const config = parseConfig(yaml, "yaml");
    const { deps } = makeDeps();
    const report = await runSetupOrg(config, { apply: false }, deps);
    const wikiCreate = report.followUp.find((f) => f.includes("crux w create"));
    expect(wikiCreate).toContain("'Bob'\\''s R&D Lab'");
  });
});

// ── Format report ─────────────────────────────────────────────────────

describe("formatReport", () => {
  it("includes step status glyphs and the (re-run with --apply) hint in dry-run", async () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    const { deps } = makeDeps();
    const report = await runSetupOrg(config, { apply: false }, deps);
    const text = formatReport(report);
    expect(text).toContain("Dry run (preview)");
    expect(text).toContain("re-run with --apply");
    expect(text).toContain("tiny-org");
  });

  it("omits the (re-run with --apply) hint when applied", async () => {
    const config = parseConfig(MINIMAL_CONFIG_YAML, "yaml");
    const { deps } = makeDeps({}, mkdtempSync(join(tmpdir(), "setup-org-fmt-")));
    const report = await runSetupOrg(config, { apply: true }, deps);
    const text = formatReport(report);
    expect(text).toContain("Applied");
    expect(text).not.toContain("re-run with --apply");
  });
});

