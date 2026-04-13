import { describe, expect, it } from "vitest";
import {
  extractChecksFromSql,
  extractZodEnumsFromTs,
  diffCheckAgainstZod,
  findZodCandidates,
  type CheckConstraint,
  type ZodEnum,
} from "./validate-zod-check-parity.ts";

describe("extractChecksFromSql", () => {
  it("parses inline CHECK in CREATE TABLE", () => {
    const sql = `
CREATE TABLE "jobs" (
  id SERIAL PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done'))
);
`;
    const checks = extractChecksFromSql(sql, "test.sql");
    expect(checks).toHaveLength(1);
    expect(checks[0].table).toBe("jobs");
    expect(checks[0].column).toBe("status");
    expect([...checks[0].allowed].sort()).toEqual(["done", "pending", "running"]);
    expect(checks[0].nullable).toBe(false);
  });

  it("parses ALTER TABLE ADD CONSTRAINT", () => {
    const sql = `
DO $$ BEGIN
  ALTER TABLE "auto_update_results"
    ADD CONSTRAINT chk_aur_status
    CHECK (status IN ('success', 'failed', 'skipped'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
`;
    const checks = extractChecksFromSql(sql, "test.sql");
    expect(checks).toHaveLength(1);
    expect(checks[0].table).toBe("auto_update_results");
    expect(checks[0].column).toBe("status");
    expect([...checks[0].allowed].sort()).toEqual(["failed", "skipped", "success"]);
  });

  it("parses nullable CHECK with IS NULL OR variant", () => {
    const sql = `
ALTER TABLE "grants"
  ADD CONSTRAINT chk_grants_status
  CHECK (status IS NULL OR status IN ('active', 'completed'));
`;
    const checks = extractChecksFromSql(sql, "test.sql");
    expect(checks).toHaveLength(1);
    expect(checks[0].table).toBe("grants");
    expect(checks[0].column).toBe("status");
    expect([...checks[0].allowed].sort()).toEqual(["active", "completed"]);
    expect(checks[0].nullable).toBe(true);
  });

  it("ignores non-enum CHECK constraints (BETWEEN, comparison)", () => {
    const sql = `
CREATE TABLE "coverage_scans" (
  coverage_score INTEGER NOT NULL CHECK (coverage_score BETWEEN 1 AND 4)
);
ALTER TABLE "foo" ADD CONSTRAINT chk_foo CHECK (value > 0);
`;
    const checks = extractChecksFromSql(sql, "test.sql");
    expect(checks).toHaveLength(0);
  });

  it("skips commented-out CHECK constraints", () => {
    const sql = `
-- ALTER TABLE "old" ADD CONSTRAINT chk_old CHECK (status IN ('a', 'b'));
ALTER TABLE "new" ADD CONSTRAINT chk_new CHECK (status IN ('x', 'y'));
`;
    const checks = extractChecksFromSql(sql, "test.sql");
    expect(checks).toHaveLength(1);
    expect(checks[0].table).toBe("new");
    expect([...checks[0].allowed].sort()).toEqual(["x", "y"]);
  });

  it("handles multiple CHECKs in one migration", () => {
    const sql = `
ALTER TABLE "a" ADD CONSTRAINT chk_a CHECK (col IN ('a1', 'a2'));
ALTER TABLE "b" ADD CONSTRAINT chk_b CHECK (col IS NULL OR col IN ('b1'));
`;
    const checks = extractChecksFromSql(sql, "test.sql");
    expect(checks).toHaveLength(2);
    expect(checks[0].table).toBe("a");
    expect(checks[1].table).toBe("b");
    expect(checks[1].nullable).toBe(true);
  });
});

describe("extractZodEnumsFromTs", () => {
  it("parses named z.enum declarations", () => {
    const src = `
export const JobStatusSchema = z.enum(["pending", "running", "done"]);
`;
    const enums = extractZodEnumsFromTs(src, "test.ts");
    expect(enums).toHaveLength(1);
    expect(enums[0].name).toBe("JobStatusSchema");
    expect([...enums[0].values].sort()).toEqual(["done", "pending", "running"]);
  });

  it("parses inline z.enum (unnamed)", () => {
    const src = `
const schema = z.object({
  status: z.enum(["success", "failed"]),
});
`;
    const enums = extractZodEnumsFromTs(src, "test.ts");
    expect(enums).toHaveLength(1);
    expect(enums[0].name).toBeNull();
    expect([...enums[0].values].sort()).toEqual(["failed", "success"]);
  });

  it("parses `as const` array constants", () => {
    const src = `
export const VALID_GK_EVENTS = [
  "success",
  "failure",
  "error",
  "circuit_breaker_reset",
] as const;
`;
    const enums = extractZodEnumsFromTs(src, "test.ts");
    expect(enums).toHaveLength(1);
    expect(enums[0].name).toBe("VALID_GK_EVENTS");
    expect(enums[0].values.has("circuit_breaker_reset")).toBe(true);
  });

  it("handles multiple enums in one file", () => {
    const src = `
export const VALID_TYPES = ["a", "b"] as const;
export const StatusSchema = z.enum(["on", "off"]);
`;
    const enums = extractZodEnumsFromTs(src, "test.ts");
    expect(enums).toHaveLength(2);
    expect(enums.find((e) => e.name === "VALID_TYPES")).toBeDefined();
    expect(enums.find((e) => e.name === "StatusSchema")).toBeDefined();
  });
});

describe("diffCheckAgainstZod", () => {
  const check = (overrides: Partial<CheckConstraint> = {}): CheckConstraint => ({
    sourceFile: "fake.sql",
    table: "groundskeeper_runs",
    column: "event",
    allowed: new Set(["success", "failure"]),
    nullable: false,
    ...overrides,
  });

  // File path must match the MANUAL_MAPPINGS entry for "groundskeeper_runs.event"
  const zod = (overrides: Partial<ZodEnum> = {}): ZodEnum => ({
    sourceFile: "apps/wiki-server/src/api-types.ts",
    name: "VALID_GK_EVENTS",
    values: new Set(["success", "failure"]),
    line: 1,
    ...overrides,
  });

  it("flags ZOD_EXTRA when Zod enum has a value the CHECK rejects", () => {
    const c = check({ allowed: new Set(["success", "failure"]) });
    const z = zod({ values: new Set(["success", "failure", "circuit_breaker_reset"]) });
    const { findings } = diffCheckAgainstZod(c, [z]);
    const zodExtras = findings.filter((f) => f.severity === "ZOD_EXTRA");
    expect(zodExtras).toHaveLength(1);
    expect(zodExtras[0].values).toEqual(["circuit_breaker_reset"]);
    expect(zodExtras[0].table).toBe("groundskeeper_runs");
    expect(zodExtras[0].column).toBe("event");
  });

  it("flags CHECK_EXTRA when CHECK has a value the Zod enum lacks", () => {
    const c = check({ allowed: new Set(["success", "failure", "skipped"]) });
    const z = zod({ values: new Set(["success", "failure"]) });
    const { findings } = diffCheckAgainstZod(c, [z]);
    const checkExtras = findings.filter((f) => f.severity === "CHECK_EXTRA");
    expect(checkExtras).toHaveLength(1);
    expect(checkExtras[0].values).toEqual(["skipped"]);
  });

  it("returns no findings when sets are equal", () => {
    const c = check({ allowed: new Set(["a", "b", "c"]) });
    const z = zod({ values: new Set(["a", "b", "c"]) });
    const { findings } = diffCheckAgainstZod(c, [z]);
    expect(findings).toHaveLength(0);
  });

  it("returns no findings and no matches when no Zod candidate matches", () => {
    const c: CheckConstraint = {
      sourceFile: "fake.sql",
      table: "unknown_table",
      column: "some_field",
      allowed: new Set(["x", "y"]),
      nullable: false,
    };
    const z: ZodEnum = {
      sourceFile: "unrelated.ts",
      name: "UnrelatedSchema",
      values: new Set(["z"]),
      line: 1,
    };
    const { matches, findings } = diffCheckAgainstZod(c, [z]);
    expect(matches).toHaveLength(0);
    expect(findings).toHaveLength(0);
  });

  it("detects all missing values when Zod is a superset", () => {
    const c = check({ allowed: new Set(["a"]) });
    const z = zod({ values: new Set(["a", "b", "c", "d"]) });
    const { findings } = diffCheckAgainstZod(c, [z]);
    const zodExtras = findings.filter((f) => f.severity === "ZOD_EXTRA");
    expect(zodExtras).toHaveLength(3);
    expect(zodExtras.map((f) => f.values[0]).sort()).toEqual(["b", "c", "d"]);
  });
});

describe("findZodCandidates", () => {
  const makeZod = (name: string | null, file: string, values: string[]): ZodEnum => ({
    sourceFile: file,
    name,
    values: new Set(values),
    line: 1,
  });

  it("uses manual registry with file-scoped target", () => {
    const c: CheckConstraint = {
      sourceFile: "mig.sql",
      table: "groundskeeper_runs",
      column: "event",
      allowed: new Set(),
      nullable: false,
    };
    const correct = makeZod("VALID_GK_EVENTS", "apps/wiki-server/src/api-types.ts", ["a"]);
    const wrongFile = makeZod(
      "VALID_GK_EVENTS",
      "apps/wiki-server/src/routes/other.ts",
      ["a"]
    );
    const candidates = findZodCandidates(c, [correct, wrongFile]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceFile).toContain("api-types.ts");
  });

  it("returns empty for unregistered CHECK with no heuristic match", () => {
    const c: CheckConstraint = {
      sourceFile: "mig.sql",
      table: "totally_unrelated",
      column: "foo",
      allowed: new Set(),
      nullable: false,
    };
    const z = makeZod("SomeSchema", "apps/wiki-server/src/routes/other.ts", ["x"]);
    const candidates = findZodCandidates(c, [z]);
    expect(candidates).toHaveLength(0);
  });

  it("matches `VALID_STATUSES` (plural -es) against `status` column via bare heuristic", () => {
    const c: CheckConstraint = {
      sourceFile: "mig.sql",
      table: "divisions",
      column: "status",
      allowed: new Set(["active", "inactive"]),
      nullable: false,
    };
    const z = makeZod(
      "VALID_STATUSES",
      "apps/wiki-server/src/routes/tablebase/divisions.ts",
      ["active", "inactive"]
    );
    const candidates = findZodCandidates(c, [z]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("VALID_STATUSES");
  });

  it("excludes qualified sibling enums like `VALID_CANDIDATE_STATUSES` for `status` column", () => {
    const c: CheckConstraint = {
      sourceFile: "mig.sql",
      table: "political_races",
      column: "status",
      allowed: new Set(["upcoming"]),
      nullable: false,
    };
    const bare = makeZod(
      "VALID_STATUSES",
      "apps/wiki-server/src/routes/tablebase/political-races.ts",
      ["upcoming", "active"]
    );
    const qualified = makeZod(
      "VALID_CANDIDATE_STATUSES",
      "apps/wiki-server/src/routes/tablebase/political-races.ts",
      ["running", "won"]
    );
    const candidates = findZodCandidates(c, [bare, qualified]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("VALID_STATUSES");
  });
});
