import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkLine, runCheck, readAllowlist } from "./validate-entity-schema-drift.ts";

describe("validate-entity-schema-drift checkLine", () => {
  it("flags const VALID_FOO declaration", () => {
    expect(checkLine('const VALID_POSITIONS = ["support", "oppose"] as const;')).toBe("VALID_CONST");
  });

  it("flags exported VALID_*", () => {
    expect(checkLine('export const VALID_RISK_DOMAINS = [')).toBe("VALID_CONST");
  });

  it("flags inline z.enum([", () => {
    expect(checkLine('  sort: z.enum(["title", "updated_at"]).default("title"),')).toBe("INLINE_ENUM");
  });

  it("ignores z.enum(SOMETHING) without [", () => {
    expect(checkLine('sort: z.enum(SORT_KEYS).default("title")')).toBeNull();
  });

  it("ignores comments", () => {
    expect(checkLine('// const VALID_FOO = ["a"]')).toBeNull();
    expect(checkLine(' * z.enum(["x"])')).toBeNull();
  });

  it("respects // schema-drift-ok: <reason> suppression", () => {
    expect(checkLine('const VALID_QUERY_DIR = ["asc","desc"]; // schema-drift-ok: query enum, not entity wire shape')).toBeNull();
    expect(checkLine('  dir: z.enum(["asc","desc"]), // schema-drift-ok: query enum')).toBeNull();
  });

  it("rejects bare suppression marker without reason", () => {
    // buildSuppressionRegex requires `<marker>: <reason>`; a bare marker
    // does not suppress.
    expect(checkLine('const VALID_X = ["a"]; // schema-drift-ok')).toBe("VALID_CONST");
  });

  it("does not match VALID_ inside string literal", () => {
    expect(checkLine('const msg = "Use a const VALID_FOO = declaration"')).toBeNull();
  });

  it("does not match z.enum([ inside string literal", () => {
    expect(checkLine('const msg = "see z.enum([\\"x\\"]) docs";')).toBeNull();
  });

  it("ignores plain `valid` (case-sensitive)", () => {
    expect(checkLine("const valid = true;")).toBeNull();
  });
});

describe("validate-entity-schema-drift runCheck", () => {
  let tmpRoot: string;
  let routesDir: string;
  let allowlistPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "qua-943-"));
    routesDir = join(tmpRoot, "routes/tablebase");
    mkdirSync(routesDir, { recursive: true });
    allowlistPath = join(tmpRoot, "allowlist.txt");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("passes when no drift markers exist anywhere", () => {
    writeFileSync(join(routesDir, "clean.ts"), "import { z } from 'zod';\nconst schema = z.object({});\n");
    writeFileSync(allowlistPath, "");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });

  it("passes when drift exists only in allowlisted files", () => {
    writeFileSync(join(routesDir, "old.ts"), 'const VALID_THINGS = ["a"];\n');
    writeFileSync(allowlistPath, "routes/tablebase/old.ts\n");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.passed).toBe(true);
    expect(result.fileCountWithDrift).toBe(1);
  });

  it("fails when a non-allowlisted file contains a VALID_* const", () => {
    writeFileSync(join(routesDir, "new.ts"), 'const VALID_NEW = ["x", "y"];\n');
    writeFileSync(allowlistPath, "");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.passed).toBe(false);
    expect(result.newViolations).toHaveLength(1);
    expect(result.newViolations[0].kind).toBe("VALID_CONST");
  });

  it("fails when a non-allowlisted file contains inline z.enum([", () => {
    writeFileSync(join(routesDir, "new.ts"), "const s = z.enum([\"a\", \"b\"]);\n");
    writeFileSync(allowlistPath, "");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.passed).toBe(false);
    expect(result.newViolations[0].kind).toBe("INLINE_ENUM");
  });

  it("fails on stale allowlist entry (file no longer contains drift)", () => {
    writeFileSync(join(routesDir, "clean.ts"), "import { z } from 'zod';\n");
    writeFileSync(allowlistPath, "routes/tablebase/clean.ts\n");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.passed).toBe(false);
    expect(result.staleEntries).toEqual(["routes/tablebase/clean.ts"]);
  });

  it("ignores .test.ts files", () => {
    writeFileSync(join(routesDir, "x.test.ts"), 'const VALID_FOO = ["a"];\n');
    writeFileSync(allowlistPath, "");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.passed).toBe(true);
  });

  it("catches multi-line const VALID_* declarations split across two lines", () => {
    writeFileSync(
      join(routesDir, "split.ts"),
      "const VALID_FOO\n  = [\"a\", \"b\"] as const;\n",
    );
    writeFileSync(allowlistPath, "");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.passed).toBe(false);
    expect(result.newViolations).toHaveLength(1);
    expect(result.newViolations[0].kind).toBe("VALID_CONST");
  });

  it("catches multi-line z.enum split across two lines", () => {
    writeFileSync(
      join(routesDir, "split-enum.ts"),
      "const s = z.enum(\n  [\"a\", \"b\"]\n);\n",
    );
    writeFileSync(allowlistPath, "");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.passed).toBe(false);
    expect(result.newViolations[0].kind).toBe("INLINE_ENUM");
  });

  it("respects per-line // schema-drift-ok: <reason> suppression even outside allowlist", () => {
    writeFileSync(
      join(routesDir, "queries.ts"),
      'const sortDir = z.enum(["asc","desc"]); // schema-drift-ok: query enum\n',
    );
    writeFileSync(allowlistPath, "");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.passed).toBe(true);
  });

  it("attaches file path to violations in result.newViolations", () => {
    writeFileSync(join(routesDir, "n.ts"), 'const VALID_N = ["a"];\n');
    writeFileSync(allowlistPath, "");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.newViolations[0].file).toBe("routes/tablebase/n.ts");
    expect(result.newViolations[0].line).toBe(1);
  });

  it("does not double-count when a comment precedes a real VALID_* declaration", () => {
    // Regression: the multi-line pass used to join the comment line with the
    // next code line and re-match the pattern, producing a phantom violation
    // on the comment line in addition to the real one on line 2.
    writeFileSync(
      join(routesDir, "x.ts"),
      '// kept VALID_OLD comment\nconst VALID_X = ["a"];\n',
    );
    writeFileSync(allowlistPath, "");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.newViolations).toHaveLength(1);
    expect(result.newViolations[0].line).toBe(2);
  });

  it("does not double-count when a JSDoc closer precedes a real declaration", () => {
    writeFileSync(
      join(routesDir, "x.ts"),
      '/**\n * doc\n */\nconst VALID_X = ["a"];\n',
    );
    writeFileSync(allowlistPath, "");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.newViolations).toHaveLength(1);
    expect(result.newViolations[0].line).toBe(4);
  });

  it("multi-line match is not blocked by an unrelated string literal on the prior line", () => {
    // Regression: the prior multi-line guard `pattern.test(joined) &&
    // !pattern.test(lines[i])` mis-fired when lines[i] contained a string
    // literal whose contents matched the pattern, suppressing the legit
    // multi-line match that followed.
    writeFileSync(
      join(routesDir, "x.ts"),
      'const msg = "see const VALID_FAKE = pattern"; const VALID_REAL\n  = ["a"];\n',
    );
    writeFileSync(allowlistPath, "");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.newViolations.length).toBeGreaterThanOrEqual(1);
    expect(result.newViolations.some(v => v.kind === "VALID_CONST")).toBe(true);
  });
});

describe("validate-entity-schema-drift --update mode", () => {
  let tmpRoot: string;
  let routesDir: string;
  let allowlistPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "qua-944-update-"));
    routesDir = join(tmpRoot, "routes/tablebase");
    mkdirSync(routesDir, { recursive: true });
    allowlistPath = join(tmpRoot, "allowlist.txt");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("rewrites allowlist with current files containing drift, sorted", () => {
    writeFileSync(join(routesDir, "z-last.ts"), 'const VALID_X = ["a"];\n');
    writeFileSync(join(routesDir, "a-first.ts"), 'const VALID_Y = ["b"];\n');
    writeFileSync(allowlistPath, "# header preserved\n\n");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot, updateBaseline: true });
    expect(result.passed).toBe(true);
    const written = readFileSync(allowlistPath, "utf-8");
    expect(written).toContain("# header preserved");
    const entries = written.split("\n").filter(l => l && !l.startsWith("#"));
    expect(entries).toEqual([
      "routes/tablebase/a-first.ts",
      "routes/tablebase/z-last.ts",
    ]);
  });

  it("does not crash when allowlist file does not exist", () => {
    writeFileSync(join(routesDir, "x.ts"), 'const VALID_X = ["a"];\n');
    // allowlistPath intentionally not created
    expect(() => runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot, updateBaseline: true })).not.toThrow();
    const written = readFileSync(allowlistPath, "utf-8");
    expect(written).toContain("routes/tablebase/x.ts");
  });

  it("preserves header without gluing it to the first entry (production baseline shape)", () => {
    // Regression: the prior implementation produced
    // `# last comment\napps/.../first.ts...` (no newline) when the input
    // header had no trailing blank line — corrupting the allowlist on next
    // read. The shipped baseline file has exactly this shape.
    writeFileSync(join(routesDir, "a.ts"), 'const VALID_A = ["x"];\n');
    writeFileSync(join(routesDir, "b.ts"), 'const VALID_B = ["y"];\n');
    writeFileSync(allowlistPath, "# header line 1\n# header line 2\n");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot, updateBaseline: true });
    expect(result.passed).toBe(true);
    const written = readFileSync(allowlistPath, "utf-8");
    expect(written).toBe(
      "# header line 1\n# header line 2\nroutes/tablebase/a.ts\nroutes/tablebase/b.ts\n",
    );
    // And the readback round-trips:
    const readBack = readAllowlist(allowlistPath);
    expect(readBack.has("routes/tablebase/a.ts")).toBe(true);
    expect(readBack.has("routes/tablebase/b.ts")).toBe(true);
  });

  it("writes empty list when no drift exists", () => {
    writeFileSync(join(routesDir, "clean.ts"), "import { z } from 'zod';\n");
    writeFileSync(allowlistPath, "# header\n");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot, updateBaseline: true });
    expect(result.passed).toBe(true);
    const written = readFileSync(allowlistPath, "utf-8");
    const entries = written.split("\n").filter(l => l && !l.startsWith("#"));
    expect(entries).toEqual([]);
  });
});

describe("validate-entity-schema-drift readAllowlist", () => {
  it("ignores blank lines and comments", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qua-943-allow-"));
    try {
      const path = join(tmp, "allow.txt");
      writeFileSync(path, "# header\n\nfoo/bar.ts\n  # indented comment is just data, not allowed\nbaz.ts\n\n");
      const set = readAllowlist(path);
      expect(set.has("foo/bar.ts")).toBe(true);
      expect(set.has("baz.ts")).toBe(true);
      expect(set.has("# header")).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
