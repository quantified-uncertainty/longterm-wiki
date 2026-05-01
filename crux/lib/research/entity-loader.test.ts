/**
 * Tests for the multi-file entity loader (QUA-936).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { loadAllEntities, findEntity } from "./entity-loader.ts";

describe("loadAllEntities", () => {
  it("merges entities from multiple yaml files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entity-loader-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "responses.yaml"),
        yaml.dump([
          { id: "p1", type: "policy" },
          { id: "p2", type: "policy" },
        ]),
      );
      fs.writeFileSync(
        path.join(tmp, "organizations.yaml"),
        yaml.dump([{ id: "o1", type: "organization" }]),
      );
      const all = loadAllEntities(tmp);
      expect(all.map((e) => e.id).sort()).toEqual(["o1", "p1", "p2"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips files that don't parse or aren't an array", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entity-loader-"));
    try {
      fs.writeFileSync(path.join(tmp, "bad.yaml"), "not: an: array");
      fs.writeFileSync(path.join(tmp, "broken.yaml"), "{{{{not yaml at all");
      fs.writeFileSync(
        path.join(tmp, "ok.yaml"),
        yaml.dump([{ id: "p1", type: "policy" }]),
      );
      const all = loadAllEntities(tmp);
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("p1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips entries missing id or type", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entity-loader-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "mixed.yaml"),
        yaml.dump([
          { id: "good", type: "policy" },
          { id: "no-type" },
          { type: "policy" },
          null,
          "not-an-object",
          { id: 42, type: "policy" }, // numeric id rejected
        ]),
      );
      const all = loadAllEntities(tmp);
      expect(all.map((e) => e.id)).toEqual(["good"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores non-yaml files in the dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entity-loader-"));
    try {
      fs.writeFileSync(path.join(tmp, "README.md"), "# notes");
      fs.writeFileSync(
        path.join(tmp, "responses.yaml"),
        yaml.dump([{ id: "p1", type: "policy" }]),
      );
      const all = loadAllEntities(tmp);
      expect(all.map((e) => e.id)).toEqual(["p1"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("findEntity", () => {
  it("returns the entity matching the slug", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entity-loader-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "organizations.yaml"),
        yaml.dump([
          { id: "anthropic", type: "organization", title: "Anthropic" },
          { id: "openai", type: "organization", title: "OpenAI" },
        ]),
      );
      const e = findEntity("anthropic", tmp);
      expect(e?.id).toBe("anthropic");
      expect(e?.type).toBe("organization");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when the slug is not found", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entity-loader-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "responses.yaml"),
        yaml.dump([{ id: "p1", type: "policy" }]),
      );
      expect(findEntity("ghost", tmp)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
