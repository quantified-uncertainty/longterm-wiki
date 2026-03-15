/**
 * Tests for the !src YAML custom tag and _sources aliases in the KB loader.
 *
 * The !src tag allows file-level source aliases:
 *   _sources:
 *     my-source: https://example.com/source
 *   facts:
 *     - id: f_example
 *       source: !src my-source   → resolves to "https://example.com/source"
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SrcMarker, CUSTOM_TAGS, loadKB } from "../src/loader";

// ── Unit tests: YAML tag parsing ──────────────────────────────────────────────

describe("!src YAML tag — unit tests", () => {
  describe("SrcMarker class", () => {
    it("stores alias as-is", () => {
      expect(new SrcMarker("my-source").alias).toBe("my-source");
      expect(new SrcMarker("anthropic-co").alias).toBe("anthropic-co");
    });
  });

  describe("YAML parsing", () => {
    it("!src produces a SrcMarker", () => {
      const result = parseYaml("source: !src my-alias", {
        customTags: CUSTOM_TAGS,
      }) as Record<string, unknown>;
      expect(result.source).toBeInstanceOf(SrcMarker);
      expect((result.source as SrcMarker).alias).toBe("my-alias");
    });

    it("!src with hyphenated alias", () => {
      const result = parseYaml("source: !src yahoo-finance-arr", {
        customTags: CUSTOM_TAGS,
      }) as Record<string, unknown>;
      expect(result.source).toBeInstanceOf(SrcMarker);
      expect((result.source as SrcMarker).alias).toBe("yahoo-finance-arr");
    });
  });

  describe("YAML stringify roundtrip", () => {
    it("SrcMarker survives stringify → parse", () => {
      const original = { source: new SrcMarker("my-alias") };
      const yaml = stringifyYaml(original, { customTags: CUSTOM_TAGS });
      expect(yaml).toContain("!src");
      expect(yaml).toContain("my-alias");

      const parsed = parseYaml(yaml, { customTags: CUSTOM_TAGS }) as Record<
        string,
        unknown
      >;
      expect(parsed.source).toBeInstanceOf(SrcMarker);
      expect((parsed.source as SrcMarker).alias).toBe("my-alias");
    });
  });
});

// ── Integration tests: loadKB with !src-tagged facts ──────────────────────────

describe("!src YAML tag — loadKB integration", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kb-src-tag-test-"));

    await writeFile(
      join(dataDir, "properties.yaml"),
      `properties:
  revenue:
    name: Revenue
    dataType: number
    unit: USD
  founded-date:
    name: Founded Date
    dataType: date
`
    );

    await mkdir(join(dataDir, "schemas"));
    await writeFile(
      join(dataDir, "schemas", "organization.yaml"),
      `type: organization
name: Organization
required: []
recommended: []
`
    );

    await mkdir(join(dataDir, "things"));

    // Entity with _sources and !src references
    await writeFile(
      join(dataDir, "things", "test-org.yaml"),
      `_sources:
  anthropic-co: https://anthropic.com/company
  yahoo-arr: https://uk.finance.yahoo.com/news/anthropic-arr

thing:
  id: test-org
  stableId: tstSrcOrg01
  type: organization
  name: Test Org

facts:
  - id: f_src_rev01
    property: revenue
    value: 100000000
    asOf: 2023-12
    source: !src yahoo-arr

  - id: f_src_found1
    property: founded-date
    value: "2021-01"
    source: !src anthropic-co

  - id: f_src_rev02
    property: revenue
    value: 200000000
    asOf: 2024-06
    source: https://direct-url.example.com
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("resolves !src alias to the URL from _sources", async () => {
    const { graph } = await loadKB(dataDir);
    const facts = graph.getFacts("tstSrcOrg01", { property: "revenue" });
    const f1 = facts.find((f) => f.id === "f_src_rev01");
    expect(f1).toBeDefined();
    expect(f1!.source).toBe(
      "https://uk.finance.yahoo.com/news/anthropic-arr"
    );
  });

  it("resolves multiple !src aliases in the same file", async () => {
    const { graph } = await loadKB(dataDir);
    const foundedFacts = graph.getFacts("tstSrcOrg01", {
      property: "founded-date",
    });
    expect(foundedFacts).toHaveLength(1);
    expect(foundedFacts[0].source).toBe("https://anthropic.com/company");
  });

  it("leaves non-!src source URLs unchanged", async () => {
    const { graph } = await loadKB(dataDir);
    const facts = graph.getFacts("tstSrcOrg01", { property: "revenue" });
    const f2 = facts.find((f) => f.id === "f_src_rev02");
    expect(f2).toBeDefined();
    expect(f2!.source).toBe("https://direct-url.example.com");
  });

  it("strips _sources from entity data (not treated as entity fields)", async () => {
    const { graph } = await loadKB(dataDir);
    const entity = graph.getEntity("tstSrcOrg01");
    expect(entity).toBeDefined();
    // _sources should not appear on the entity object
    expect((entity as unknown as Record<string, unknown>)._sources).toBeUndefined();
  });
});

// ── Dangling !src alias test ──────────────────────────────────────────────────

describe("!src dangling alias warning", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kb-src-dangling-test-"));

    await writeFile(
      join(dataDir, "properties.yaml"),
      `properties:
  revenue:
    name: Revenue
    dataType: number
`
    );

    await mkdir(join(dataDir, "schemas"));
    await writeFile(
      join(dataDir, "schemas", "organization.yaml"),
      `type: organization
name: Organization
required: []
recommended: []
`
    );

    await mkdir(join(dataDir, "things"));

    // Entity with !src referencing a nonexistent alias
    await writeFile(
      join(dataDir, "things", "dangling-org.yaml"),
      `_sources:
  existing-alias: https://example.com

thing:
  id: dangling-org
  stableId: tstDanglng1
  type: organization
  name: Dangling Org

facts:
  - id: f_dangle_01
    property: revenue
    value: 50000000
    source: !src nonexistent-alias
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("warns about dangling !src alias and falls back to alias name", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { graph } = await loadKB(dataDir);
      const facts = graph.getFacts("tstDanglng1", { property: "revenue" });
      expect(facts).toHaveLength(1);
      // Falls back to raw alias name
      expect(facts[0].source).toBe("nonexistent-alias");
      // Should have warned
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unresolved !src alias "nonexistent-alias"')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── Entity with no _sources uses !src still works (empty sources map) ─────────

describe("!src with no _sources section", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kb-src-nosources-test-"));

    await writeFile(
      join(dataDir, "properties.yaml"),
      `properties:
  revenue:
    name: Revenue
    dataType: number
`
    );

    await mkdir(join(dataDir, "schemas"));
    await writeFile(
      join(dataDir, "schemas", "organization.yaml"),
      `type: organization
name: Organization
required: []
recommended: []
`
    );

    await mkdir(join(dataDir, "things"));

    // Entity without _sources section but using !src
    await writeFile(
      join(dataDir, "things", "no-sources-org.yaml"),
      `thing:
  id: no-sources-org
  stableId: tstNoSrc001
  type: organization
  name: No Sources Org

facts:
  - id: f_nosrc_01
    property: revenue
    value: 1000000
    source: !src missing-alias
`
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("warns and falls back when file has no _sources section", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { graph } = await loadKB(dataDir);
      const facts = graph.getFacts("tstNoSrc001", { property: "revenue" });
      expect(facts).toHaveLength(1);
      expect(facts[0].source).toBe("missing-alias");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unresolved !src alias "missing-alias"')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
