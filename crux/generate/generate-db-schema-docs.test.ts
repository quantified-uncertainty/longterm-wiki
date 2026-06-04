import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  parseSections,
  generateMdx,
  normalizeForDiff,
  isStale,
  escapeCell,
  mermaidEntity,
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

  it("still captures exports under a banner that has no closing rule before EOF", () => {
    // Unterminated banner: opening rule + title + description, then exports,
    // and NO closing rule. The exports must not be silently dropped.
    const source = [
      "// ============================================================================",
      "// Unterminated Domain",
      "// description line with no closing rule below",
      'export const a = pgTable("a", {});',
      'export const b = pgTable("b", {});',
    ].join("\n");
    const { exportToSection, order } = parseSections(source);
    expect(exportToSection.get("a")).toBe("Unterminated Domain");
    expect(exportToSection.get("b")).toBe("Unterminated Domain");
    expect(order).toEqual(["Core", "Unterminated Domain"]);
  });
});

// ─── escapeCell / mermaidEntity: injection-relevant escaping ─────────────────

describe("escapeCell", () => {
  it("escapes pipe characters so a name cannot break out of a markdown cell", () => {
    expect(escapeCell("weird|name")).toBe("weird\\|name");
    expect(escapeCell("a|b|c")).toBe("a\\|b\\|c");
  });
  it("leaves pipe-free strings untouched", () => {
    expect(escapeCell("normal_name")).toBe("normal_name");
  });
});

describe("mermaidEntity", () => {
  it("quotes the name and strips embedded double-quotes", () => {
    expect(mermaidEntity("_archived_claims")).toBe('"_archived_claims"');
    expect(mermaidEntity('ev"il')).toBe('"evil"');
  });
});

// ─── isStale: the gate's core comparison ────────────────────────────────────

describe("isStale", () => {
  it("is false when only the lastEdited date differs", () => {
    const base = `---\n${VOLATILE_FRONTMATTER_KEY}: "2026-01-01"\ntitle: x\n---\n| Tables | 5 |`;
    const dated = `---\n${VOLATILE_FRONTMATTER_KEY}: "2030-09-09"\ntitle: x\n---\n| Tables | 5 |`;
    expect(isStale(base, dated)).toBe(false);
  });
  it("is true when the body content differs", () => {
    const a = `${VOLATILE_FRONTMATTER_KEY}: "2026-01-01"\n| Tables | 5 |`;
    const b = `${VOLATILE_FRONTMATTER_KEY}: "2026-01-01"\n| Tables | 6 |`;
    expect(isStale(a, b)).toBe(true);
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

  it("annotates non-default FK on-delete behavior in the reference", () => {
    const onDeleteFk = introspection.tables
      .flatMap((t) => t.foreignKeys)
      .find((fk) => fk.onDelete && fk.onDelete !== "no action");
    // The real schema has on-delete FKs; if that ever stops being true the
    // assertion is vacuous, so guard it.
    if (onDeleteFk) {
      expect(mdx).toContain(`*(on delete ${onDeleteFk.onDelete})*`);
    }
  });

  it("renders an empty entity box for a table with no primary key", () => {
    const noPk = introspection.tables.find((t) => t.primaryKeyColumns.length === 0);
    if (noPk) {
      // Empty box: the quoted entity name followed immediately by `{` then `}`.
      expect(mdx).toContain(`${mermaidEntity(noPk.tableName)} {`);
      // And it must not have invented a fake PK row for it.
      expect(mdx).not.toContain(`_ _ "no PK"`);
    }
  });
});
