import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
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

  it("respects // schema-drift-ok suppression", () => {
    expect(checkLine('const VALID_QUERY_DIR = ["asc","desc"]; // schema-drift-ok')).toBeNull();
    expect(checkLine('  dir: z.enum(["asc","desc"]), // schema-drift-ok')).toBeNull();
  });

  it("does not match VALID_ inside string literal", () => {
    expect(checkLine('const msg = "Use a const VALID_FOO declaration"')).toBeNull();
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

  it("respects per-line // schema-drift-ok suppression even outside allowlist", () => {
    writeFileSync(
      join(routesDir, "queries.ts"),
      'const sortDir = z.enum(["asc","desc"]); // schema-drift-ok\n',
    );
    writeFileSync(allowlistPath, "");
    const result = runCheck({ rootDir: routesDir, allowlistPath, baseDir: tmpRoot });
    expect(result.passed).toBe(true);
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
