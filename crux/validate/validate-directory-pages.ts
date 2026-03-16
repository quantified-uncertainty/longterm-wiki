#!/usr/bin/env node

/**
 * Directory Page Validator
 *
 * Checks each entity-type directory page's data for display issues:
 *   - Flags directories with very few entries (<5) as sparse
 *   - Flags entities where IDs/slugs appear as visible display text
 *   - Flags entities missing key fields (title, type-specific fields)
 *   - Reports inconsistent status/date formatting
 *   - Reports summary stats per directory
 *
 * Usage:
 *   npx tsx crux/validate/validate-directory-pages.ts              # advisory mode
 *   npx tsx crux/validate/validate-directory-pages.ts --verbose     # show all issues
 *   npx tsx crux/validate/validate-directory-pages.ts --ci          # JSON output
 *   npx tsx crux/validate/validate-directory-pages.ts --type=person # check one type
 */

import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { PROJECT_ROOT, ensureDataLayer } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DirectoryConfig {
  entityType: string;
  route: string;
  label: string;
  keyFields: string[];
  displayFields: string[];
}

interface EntityIssue {
  entityId: string;
  entityTitle: string;
  issueType: "slug-in-display" | "missing-field" | "title-is-slug" | "bad-date-format";
  field: string;
  value?: string;
  detail: string;
}

interface DirectoryResult {
  entityType: string;
  route: string;
  label: string;
  totalEntries: number;
  sparse: boolean;
  issues: EntityIssue[];
  fieldCoverage: Record<string, { filled: number; total: number }>;
}

// ---------------------------------------------------------------------------
// Directory definitions
// ---------------------------------------------------------------------------

const DIRECTORY_CONFIGS: DirectoryConfig[] = [
  {
    entityType: "organization",
    route: "/organizations",
    label: "Organizations",
    keyFields: ["title", "description", "orgType"],
    displayFields: ["title", "parentOrg"],
  },
  {
    entityType: "person",
    route: "/people",
    label: "People",
    keyFields: ["title", "role", "affiliation"],
    displayFields: ["title", "affiliation"],
  },
  {
    entityType: "ai-model",
    route: "/ai-models",
    label: "AI Models",
    keyFields: ["title", "developer"],
    displayFields: ["title", "developer", "modelFamily"],
  },
  {
    entityType: "benchmark",
    route: "/benchmarks",
    label: "Benchmarks",
    keyFields: ["title", "category"],
    displayFields: ["title", "maintainer"],
  },
  {
    entityType: "policy",
    route: "/legislation",
    label: "Legislation",
    keyFields: ["title", "policyStatus"],
    displayFields: ["title", "author", "jurisdiction"],
  },
  {
    entityType: "project",
    route: "/projects",
    label: "Projects",
    keyFields: ["title", "description"],
    displayFields: ["title", "organization"],
  },
  {
    entityType: "approach",
    route: "/approaches",
    label: "Approaches",
    keyFields: ["title", "description"],
    displayFields: ["title"],
  },
  {
    entityType: "event",
    route: "/events",
    label: "Events",
    keyFields: ["title", "description"],
    displayFields: ["title"],
  },
  {
    entityType: "research-area",
    route: "/research-areas",
    label: "Research Areas",
    keyFields: ["title", "description"],
    displayFields: ["title"],
  },
];

// ---------------------------------------------------------------------------
// Slug detection
// ---------------------------------------------------------------------------

const SLUG_EXCEPTIONS = new Set([
  "o1-preview", "o1-mini", "o3-mini", "o4-mini",
]);

function looksLikeSlug(value: string): boolean {
  if (SLUG_EXCEPTIONS.has(value)) return false;
  if (/\s/.test(value)) return false;
  if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(value)) return false;
  const parts = value.split("-");
  return parts.length >= 3 && parts.every((p) => p.length >= 2);
}

// ---------------------------------------------------------------------------
// Date format checking
// ---------------------------------------------------------------------------

function isReasonableDateFormat(value: string): boolean {
  if (/^\d{4}(-\d{2})?(-\d{2})?$/.test(value)) return true;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const ci = process.argv.includes("--ci");
  const c = getColors(ci);

  const typeArg = process.argv.find((a) => a.startsWith("--type="));
  const filterType = typeArg ? typeArg.split("=")[1] : null;

  ensureDataLayer();

  const dbPath = join(PROJECT_ROOT, "apps/web/src/data/database.json");
  if (!existsSync(dbPath)) {
    console.error(c.red + "database.json not found. Run: pnpm build-data" + c.reset);
    process.exit(1);
  }

  const db = JSON.parse(readFileSync(dbPath, "utf-8"));
  const typedEntities: Record<string, unknown>[] = db.typedEntities || [];

  if (typedEntities.length === 0) {
    console.error(c.red + "No typedEntities in database.json." + c.reset);
    process.exit(1);
  }

  const entitiesByType = new Map<string, Record<string, unknown>[]>();
  for (const entity of typedEntities) {
    const type = entity.entityType as string;
    if (!entitiesByType.has(type)) {
      entitiesByType.set(type, []);
    }
    entitiesByType.get(type)!.push(entity);
  }

  const entityTitleById = new Map<string, string>();
  for (const entity of typedEntities) {
    entityTitleById.set(entity.id as string, entity.title as string);
  }

  const configs = filterType
    ? DIRECTORY_CONFIGS.filter((d) => d.entityType === filterType)
    : DIRECTORY_CONFIGS;

  if (filterType && configs.length === 0) {
    console.error(c.red + "Unknown entity type: " + filterType + c.reset);
    console.error("Valid types: " + DIRECTORY_CONFIGS.map((d) => d.entityType).join(", "));
    process.exit(1);
  }

  const results: DirectoryResult[] = [];

  for (const config of configs) {
    const entities = entitiesByType.get(config.entityType) || [];
    const issues: EntityIssue[] = [];
    const fieldCoverage: Record<string, { filled: number; total: number }> = {};

    for (const field of config.keyFields) {
      fieldCoverage[field] = { filled: 0, total: entities.length };
    }

    for (const entity of entities) {
      const id = entity.id as string;
      const title = entity.title as string;

      // Check 1: Title looks like an unresolved slug
      if (looksLikeSlug(title)) {
        issues.push({
          entityId: id,
          entityTitle: title,
          issueType: "title-is-slug",
          field: "title",
          value: title,
          detail: "Title \"" + title + "\" looks like an unresolved slug",
        });
      }

      // Check 2: Key fields missing
      for (const field of config.keyFields) {
        const value = entity[field];
        if (value !== undefined && value !== null && value !== "") {
          fieldCoverage[field].filled++;
        } else if (field !== "title") {
          issues.push({
            entityId: id,
            entityTitle: title,
            issueType: "missing-field",
            field,
            detail: "Missing " + field,
          });
        }
      }

      // Check 3: Display fields contain slug-like values
      for (const field of config.displayFields) {
        if (field === "title") continue;
        const value = entity[field];
        if (typeof value === "string" && looksLikeSlug(value)) {
          const resolvedTitle = entityTitleById.get(value);
          issues.push({
            entityId: id,
            entityTitle: title,
            issueType: "slug-in-display",
            field,
            value,
            detail: resolvedTitle
              ? field + " shows slug \"" + value + "\" instead of \"" + resolvedTitle + "\""
              : field + " contains slug-like value \"" + value + "\"",
          });
        }
      }

      // Check 4: Date field formatting
      const dateFields = ["lastUpdated", "founded", "introduced", "releaseDate", "startDate"];
      for (const field of dateFields) {
        const value = entity[field];
        if (typeof value === "string" && value.length > 0 && !isReasonableDateFormat(value)) {
          issues.push({
            entityId: id,
            entityTitle: title,
            issueType: "bad-date-format",
            field,
            value,
            detail: field + " has non-standard format: \"" + value + "\"",
          });
        }
      }
    }

    results.push({
      entityType: config.entityType,
      route: config.route,
      label: config.label,
      totalEntries: entities.length,
      sparse: entities.length < 5,
      issues,
      fieldCoverage,
    });
  }

  // ── Output ──────────────────────────────────────────────────────

  if (ci) {
    const summary = {
      totalDirectories: results.length,
      totalEntities: results.reduce((s, r) => s + r.totalEntries, 0),
      totalIssues: results.reduce((s, r) => s + r.issues.length, 0),
      sparseDirectories: results.filter((r) => r.sparse).map((r) => r.entityType),
      directories: results.map((r) => ({
        entityType: r.entityType,
        route: r.route,
        entries: r.totalEntries,
        sparse: r.sparse,
        issues: r.issues.length,
        issuesByType: {
          slugInDisplay: r.issues.filter((i) => i.issueType === "slug-in-display").length,
          missingField: r.issues.filter((i) => i.issueType === "missing-field").length,
          titleIsSlug: r.issues.filter((i) => i.issueType === "title-is-slug").length,
          badDateFormat: r.issues.filter((i) => i.issueType === "bad-date-format").length,
        },
        fieldCoverage: r.fieldCoverage,
      })),
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // Human-readable output
  console.log("\n" + c.bold + c.blue + "Directory Page Audit" + c.reset + "\n");
  console.log(c.dim + "Checking " + results.length + " directory pages across " + typedEntities.length + " entities" + c.reset + "\n");

  const header = [
    "Directory".padEnd(18),
    "Entries".padStart(7),
    "Sparse?".padEnd(8),
    "Slug Display".padStart(12),
    "Missing Fld".padStart(11),
    "Title=Slug".padStart(10),
    "Bad Date".padStart(8),
  ];
  console.log(header.join(" | "));
  console.log("-".repeat(header.join(" | ").length));

  let totalIssues = 0;
  for (const r of results) {
    const slugIssues = r.issues.filter((i) => i.issueType === "slug-in-display").length;
    const missingIssues = r.issues.filter((i) => i.issueType === "missing-field").length;
    const titleSlugIssues = r.issues.filter((i) => i.issueType === "title-is-slug").length;
    const dateIssues = r.issues.filter((i) => i.issueType === "bad-date-format").length;
    totalIssues += r.issues.length;

    const sparseLabel = r.sparse ? c.yellow + "YES" + c.reset : "no";

    const fmtCount = (n: number, width: number) => {
      const s = n.toString().padStart(width);
      return n > 0 ? c.yellow + s + c.reset : c.dim + s + c.reset;
    };

    const cols = [
      r.label.padEnd(18),
      r.totalEntries.toString().padStart(7),
      r.sparse ? sparseLabel.padEnd(8 + (sparseLabel.length - 3)) : "no".padEnd(8),
      fmtCount(slugIssues, 12),
      fmtCount(missingIssues, 11),
      fmtCount(titleSlugIssues, 10),
      fmtCount(dateIssues, 8),
    ];
    console.log(cols.join(" | "));
  }

  // Field coverage section
  console.log("\n" + c.bold + "Field Coverage" + c.reset + "\n");
  for (const r of results) {
    const coverageItems: string[] = [];
    for (const [field, stats] of Object.entries(r.fieldCoverage)) {
      const pct = stats.total > 0 ? ((stats.filled / stats.total) * 100).toFixed(0) : "N/A";
      const color = stats.total > 0 && stats.filled / stats.total < 0.5 ? c.yellow : c.dim;
      coverageItems.push(field + ": " + color + stats.filled + "/" + stats.total + " (" + pct + "%)" + c.reset);
    }
    console.log("  " + c.cyan + r.label + c.reset + ": " + coverageItems.join(", "));
  }

  // Sparse directories warning
  const sparseResults = results.filter((r) => r.sparse);
  if (sparseResults.length > 0) {
    console.log("\n" + c.yellow + "Sparse directories (<5 entries):" + c.reset);
    for (const r of sparseResults) {
      console.log("  " + c.yellow + "!" + c.reset + " " + r.label + " (" + r.route + "): " + r.totalEntries + " entries");
    }
  }

  // Detailed issues
  const displayIssues = results.flatMap((r) =>
    r.issues.filter((i) => i.issueType === "slug-in-display" || i.issueType === "title-is-slug")
  );

  if (displayIssues.length > 0) {
    console.log("\n" + c.yellow + "Display Issues (slugs visible to users):" + c.reset);
    const toShow = verbose ? displayIssues : displayIssues.slice(0, 20);
    for (const issue of toShow) {
      console.log("  " + c.yellow + "!" + c.reset + " " + issue.entityTitle + " (" + issue.entityId + "): " + issue.detail);
    }
    if (!verbose && displayIssues.length > 20) {
      console.log("  " + c.dim + "... and " + (displayIssues.length - 20) + " more (use --verbose to see all)" + c.reset);
    }
  }

  // Date format issues
  const dateIssues = results.flatMap((r) =>
    r.issues.filter((i) => i.issueType === "bad-date-format")
  );
  if (dateIssues.length > 0 && verbose) {
    console.log("\n" + c.yellow + "Date Format Issues:" + c.reset);
    for (const issue of dateIssues) {
      console.log("  " + c.yellow + "!" + c.reset + " " + issue.entityTitle + ": " + issue.detail);
    }
  }

  // Summary
  const sep = "──────────────────────────────────────────────────";
  console.log("\n" + sep);
  console.log("Directories checked:  " + results.length);
  console.log("Total entities:       " + results.reduce((s, r) => s + r.totalEntries, 0));
  if (totalIssues === 0) {
    console.log(c.green + "No issues found." + c.reset);
  } else {
    console.log("Total issues:         " + c.yellow + totalIssues + c.reset);
    console.log("  Slug in display:    " + results.reduce((s, r) => s + r.issues.filter((i) => i.issueType === "slug-in-display").length, 0));
    console.log("  Missing key field:  " + results.reduce((s, r) => s + r.issues.filter((i) => i.issueType === "missing-field").length, 0));
    console.log("  Title is slug:      " + results.reduce((s, r) => s + r.issues.filter((i) => i.issueType === "title-is-slug").length, 0));
    console.log("  Bad date format:    " + results.reduce((s, r) => s + r.issues.filter((i) => i.issueType === "bad-date-format").length, 0));
  }
  console.log("");
}

main().catch((err) => {
  console.error("Directory page validation crashed:", err);
  process.exit(1);
});
