/**
 * Tests that normalizeValue in the loader correctly parses
 * array and object values into range/min FactValue types.
 *
 * Since normalizeValue is not exported, we test through loadKB
 * using temporary YAML files.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadKB } from "../src/loader";
import type { Graph } from "../src/graph";

describe("loader: range/min value parsing", () => {
  let tmpDir: string;
  let graph: Graph;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kb-range-test-"));

    // Write properties.yaml
    await writeFile(
      join(tmpDir, "properties.yaml"),
      `properties:
  revenue:
    name: Revenue
    dataType: number
    unit: USD
  headcount:
    name: Headcount
    dataType: number
`,
    );

    // Write schemas
    await mkdir(join(tmpDir, "schemas"));
    await writeFile(
      join(tmpDir, "schemas", "organization.yaml"),
      `type: organization
name: Organization
required: []
recommended: []
`,
    );

    // Write a test entity with range and min values
    await mkdir(join(tmpDir, "things"));
    await writeFile(
      join(tmpDir, "things", "test-org.yaml"),
      `thing:
  id: test-org
  stableId: aB3cD4eF5g
  type: organization
  name: Test Organization
facts:
  - id: f_range_rev
    property: revenue
    value: [20000000000, 26000000000]
    asOf: "2025"
  - id: f_min_rev
    property: revenue
    value:
      min: 67000000000
    asOf: "2026"
  - id: f_normal_rev
    property: revenue
    value: 5000000000
    asOf: "2024"
  - id: f_headcount
    property: headcount
    value: [1000, 2000]
`,
    );

    ({ graph } = await loadKB(tmpDir));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("parses [lo, hi] array as range value", () => {
    const facts = graph.getFacts("aB3cD4eF5g", { property: "revenue" });
    const rangeFact = facts.find((f) => f.id === "f_range_rev");
    expect(rangeFact).toBeDefined();
    expect(rangeFact!.value).toEqual({
      type: "range",
      low: 20e9,
      high: 26e9,
    });
  });

  it("parses { min: N } object as min value", () => {
    const facts = graph.getFacts("aB3cD4eF5g", { property: "revenue" });
    const minFact = facts.find((f) => f.id === "f_min_rev");
    expect(minFact).toBeDefined();
    expect(minFact!.value).toEqual({
      type: "min",
      value: 67e9,
    });
  });

  it("still parses plain numbers normally", () => {
    const facts = graph.getFacts("aB3cD4eF5g", { property: "revenue" });
    const normalFact = facts.find((f) => f.id === "f_normal_rev");
    expect(normalFact).toBeDefined();
    expect(normalFact!.value).toEqual({
      type: "number",
      value: 5e9,
    });
  });

  it("parses range value for non-USD property", () => {
    const facts = graph.getFacts("aB3cD4eF5g", { property: "headcount" });
    const rangeFact = facts.find((f) => f.id === "f_headcount");
    expect(rangeFact).toBeDefined();
    expect(rangeFact!.value).toEqual({
      type: "range",
      low: 1000,
      high: 2000,
    });
  });
});
