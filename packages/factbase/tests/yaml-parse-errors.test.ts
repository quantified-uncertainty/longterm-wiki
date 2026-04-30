/**
 * Tests for FactBase YAML parse error reporting (QUA-772).
 *
 * Acceptance criterion: "Make YAML parse errors block the build with a clear
 * message naming the file + line."
 *
 * The `yaml` package's parse errors carry line/column but no file path. We
 * rethrow with the path prepended so a fail-closed build pinpoints the
 * broken file in a tree of ~700 YAMLs without forcing the operator to
 * grep for a snippet of the error message.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKB } from "../src/loader";

describe("FactBase loader — YAML parse error context (QUA-772)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fb-yaml-err-"));
    // Minimal scaffold: properties.yaml + fb-entities/ subdir.
    await writeFile(
      join(tempDir, "properties.yaml"),
      "properties:\n  name:\n    name: Name\n    description: ''\n    appliesTo: ['organization']\n    dataType: text\n",
      "utf-8",
    );
    await mkdir(join(tempDir, "fb-entities"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rethrows fb-entities/<slug>.yaml parse errors with the file path", async () => {
    const brokenPath = join(tempDir, "fb-entities", "broken.yaml");
    // Hard YAML syntax error: tab indent inside a mapping (yaml@2 forbids it).
    await writeFile(brokenPath, "thing:\n\tid: bad-tab-indent\n", "utf-8");

    await expect(loadKB(tempDir)).rejects.toThrow(
      // Error must name the file path so the operator can find it. We don't
      // pin the exact YAML library wording — it's specific to yaml@2.x and
      // could change across versions.
      new RegExp(
        `\\[kb/loader\\] YAML parse error in .*${brokenPath
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\\\\/g, "[\\\\/]")}`,
      ),
    );
  });

  it("rethrows properties.yaml parse errors with the file path", async () => {
    const propertiesPath = join(tempDir, "properties.yaml");
    // Same forbidden tab-indent pattern.
    await writeFile(propertiesPath, "properties:\n\tname: bad\n", "utf-8");

    await expect(loadKB(tempDir)).rejects.toThrow(/properties\.yaml/);
  });

  it("rethrows per-entity-directory file parse errors with the file path", async () => {
    // Per-entity dir layout: fb-entities/<slug>/<file>.yaml
    const slugDir = join(tempDir, "fb-entities", "broken-slug");
    await mkdir(slugDir, { recursive: true });
    const brokenPath = join(slugDir, "facts.yaml");
    await writeFile(brokenPath, "facts:\n\t- id: bad\n", "utf-8");

    await expect(loadKB(tempDir)).rejects.toThrow(
      new RegExp(
        `\\[kb/loader\\] YAML parse error in .*${brokenPath
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\\\\/g, "[\\\\/]")}`,
      ),
    );
  });

  it("does NOT swallow parse errors as warnings — the build must fail-closed", async () => {
    const brokenPath = join(tempDir, "fb-entities", "swallow-test.yaml");
    await writeFile(brokenPath, "thing:\n\tid: x\n", "utf-8");
    // Per QUA-772: every YAML parse error in `data/` or
    // `packages/factbase/data/` must throw, not warn-and-skip. A skip would
    // silently drop facts the wiki depends on.
    await expect(loadKB(tempDir)).rejects.toThrow(/YAML parse error/);
  });
});
