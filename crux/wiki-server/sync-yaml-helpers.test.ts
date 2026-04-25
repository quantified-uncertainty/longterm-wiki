import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  asString,
  asOptionalString,
  assertPlainObject,
  loadYamlDir,
} from "./sync-yaml-helpers.ts";

describe("asString", () => {
  it("returns the string when valid", () => {
    expect(asString("hello", "field", "file.yaml")).toBe("hello");
  });

  it("throws on empty string", () => {
    expect(() => asString("", "name", "file.yaml")).toThrow(/name.*non-empty/);
  });

  it("throws on whitespace-only string", () => {
    expect(() => asString("   ", "name", "file.yaml")).toThrow(/name.*non-empty/);
  });

  it("throws on non-string types", () => {
    expect(() => asString(42, "num", "file.yaml")).toThrow(/num.*non-empty/);
    expect(() => asString(null, "n", "file.yaml")).toThrow();
    expect(() => asString(undefined, "n", "file.yaml")).toThrow();
    expect(() => asString({}, "n", "file.yaml")).toThrow();
  });

  it("includes file and field in error", () => {
    expect(() => asString(null, "dimension", "orgs/anthropic.yaml")).toThrow(
      /orgs\/anthropic\.yaml.*dimension/,
    );
  });
});

describe("asOptionalString", () => {
  it("returns the string when valid", () => {
    expect(asOptionalString("hello", "field", "file.yaml")).toBe("hello");
  });

  it("returns null for undefined, null, empty string", () => {
    expect(asOptionalString(undefined, "n", "f")).toBeNull();
    expect(asOptionalString(null, "n", "f")).toBeNull();
    expect(asOptionalString("", "n", "f")).toBeNull();
  });

  it("throws on non-string non-nullish values", () => {
    expect(() => asOptionalString(42, "num", "f.yaml")).toThrow(/num.*string/);
    expect(() => asOptionalString({}, "obj", "f.yaml")).toThrow(/obj.*string/);
    expect(() => asOptionalString([], "arr", "f.yaml")).toThrow(/arr.*string/);
  });

  it("accepts whitespace-only as a valid present string (differs from asString)", () => {
    // This is the existing contract — optional passthrough doesn't trim,
    // so "   " is a present-but-meaningless string. Callers validate shape
    // separately if they care.
    expect(asOptionalString("  ", "n", "f")).toBe("  ");
  });
});

describe("assertPlainObject", () => {
  it("passes for plain objects", () => {
    expect(() => assertPlainObject({}, "where")).not.toThrow();
    expect(() => assertPlainObject({ a: 1 }, "where")).not.toThrow();
  });

  it("throws for null", () => {
    expect(() => assertPlainObject(null, "items[0]")).toThrow(
      /items\[0\].*must be an object/,
    );
  });

  it("throws for undefined", () => {
    expect(() => assertPlainObject(undefined, "items[0]")).toThrow(
      /must be an object/,
    );
  });

  it("throws for arrays", () => {
    expect(() => assertPlainObject([], "items[0]")).toThrow(/must be an object/);
    expect(() => assertPlainObject([1, 2], "items[0]")).toThrow(
      /must be an object/,
    );
  });

  it("throws for primitives", () => {
    expect(() => assertPlainObject("hello", "where")).toThrow();
    expect(() => assertPlainObject(42, "where")).toThrow();
    expect(() => assertPlainObject(true, "where")).toThrow();
  });

  it("narrows the type for typescript callers", () => {
    const v: unknown = { foo: "bar" };
    assertPlainObject(v, "where");
    // v is now Record<string, unknown>; this line would be a type error
    // if the assertion didn't narrow.
    expect(v.foo).toBe("bar");
  });
});

describe("loadYamlDir", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "yaml-dir-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeFile(name: string, contents: string): void {
    writeFileSync(join(tmp, name), contents);
  }

  interface Item {
    id: string;
    entityId: string;
    label: string;
  }

  const trivialLoader = (filePath: string): Item[] => {
    const raw = filePath.split("/").pop() ?? "";
    const base = raw.replace(/\.(yaml|yml)$/, "");
    return [
      {
        id: `id-${base}`,
        entityId: `entity-${base}`,
        label: base,
      },
    ];
  };

  it("returns empty for a missing directory", () => {
    const result = loadYamlDir<Item>({
      dir: join(tmp, "nope"),
      loadFile: trivialLoader,
      kindLabel: "item",
      describe: (i) => i.id,
    });
    expect(result.items).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it("lists yaml and yml files sorted, ignoring others", () => {
    writeFile("b.yaml", "");
    writeFile("a.yaml", "");
    writeFile("c.yml", "");
    writeFile("notes.md", "");
    writeFile("README.txt", "");

    const result = loadYamlDir<Item>({
      dir: tmp,
      loadFile: trivialLoader,
      kindLabel: "item",
      describe: (i) => i.id,
    });
    expect(result.files).toEqual(["a.yaml", "b.yaml", "c.yml"]);
    expect(result.items.map((i) => i.label)).toEqual(["a", "b", "c"]);
  });

  it("throws a descriptive error on cross-file duplicate IDs", () => {
    writeFile("first.yaml", "");
    writeFile("second.yaml", "");

    const loadFile = (filePath: string): Item[] => {
      const base = filePath.endsWith("first.yaml") ? "first" : "second";
      return [
        {
          id: "dup",
          entityId: `entity-${base}`,
          label: base,
        },
      ];
    };

    expect(() =>
      loadYamlDir<Item>({
        dir: tmp,
        loadFile,
        kindLabel: "thing",
        describe: (i) => `${i.entityId}/${i.label}`,
        dedupHint: "Change the label to disambiguate.",
      }),
    ).toThrow(
      /Duplicate thing ID dup from \(entity-first\/first\) and \(entity-second\/second\)\. Change the label to disambiguate\./,
    );
  });

  it("propagates errors thrown by loadFile unchanged", () => {
    writeFile("broken.yaml", "");
    const loadFile = (filePath: string): Item[] => {
      throw new Error(`boom: ${filePath}`);
    };
    expect(() =>
      loadYamlDir<Item>({
        dir: tmp,
        loadFile,
        kindLabel: "x",
        describe: () => "",
      }),
    ).toThrow(/boom:.*broken\.yaml/);
  });

  it("uses the default dedup hint when none is provided", () => {
    writeFile("a.yaml", "");
    writeFile("b.yaml", "");
    const loadFile = (): Item[] => [
      { id: "dup", entityId: "e", label: "x" },
    ];
    expect(() =>
      loadYamlDir<Item>({
        dir: tmp,
        loadFile,
        kindLabel: "item",
        describe: (i) => i.id,
      }),
    ).toThrow(/Adjust one field to disambiguate\./);
  });

  it("aggregates items across files and preserves load order", () => {
    writeFile("a.yaml", "");
    writeFile("b.yaml", "");
    const loadFile = (filePath: string): Item[] => {
      if (filePath.endsWith("a.yaml")) {
        return [
          { id: "a1", entityId: "e1", label: "a1" },
          { id: "a2", entityId: "e1", label: "a2" },
        ];
      }
      return [{ id: "b1", entityId: "e2", label: "b1" }];
    };

    const result = loadYamlDir<Item>({
      dir: tmp,
      loadFile,
      kindLabel: "item",
      describe: (i) => i.id,
    });
    expect(result.items.map((i) => i.id)).toEqual(["a1", "a2", "b1"]);
    expect(result.files).toEqual(["a.yaml", "b.yaml"]);
  });
});
