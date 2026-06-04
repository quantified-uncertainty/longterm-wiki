import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  parseSections,
  generateMdx,
  normalizeForDiff,
  VOLATILE_FRONTMATTER_KEY,
} from "./generate-db-schema-docs.ts";
import { introspectSchema } from "../../apps/wiki-server/src/schema-introspect.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA_PATH = join(ROOT, "apps/wiki-server/src/schema.ts");

// ─── parseSections: banner parsing ──────────────────────────────────────────

describe("parseSections", () => {
  it("assigns tables to the nearest preceding multi-line banner", () => {
    const source = [
      "// ============================================================================",
      "// First Domain",
      "// some description of the domain that spans",
      "// multiple comment lines before the closing rule",
      "// ============================================================================",
      'export const alpha = pgTable("alpha", {});',
      'export const beta = pgTable("beta", {});',
      "",
      "// ============================================================================",
      "// Second Domain",
      "// ============================================================================",
      'export const gamma = pgTable("gamma", {});',
    ].join("\n");

    const { exportToSection, order } = parseSections(source);
    expect(exportToSection.get("alpha")).toBe("First Domain");
    expect(exportToSection.get("beta")).toBe("First Domain");
    expect(exportToSection.get("gamma")).toBe("Second Domain");
    expect(order).toEqual(["Core", "First Domain", "Second Domain"]);
  });

  it("puts tables declared before any banner under Core", () => {
    const source = [
      'export const early = pgTable("early", {});',
      "// ============================================================================",
      "// Later",
      "// ============================================================================",
      'export const late = pgTable("late", {});',
    ].join("\n");

    const { exportToSection } = parseSections(source);
    expect(exportToSection.get("early")).toBe("Core");
    expect(exportToSection.get("late")).toBe("Later");
  });

  it("ignores rule lines that are not followed by a title comment", () => {
    const source = [
      "// ============================================================================",
      "// ============================================================================",
      'export const x = pgTable("x", {});',
    ].join("\n");
    const { exportToSection, order } = parseSections(source);
    // Two consecutive rules → no title captured → stays in Core.
    expect(exportToSection.get("x")).toBe("Core");
    expect(order).toEqual(["Core"]);
  });
});

// ─── normalizeForDiff: ignores the volatile date line ───────────────────────

describe("normalizeForDiff", () => {
  it("strips the lastEdited frontmatter line so dates do not cause false drift", () => {
    const a = `---\n${VOLATILE_FRONTMATTER_KEY}: "2026-01-01"\ntitle: x\n---\nbody`;
    const b = `---\n${VOLATILE_FRONTMATTER_KEY}: "2099-12-31"\ntitle: x\n---\nbody`;
    expect(normalizeForDiff(a)).toBe(normalizeForDiff(b));
  });

  it("does not mask a real body difference", () => {
    const a = `${VOLATILE_FRONTMATTER_KEY}: "2026-01-01"\n| Tables | 114 |`;
    const b = `${VOLATILE_FRONTMATTER_KEY}: "2026-01-01"\n| Tables | 113 |`;
    expect(normalizeForDiff(a)).not.toBe(normalizeForDiff(b));
  });
});

// ─── generateMdx against the real schema ────────────────────────────────────

describe("generateMdx (real schema)", () => {
  const introspection = introspectSchema();
  const source = readFileSync(SCHEMA_PATH, "utf8");
  const mdx = generateMdx(introspection, source, "2026-01-01");

  it("is deterministic for the same inputs (drift gate relies on this)", () => {
    const again = generateMdx(introspection, source, "2026-01-01");
    expect(again).toBe(mdx);
  });

  it("includes correct summary counts derived from introspection", () => {
    const totalCols = introspection.tables.reduce((s, t) => s + t.columns.length, 0);
    const totalFks = introspection.tables.reduce((s, t) => s + t.foreignKeys.length, 0);
    expect(mdx).toContain(`| Tables | ${introspection.tables.length} |`);
    expect(mdx).toContain(`| Columns | ${totalCols} |`);
    expect(mdx).toContain(`| Foreign keys | ${totalFks} |`);
  });

  it("documents every table in the reference (completeness guarantee)", () => {
    for (const t of introspection.tables) {
      expect(mdx).toContain(`### \`${t.tableName}\``);
    }
  });

  it("renders at least one mermaid ER diagram", () => {
    expect(mdx).toContain("```mermaid");
    expect(mdx).toContain("erDiagram");
  });

  it("escapes pipe characters in column cells so markdown tables stay valid", () => {
    // No raw unescaped pipe should appear inside a SQL type backtick cell.
    const badCell = /\| `[^`]*[^\\]\|[^`]*` \|/;
    expect(badCell.test(mdx)).toBe(false);
  });

  it("emits a do-not-edit banner pointing at the regenerate command", () => {
    expect(mdx).toContain("pnpm crux generate db-schema-docs");
    expect(mdx).toContain("Do not edit manually");
  });
});
