/**
 * Tests for per-entity directory support in the KB loader.
 *
 * Entities can be split across multiple YAML files in a directory:
 *   things/
 *     anthropic.yaml           # single file (existing behavior)
 *     mK9pX3rQ7n/              # directory named by stableId or slug
 *       entity.yaml            # main file with `thing:` block
 *       financials.yaml        # additional facts, records, _sources
 *       people.yaml
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadKB } from "../src/loader";

// ── Helper: create a minimal KB data directory ────────────────────────────────

async function createMinimalKBDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "kb-perdir-test-"));

  await writeFile(
    join(dataDir, "properties.yaml"),
    `properties:
  revenue:
    name: Revenue
    dataType: number
    unit: USD
    temporal: true
  founded-date:
    name: Founded Date
    dataType: date
  headquarters:
    name: Headquarters
    dataType: text
  headcount:
    name: Headcount
    dataType: number
    temporal: true
`
  );

  await mkdir(join(dataDir, "schemas"));
  await writeFile(
    join(dataDir, "schemas", "organization.yaml"),
    `type: organization
name: Organization
required: []
recommended: []
records:
  - funding-round
`
  );

  await mkdir(join(dataDir, "schemas", "records"));
  await writeFile(
    join(dataDir, "schemas", "records", "funding-round.yaml"),
    `name: Funding Round
endpoints:
  organization:
    types: [organization]
    implicit: true
fields:
  date:
    type: date
    required: true
  raised:
    type: number
`
  );

  await mkdir(join(dataDir, "things"));

  return dataDir;
}

// ── Test: single-file entities still work ─────────────────────────────────────

describe("per-entity directories — single files still work", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await createMinimalKBDir();

    // Standard single-file entity
    await writeFile(
      join(dataDir, "things", "single-org.yaml"),
      `thing:
  id: single-org
  stableId: singleOrg01
  type: organization
  name: Single File Org

facts:
  - id: f_single_r01
    property: revenue
    value: 50000000
    asOf: 2024-01
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("loads single-file entity as before", async () => {
    const { graph } = await loadKB(dataDir);
    const entity = graph.getEntity("singleOrg01");
    expect(entity).toBeDefined();
    expect(entity!.name).toBe("Single File Org");

    const facts = graph.getFacts("singleOrg01");
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe("f_single_r01");
  });
});

// ── Test: directory with entity.yaml + supplementary files ────────────────────

describe("per-entity directories — directory merging", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await createMinimalKBDir();

    // Per-entity directory
    await mkdir(join(dataDir, "things", "my-multi-org"));

    // Main file with thing: block
    await writeFile(
      join(dataDir, "things", "my-multi-org", "entity.yaml"),
      `thing:
  id: my-multi-org
  stableId: multiOrg001
  type: organization
  name: Multi File Org

facts:
  - id: f_multi_fnd1
    property: founded-date
    value: "2020-01"
  - id: f_multi_hq01
    property: headquarters
    value: New York, NY
`
    );

    // Supplementary file with additional facts
    await writeFile(
      join(dataDir, "things", "my-multi-org", "financials.yaml"),
      `_sources:
  sec-filing: https://sec.gov/filing/12345

facts:
  - id: f_multi_rev1
    property: revenue
    value: 100000000
    asOf: 2023-12
    source: !src sec-filing
  - id: f_multi_rev2
    property: revenue
    value: 200000000
    asOf: 2024-12
    source: !src sec-filing
`
    );

    // Another supplementary file with records
    await writeFile(
      join(dataDir, "things", "my-multi-org", "funding.yaml"),
      `records:
  funding-rounds:
    series-a:
      date: "2021-06"
      raised: 50000000
    series-b:
      date: "2023-01"
      raised: 200000000
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("loads entity from directory with merged facts", async () => {
    const { graph } = await loadKB(dataDir);
    const entity = graph.getEntity("multiOrg001");
    expect(entity).toBeDefined();
    expect(entity!.name).toBe("Multi File Org");
  });

  it("concatenates facts from multiple files", async () => {
    const { graph } = await loadKB(dataDir);
    const facts = graph.getFacts("multiOrg001");
    // 2 from entity.yaml + 2 from financials.yaml = 4
    expect(facts).toHaveLength(4);

    const factIds = facts.map((f) => f.id).sort();
    expect(factIds).toContain("f_multi_fnd1");
    expect(factIds).toContain("f_multi_hq01");
    expect(factIds).toContain("f_multi_rev1");
    expect(factIds).toContain("f_multi_rev2");
  });

  it("resolves !src aliases from supplementary _sources", async () => {
    const { graph } = await loadKB(dataDir);
    const revenueFacts = graph.getFacts("multiOrg001", { property: "revenue" });
    expect(revenueFacts).toHaveLength(2);
    for (const fact of revenueFacts) {
      expect(fact.source).toBe("https://sec.gov/filing/12345");
    }
  });

  it("merges records from supplementary files", async () => {
    const { graph } = await loadKB(dataDir);
    const rounds = graph.getRecords("multiOrg001", "funding-rounds");
    expect(rounds).toHaveLength(2);

    const seriesA = rounds.find((r) => r.key === "series-a");
    expect(seriesA).toBeDefined();
    expect(seriesA!.fields.date).toBe("2021-06");
    expect(seriesA!.fields.raised).toBe(50000000);
  });
});

// ── Test: error when two files have thing: blocks ──────────────────────────────

describe("per-entity directories — error: multiple thing: blocks", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await createMinimalKBDir();

    await mkdir(join(dataDir, "things", "conflict-dir"));

    await writeFile(
      join(dataDir, "things", "conflict-dir", "main.yaml"),
      `thing:
  id: conflict-a
  stableId: conflict001
  type: organization
  name: Conflict A
`
    );

    await writeFile(
      join(dataDir, "things", "conflict-dir", "other.yaml"),
      `thing:
  id: conflict-b
  stableId: conflict002
  type: organization
  name: Conflict B
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("throws when two files in a directory have thing: blocks", async () => {
    await expect(loadKB(dataDir)).rejects.toThrow(
      /multiple files have a "thing:" block/
    );
  });
});

// ── Test: error when no file has thing: block ──────────────────────────────────

describe("per-entity directories — error: no thing: block", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await createMinimalKBDir();

    await mkdir(join(dataDir, "things", "no-thing-dir"));

    await writeFile(
      join(dataDir, "things", "no-thing-dir", "facts-only.yaml"),
      `facts:
  - id: f_orphan_01
    property: revenue
    value: 999
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("throws when no file in directory has a thing: block", async () => {
    await expect(loadKB(dataDir)).rejects.toThrow(
      /no file contains a "thing:" block/
    );
  });
});

// ── Test: _sources merge from multiple files ──────────────────────────────────

describe("per-entity directories — _sources merging", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await createMinimalKBDir();

    await mkdir(join(dataDir, "things", "sources-merge"));

    await writeFile(
      join(dataDir, "things", "sources-merge", "entity.yaml"),
      `_sources:
  source-a: https://example.com/a

thing:
  id: sources-merge
  stableId: srcMerge001
  type: organization
  name: Sources Merge Org

facts:
  - id: f_srm_01
    property: founded-date
    value: "2022-01"
    source: !src source-a
`
    );

    await writeFile(
      join(dataDir, "things", "sources-merge", "extra.yaml"),
      `_sources:
  source-b: https://example.com/b

facts:
  - id: f_srm_02
    property: revenue
    value: 1000000
    asOf: 2024-01
    source: !src source-b
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("merges _sources from multiple files", async () => {
    const { graph } = await loadKB(dataDir);
    const facts = graph.getFacts("srcMerge001");
    expect(facts).toHaveLength(2);

    const f1 = facts.find((f) => f.id === "f_srm_01");
    expect(f1!.source).toBe("https://example.com/a");

    const f2 = facts.find((f) => f.id === "f_srm_02");
    expect(f2!.source).toBe("https://example.com/b");
  });
});

// ── Test: _sources key conflict with different values ─────────────────────────

describe("per-entity directories — _sources conflict", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await createMinimalKBDir();

    await mkdir(join(dataDir, "things", "src-conflict"));

    await writeFile(
      join(dataDir, "things", "src-conflict", "entity.yaml"),
      `_sources:
  shared-key: https://example.com/version-a

thing:
  id: src-conflict
  stableId: srcConfl001
  type: organization
  name: Source Conflict Org
`
    );

    await writeFile(
      join(dataDir, "things", "src-conflict", "extra.yaml"),
      `_sources:
  shared-key: https://example.com/version-b
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("throws on _sources alias conflict with different values", async () => {
    await expect(loadKB(dataDir)).rejects.toThrow(
      /_sources alias conflict.*shared-key/
    );
  });
});

// ── Test: _sources with same value (no conflict) ──────────────────────────────

describe("per-entity directories — _sources same value OK", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await createMinimalKBDir();

    await mkdir(join(dataDir, "things", "src-same"));

    await writeFile(
      join(dataDir, "things", "src-same", "entity.yaml"),
      `_sources:
  shared-key: https://example.com/same

thing:
  id: src-same
  stableId: srcSameV001
  type: organization
  name: Same Source Org
`
    );

    await writeFile(
      join(dataDir, "things", "src-same", "extra.yaml"),
      `_sources:
  shared-key: https://example.com/same
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("allows _sources with same alias and same value", async () => {
    const { graph } = await loadKB(dataDir);
    const entity = graph.getEntity("srcSameV001");
    expect(entity).toBeDefined();
    expect(entity!.name).toBe("Same Source Org");
  });
});

// ── Test: record key conflicts ────────────────────────────────────────────────

describe("per-entity directories — record key conflict", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await createMinimalKBDir();

    await mkdir(join(dataDir, "things", "rec-conflict"));

    await writeFile(
      join(dataDir, "things", "rec-conflict", "entity.yaml"),
      `thing:
  id: rec-conflict
  stableId: recConfl001
  type: organization
  name: Record Conflict Org

records:
  funding-rounds:
    series-a:
      date: "2021-01"
      raised: 50000000
`
    );

    await writeFile(
      join(dataDir, "things", "rec-conflict", "extra.yaml"),
      `records:
  funding-rounds:
    series-a:
      date: "2022-01"
      raised: 100000000
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("throws on record key conflict in same collection", async () => {
    await expect(loadKB(dataDir)).rejects.toThrow(
      /record key conflict.*series-a/
    );
  });
});

// ── Test: mixed single files and directories ──────────────────────────────────

describe("per-entity directories — mixed single files and directories", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await createMinimalKBDir();

    // Single-file entity
    await writeFile(
      join(dataDir, "things", "standalone.yaml"),
      `thing:
  id: standalone
  stableId: standalone1
  type: organization
  name: Standalone Org

facts:
  - id: f_stdalone1
    property: headquarters
    value: London, UK
`
    );

    // Directory entity
    await mkdir(join(dataDir, "things", "multi-entity"));
    await writeFile(
      join(dataDir, "things", "multi-entity", "entity.yaml"),
      `thing:
  id: multi-entity
  stableId: multiEnt001
  type: organization
  name: Multi Entity Org

facts:
  - id: f_multi_e01
    property: headquarters
    value: Berlin, DE
`
    );

    await writeFile(
      join(dataDir, "things", "multi-entity", "financials.yaml"),
      `facts:
  - id: f_multi_e02
    property: revenue
    value: 75000000
    asOf: 2024-01
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("loads both single-file and directory entities", async () => {
    const { graph } = await loadKB(dataDir);

    // Single-file entity
    const standalone = graph.getEntity("standalone1");
    expect(standalone).toBeDefined();
    expect(standalone!.name).toBe("Standalone Org");
    const standaloneFacts = graph.getFacts("standalone1");
    expect(standaloneFacts).toHaveLength(1);

    // Directory entity
    const multi = graph.getEntity("multiEnt001");
    expect(multi).toBeDefined();
    expect(multi!.name).toBe("Multi Entity Org");
    const multiFacts = graph.getFacts("multiEnt001");
    expect(multiFacts).toHaveLength(2);
  });
});

// ── Test: empty subdirectory is skipped ───────────────────────────────────────

describe("per-entity directories — empty directory skipped", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await createMinimalKBDir();

    // Create an empty subdirectory
    await mkdir(join(dataDir, "things", "empty-dir"));

    // And a normal entity to verify loading still works
    await writeFile(
      join(dataDir, "things", "normal.yaml"),
      `thing:
  id: normal
  stableId: normalEnt01
  type: organization
  name: Normal Org
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("skips empty directories without error", async () => {
    const { graph } = await loadKB(dataDir);
    const entity = graph.getEntity("normalEnt01");
    expect(entity).toBeDefined();
    expect(entity!.name).toBe("Normal Org");
  });
});
