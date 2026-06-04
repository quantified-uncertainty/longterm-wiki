#!/usr/bin/env npx tsx
/**
 * Generate the Database Schema Reference page from the live Drizzle schema.
 *
 * Reads `apps/wiki-server/src/schema.ts` via `introspectSchema()` and emits a
 * complete, always-fresh MDX reference at
 * `content/docs/internal/db-schema-reference.mdx`:
 *   - summary counts (tables / columns / FKs / views)
 *   - per-section Mermaid ER (relationship) diagrams
 *   - a complete table inventory + every column + every foreign key
 *
 * The output is byte-stable for a given schema (everything is sorted, no
 * timestamps in the body) so `validate-generated-db-docs.ts` can diff it in CI
 * and fail the gate if someone changes the schema without regenerating. That
 * drift gate is the whole point: the hand-written `db-schema-overview.mdx`
 * drifted to "42 tables" while the schema grew to 114 — a generated page that
 * the gate keeps honest cannot.
 *
 * Usage:
 *   pnpm crux generate db-schema-docs            # write the page
 *   pnpm crux generate db-schema-docs --check    # exit 1 if the page is stale
 *   pnpm crux generate db-schema-docs --stdout   # print, don't write
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  introspectSchema,
  type SchemaIntrospection,
  type TableInfo,
} from "../../apps/wiki-server/src/schema-introspect.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SCHEMA_PATH = join(ROOT, "apps/wiki-server/src/schema.ts");
const OUTPUT_PATH = join(ROOT, "content/docs/internal/db-schema-reference.mdx");

const WIKI_ID = "E2581";
/** Frontmatter line ignored when diffing for staleness (it carries a date). */
export const VOLATILE_FRONTMATTER_KEY = "lastEdited";

const DEFAULT_SECTION = "Core";

interface SectionMap {
  /** export identifier → section title. */
  exportToSection: Map<string, string>;
  /** Section titles in source-appearance order. */
  order: string[];
}

const isRuleLine = (l: string | undefined) => !!l && /^\/\/\s*={10,}\s*$/.test(l);

/**
 * Map each `export const <name> = pgTable(...)` to a section, derived from the
 * nearest preceding banner comment in the source. Banners are
 * `// ====` then a title comment then (after any description lines) `// ====`.
 * The title is the first comment line after the opening rule; everything up to
 * the closing rule is skipped. Tables declared before the first banner fall
 * under {@link DEFAULT_SECTION}.
 */
export function parseSections(source: string): SectionMap {
  const lines = source.split("\n");
  const exportToSection = new Map<string, string>();
  const order: string[] = [DEFAULT_SECTION];
  let currentSection = DEFAULT_SECTION;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isRuleLine(line)) {
      const titleMatch = lines[i + 1]?.match(/^\/\/\s*(.+?)\s*$/);
      if (titleMatch && !isRuleLine(lines[i + 1])) {
        currentSection = titleMatch[1];
        if (!order.includes(currentSection)) order.push(currentSection);
        // Skip the description block up to the closing rule.
        let j = i + 2;
        while (j < lines.length && !isRuleLine(lines[j])) j++;
        i = j;
        continue;
      }
    }

    const exportMatch = line.match(/^export const (\w+)\s*=\s*pgTable\(/);
    if (exportMatch) {
      exportToSection.set(exportMatch[1], currentSection);
    }
  }

  return { exportToSection, order };
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/**
 * A quoted Mermaid entity name. Quoting (rather than a bare identifier) keeps
 * leading-underscore names like `_archived_claims` valid under Mermaid's strict
 * ER parser, and isolates the diagram from any character in a table name.
 */
function mermaidEntity(name: string): string {
  return `"${name.replace(/"/g, "")}"`;
}

function buildErDiagram(tables: TableInfo[]): string {
  const lines: string[] = ["erDiagram"];

  // Entity boxes: PK columns only — full columns live in the reference tables.
  for (const t of tables) {
    if (t.primaryKeyColumns.length === 0) {
      // No primary key — render an empty entity box.
      lines.push(`  ${mermaidEntity(t.tableName)} {`);
      lines.push("  }");
      continue;
    }
    lines.push(`  ${mermaidEntity(t.tableName)} {`);
    for (const pk of t.primaryKeyColumns) {
      const col = t.columns.find((c) => c.name === pk);
      const type = (col?.sqlType ?? "unknown").replace(/[^A-Za-z0-9]/g, "_");
      lines.push(`    ${type} ${pk} PK`);
    }
    lines.push("  }");
  }

  // Relationships: many (FK side) to one (referenced side).
  const edges: string[] = [];
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const label = fk.columns.join(",").replace(/"/g, "");
      edges.push(
        `  ${mermaidEntity(t.tableName)} }o--|| ${mermaidEntity(fk.refTable)} : "${label}"`
      );
    }
  }
  edges.sort();
  lines.push(...edges);

  return lines.join("\n");
}

function buildTableReference(t: TableInfo, section: string): string {
  const out: string[] = [];
  out.push(`### \`${t.tableName}\``);
  out.push("");
  out.push(`Export: \`${t.exportName}\` · Section: ${section} · ${t.columns.length} columns`);
  out.push("");
  out.push("| Column | Type | Null | Key | Default |");
  out.push("|--------|------|------|-----|---------|");
  for (const c of t.columns) {
    const key = c.primaryKey
      ? "PK"
      : t.foreignKeys.some((fk) => fk.columns.includes(c.name))
        ? "FK"
        : "";
    out.push(
      `| ${escapeCell(c.name)} | \`${escapeCell(c.sqlType)}\` | ${c.notNull ? "NOT NULL" : "null"} | ${key} | ${c.hasDefault ? "yes" : ""} |`
    );
  }
  if (t.foreignKeys.length > 0) {
    out.push("");
    const fkLines = t.foreignKeys
      .map(
        (fk) =>
          `\`${fk.columns.join(", ")}\` → \`${fk.refTable}(${fk.refColumns.join(", ")})\`${fk.onDelete && fk.onDelete !== "no action" ? ` *(on delete ${fk.onDelete})*` : ""}`
      )
      .sort();
    out.push(`**Foreign keys:** ${fkLines.join("; ")}`);
  }
  out.push("");
  return out.join("\n");
}

export function generateMdx(
  introspection: SchemaIntrospection,
  source: string,
  lastEdited: string
): string {
  const { tables, otherExports } = introspection;
  const { exportToSection, order: sections } = parseSections(source);

  const sectionFor = (t: TableInfo) => exportToSection.get(t.exportName) ?? DEFAULT_SECTION;

  const totalColumns = tables.reduce((s, t) => s + t.columns.length, 0);
  const totalFks = tables.reduce((s, t) => s + t.foreignKeys.length, 0);

  // Group tables by section, preserving section appearance order.
  const bySection = new Map<string, TableInfo[]>();
  for (const t of tables) {
    const sec = sectionFor(t);
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec)!.push(t);
  }
  const orderedSections = [
    ...sections.filter((s) => bySection.has(s)),
    ...[...bySection.keys()].filter((s) => !sections.includes(s)).sort(),
  ];

  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push(`wikiId: ${WIKI_ID}`);
  lines.push(`title: "Database Schema Reference"`);
  lines.push(
    `description: "Auto-generated, complete reference for the wiki-server PostgreSQL schema — every table, column, and foreign key, derived from schema.ts."`
  );
  lines.push("subcategory: architecture");
  lines.push("contentFormat: article");
  lines.push(`${VOLATILE_FRONTMATTER_KEY}: "${lastEdited}"`);
  lines.push("---");
  lines.push("");
  lines.push("{/* Auto-generated by: pnpm crux generate db-schema-docs */}");
  lines.push("{/* Do not edit manually — regenerate with the command above. The gate fails if this drifts from schema.ts. */}");
  lines.push("");
  lines.push(
    "This page is generated directly from the Drizzle schema in `apps/wiki-server/src/schema.ts`. It is the **complete** inventory of the wiki-server database — every table, column, and foreign key. For curated narrative (table purposes, migration history, the three-bases mental model) see [Database Schema Overview](/internal/db-schema-overview). Run `pnpm crux generate db-schema-docs` to regenerate; the validation gate fails if this page falls out of sync with the schema."
  );
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push(`| Tables | ${tables.length} |`);
  lines.push(`| Columns | ${totalColumns} |`);
  lines.push(`| Foreign keys | ${totalFks} |`);
  lines.push(`| Materialized views / views | ${otherExports.length} |`);
  lines.push(`| Sections | ${orderedSections.length} |`);
  lines.push("");

  // ER diagrams per section
  lines.push("## Entity-Relationship Diagrams");
  lines.push("");
  lines.push(
    "One diagram per schema section. Boxes show primary keys only (full columns are in the Table Reference below); edges are foreign keys, drawn from the referencing table (many) to the referenced table (one). A referenced table may appear in a section it does not belong to when crossed by a foreign key."
  );
  lines.push("");
  for (const sec of orderedSections) {
    const secTables = bySection.get(sec)!;
    lines.push(`### ${sec}`);
    lines.push("");
    lines.push(`${secTables.length} table${secTables.length === 1 ? "" : "s"}.`);
    lines.push("");
    lines.push("```mermaid");
    lines.push(buildErDiagram(secTables));
    lines.push("```");
    lines.push("");
  }

  // Complete table reference (alphabetical — tables already sorted by name)
  lines.push("## Table Reference");
  lines.push("");
  lines.push("Every table, alphabetically, with all columns and foreign keys.");
  lines.push("");
  for (const t of tables) {
    lines.push(buildTableReference(t, sectionFor(t)));
  }

  // Views
  if (otherExports.length > 0) {
    lines.push("## Materialized Views & Views");
    lines.push("");
    lines.push("| Object | Export | Kind |");
    lines.push("|--------|--------|------|");
    for (const v of otherExports) {
      lines.push(`| \`${v.objectName}\` | \`${v.exportName}\` | ${v.kind} |`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

/** Strip the volatile lastEdited line so two generations of the same schema compare equal. */
export function normalizeForDiff(mdx: string): string {
  return mdx
    .split("\n")
    .filter((l) => !l.startsWith(`${VOLATILE_FRONTMATTER_KEY}:`))
    .join("\n");
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const stdout = args.includes("--stdout");

  const introspection = introspectSchema();
  const source = readFileSync(SCHEMA_PATH, "utf8");

  if (check) {
    let existing = "";
    try {
      existing = readFileSync(OUTPUT_PATH, "utf8");
    } catch {
      console.error(`✗ ${OUTPUT_PATH} does not exist. Run: pnpm crux generate db-schema-docs`);
      process.exit(1);
    }
    // Reuse the existing lastEdited so only structural drift is detected.
    const existingDate =
      existing.match(new RegExp(`^${VOLATILE_FRONTMATTER_KEY}: "(.+?)"`, "m"))?.[1] ?? todayIso();
    const fresh = generateMdx(introspection, source, existingDate);
    if (normalizeForDiff(fresh) !== normalizeForDiff(existing)) {
      console.error(
        "✗ db-schema-reference.mdx is out of date with schema.ts.\n  Regenerate with: pnpm crux generate db-schema-docs"
      );
      process.exit(1);
    }
    console.log("✓ db-schema-reference.mdx is in sync with schema.ts");
    return;
  }

  const mdx = generateMdx(introspection, source, todayIso());
  if (stdout) {
    process.stdout.write(mdx);
    return;
  }
  writeFileSync(OUTPUT_PATH, mdx);
  console.log(
    `✓ Wrote ${OUTPUT_PATH}\n  ${introspection.tables.length} tables, ${introspection.tables.reduce((s, t) => s + t.columns.length, 0)} columns, ${introspection.tables.reduce((s, t) => s + t.foreignKeys.length, 0)} foreign keys`
  );
}

const invokedDirectly =
  import.meta.url.startsWith("file://") && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main();
}
