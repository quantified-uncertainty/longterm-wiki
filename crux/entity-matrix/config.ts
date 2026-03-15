/**
 * Entity Completeness Matrix — Configuration
 *
 * Defines all 35 entity/sub-entity types and ~30 dimensions to track.
 * Path mappings enable the filesystem scanner to auto-detect infrastructure.
 */

import type {
  EntityTypeMeta,
  DimensionDef,
  DimensionGroupMeta,
} from "./types.ts";

// ============================================================================
// DIMENSION GROUPS
// ============================================================================

export const DIMENSION_GROUPS: DimensionGroupMeta[] = [
  {
    id: "data-foundation",
    label: "Data Foundation",
    shortLabel: "Data",
  },
  {
    id: "data-pipeline",
    label: "Data Pipeline",
    shortLabel: "Pipeline",
  },
  {
    id: "api",
    label: "API",
    shortLabel: "API",
  },
  {
    id: "ui-discovery",
    label: "UI — Discovery",
    shortLabel: "Discovery",
  },
  {
    id: "ui-detail",
    label: "UI — Detail",
    shortLabel: "Detail",
  },
  {
    id: "content",
    label: "Content",
    shortLabel: "Content",
  },
  {
    id: "quality",
    label: "Quality & Verification",
    shortLabel: "Quality",
  },
  {
    id: "testing",
    label: "Testing",
    shortLabel: "Testing",
  },
];

// ============================================================================
// DIMENSIONS
// ============================================================================

export const DIMENSIONS: DimensionDef[] = [
  // --- Data Foundation ---
  {
    id: "yaml_entity_count",
    label: "YAML Entities",
    group: "data-foundation",
    description: "Count of entities defined in data/entities/*.yaml",
    detection: "filesystem",
    valueType: "count",
    importance: 7,
  },
  {
    id: "build_entity_count",
    label: "Build Entities",
    group: "data-foundation",
    description: "Count of entities in database.json (YAML + MDX-derived)",
    detection: "build-data",
    valueType: "count",
    importance: 7,
  },
  {
    id: "db_record_count",
    label: "DB Records",
    group: "data-foundation",
    description: "Count of records in the wiki-server Postgres database",
    detection: "api",
    valueType: "count",
    importance: 8,
  },
  {
    id: "kb_fact_count",
    label: "KB Facts",
    group: "data-foundation",
    description: "Count of KB fact files in packages/kb/data/things/",
    detection: "filesystem",
    valueType: "count",
    importance: 5,
  },
  {
    id: "db_table_exists",
    label: "DB Table",
    group: "data-foundation",
    description: "Whether a dedicated wiki-server database table exists",
    detection: "filesystem",
    valueType: "boolean",
    importance: 6,
  },
  {
    id: "field_completeness",
    label: "Field Completeness",
    group: "data-foundation",
    description:
      "Percentage of defined YAML fields that are populated across entities",
    detection: "build-data",
    valueType: "percentage",
    importance: 6,
  },
  {
    id: "zod_schema",
    label: "Zod Schema",
    group: "data-foundation",
    description:
      "Whether a type-specific Zod validation schema exists (vs. generic)",
    detection: "filesystem",
    valueType: "enum",
    importance: 4,
  },

  // --- Data Pipeline ---
  {
    id: "build_pipeline",
    label: "Build Pipeline",
    group: "data-pipeline",
    description: "Whether this type is processed in the build-data pipeline",
    detection: "filesystem",
    valueType: "boolean",
    importance: 6,
  },
  {
    id: "type_guard",
    label: "Type Guard",
    group: "data-pipeline",
    description: "Whether an isX() type guard function exists",
    detection: "filesystem",
    valueType: "boolean",
    importance: 3,
  },
  {
    id: "entity_ontology",
    label: "Ontology Entry",
    group: "data-pipeline",
    description:
      "Whether label, icon, colors are defined in entity-ontology.ts",
    detection: "filesystem",
    valueType: "boolean",
    importance: 5,
  },
  {
    id: "db_sync",
    label: "DB Sync",
    group: "data-pipeline",
    description:
      "Whether data is synced to wiki-server DB (not just build-time)",
    detection: "filesystem",
    valueType: "boolean",
    importance: 4,
  },

  // --- API ---
  {
    id: "generic_api",
    label: "Generic API",
    group: "api",
    description:
      "Whether entities are queryable via the generic /entities endpoint",
    detection: "filesystem",
    valueType: "boolean",
    importance: 5,
  },
  {
    id: "dedicated_api_route",
    label: "Dedicated API",
    group: "api",
    description: "Whether a type-specific API route file exists",
    detection: "filesystem",
    valueType: "boolean",
    importance: 6,
  },
  {
    id: "api_search",
    label: "API Search",
    group: "api",
    description: "Whether full-text search works for this type",
    detection: "api",
    valueType: "boolean",
    importance: 5,
  },
  {
    id: "api_filtering",
    label: "API Filtering",
    group: "api",
    description:
      "Level of filter/sort support: none, basic (type filter), rich (dedicated params)",
    detection: "filesystem",
    valueType: "enum",
    importance: 4,
  },

  // --- UI: Discovery ---
  {
    id: "directory_page",
    label: "Directory Page",
    group: "ui-discovery",
    description: "Whether a listing/browse page exists (e.g., /organizations)",
    detection: "filesystem",
    valueType: "boolean",
    importance: 8,
  },
  {
    id: "table_component",
    label: "Table Component",
    group: "ui-discovery",
    description: "Whether a dedicated data table component exists",
    detection: "filesystem",
    valueType: "boolean",
    importance: 7,
  },
  {
    id: "explore_integration",
    label: "Explore Page",
    group: "ui-discovery",
    description:
      "Whether this type appears in the explore/browse grid with badge/icon",
    detection: "filesystem",
    valueType: "boolean",
    importance: 6,
  },
  {
    id: "sidebar_nav",
    label: "Sidebar Nav",
    group: "ui-discovery",
    description: "Whether this type has sidebar navigation entries",
    detection: "filesystem",
    valueType: "boolean",
    importance: 4,
  },

  // --- UI: Detail ---
  {
    id: "profile_route",
    label: "Profile Page",
    group: "ui-detail",
    description:
      "Whether a dedicated detail/profile route exists ([slug] or [id])",
    detection: "filesystem",
    valueType: "boolean",
    importance: 8,
  },
  {
    id: "profile_sections",
    label: "Profile Sections",
    group: "ui-detail",
    description: "Number of specialized UI sections on the profile page",
    detection: "filesystem",
    valueType: "count",
    importance: 5,
  },
  {
    id: "wiki_page_shell",
    label: "Wiki Page Shell",
    group: "ui-detail",
    description: "Whether entities of this type can be viewed via /wiki/E<id>",
    detection: "build-data",
    valueType: "boolean",
    importance: 3,
  },
  {
    id: "infobox",
    label: "InfoBox",
    group: "ui-detail",
    description:
      "Whether the detail page includes an InfoBox with structured metadata",
    detection: "filesystem",
    valueType: "boolean",
    importance: 5,
  },

  // --- Content ---
  {
    id: "mdx_page_count",
    label: "MDX Pages",
    group: "content",
    description: "Number of MDX content pages for this entity type",
    detection: "build-data",
    valueType: "count",
    importance: 8,
  },
  {
    id: "avg_page_length",
    label: "Avg Page Length",
    group: "content",
    description: "Average word count across MDX pages of this type",
    detection: "build-data",
    valueType: "count",
    importance: 4,
  },
  {
    id: "citation_density",
    label: "Citation Density",
    group: "content",
    description: "Average number of citations per page",
    detection: "build-data",
    valueType: "count",
    importance: 5,
  },
  {
    id: "content_freshness",
    label: "Content Freshness",
    group: "content",
    description: "Median days since last edit across pages of this type",
    detection: "build-data",
    valueType: "count",
    importance: 5,
  },

  // --- Quality & Verification ---
  {
    id: "verification_tables",
    label: "Verification Tables",
    group: "quality",
    description: "Whether verification DB tables exist for this data type",
    detection: "filesystem",
    valueType: "boolean",
    importance: 5,
  },
  {
    id: "verification_coverage",
    label: "Verification Coverage",
    group: "quality",
    description: "Percentage of records with non-unchecked verdicts",
    detection: "api",
    valueType: "percentage",
    importance: 6,
  },
  {
    id: "hallucination_scored",
    label: "Hallucination Scored",
    group: "quality",
    description: "Whether hallucination risk has been evaluated for pages",
    detection: "build-data",
    valueType: "boolean",
    importance: 4,
  },

  // --- Testing ---
  {
    id: "test_files",
    label: "Test Files",
    group: "testing",
    description: "Number of test files that cover this entity type",
    detection: "filesystem",
    valueType: "count",
    importance: 6,
  },
  {
    id: "gate_checks",
    label: "Gate Checks",
    group: "testing",
    description: "Whether this type is covered by CI gate validation",
    detection: "filesystem",
    valueType: "boolean",
    importance: 5,
  },
];

// ============================================================================
// ENTITY TYPES
// ============================================================================

export const ENTITY_TYPES: EntityTypeMeta[] = [
  // ---- Canonical Entity Types ----
  {
    id: "risk",
    label: "Risk",
    tier: "canonical",
    directoryRoute: "risks",
    profileRoute: "risks",
    tableComponent: "risks-table",
    yamlFile: "risks",
    contentDir: "knowledge-base/risks",
  },
  {
    id: "risk-factor",
    label: "Risk Factor",
    tier: "canonical",
    yamlFile: "risks",
    contentDir: "knowledge-base/risks",
  },
  {
    id: "capability",
    label: "Capability",
    tier: "canonical",
    yamlFile: "capabilities",
    contentDir: "knowledge-base/capabilities",
  },
  {
    id: "safety-agenda",
    label: "Safety Agenda",
    tier: "canonical",
    yamlFile: "responses",
    contentDir: "knowledge-base/responses",
  },
  {
    id: "approach",
    label: "Approach",
    tier: "canonical",
    yamlFile: "responses",
    contentDir: "knowledge-base/responses",
  },
  {
    id: "project",
    label: "Project",
    tier: "canonical",
    yamlFile: "responses",
    contentDir: "knowledge-base/responses",
  },
  {
    id: "policy",
    label: "Policy",
    tier: "canonical",
    yamlFile: "responses",
    contentDir: "knowledge-base/responses",
  },
  {
    id: "organization",
    label: "Organization",
    tier: "canonical",
    directoryRoute: "organizations",
    profileRoute: "organizations",
    tableComponent: "organizations-table",
    yamlFile: "organizations",
    contentDir: "organizations",
  },
  {
    id: "crux",
    label: "Crux",
    tier: "canonical",
    yamlFile: "concepts",
    contentDir: "knowledge-base/cruxes",
  },
  {
    id: "concept",
    label: "Concept",
    tier: "canonical",
    yamlFile: "concepts",
    contentDir: "knowledge-base",
  },
  {
    id: "case-study",
    label: "Case Study",
    tier: "canonical",
    contentDir: "knowledge-base",
  },
  {
    id: "person",
    label: "Person",
    tier: "canonical",
    directoryRoute: "people",
    profileRoute: "people",
    tableComponent: "people-table",
    apiRouteFile: "people",
    yamlFile: "people",
    contentDir: "people",
  },
  {
    id: "resource",
    label: "Resource",
    tier: "canonical",
    directoryRoute: "resources",
    profileRoute: "resources",
    tableComponent: "resources-table",
    apiRouteFile: "resources",
  },
  {
    id: "historical",
    label: "Historical",
    tier: "canonical",
    yamlFile: "historical",
    contentDir: "knowledge-base/history",
  },
  {
    id: "analysis",
    label: "Analysis",
    tier: "canonical",
    yamlFile: "models",
    contentDir: "knowledge-base/models",
  },
  {
    id: "parameter",
    label: "Parameter",
    tier: "canonical",
  },
  {
    id: "argument",
    label: "Argument",
    tier: "canonical",
  },
  {
    id: "table",
    label: "Table",
    tier: "canonical",
  },
  {
    id: "diagram",
    label: "Diagram",
    tier: "canonical",
  },
  {
    id: "event",
    label: "Event",
    tier: "canonical",
    contentDir: "knowledge-base",
  },
  {
    id: "debate",
    label: "Debate",
    tier: "canonical",
    contentDir: "knowledge-base/debates",
  },
  {
    id: "overview",
    label: "Overview",
    tier: "canonical",
    contentDir: "knowledge-base",
  },
  {
    id: "intelligence-paradigm",
    label: "Intelligence Paradigm",
    tier: "canonical",
    contentDir: "knowledge-base/intelligence-paradigms",
  },
  {
    id: "internal",
    label: "Internal",
    tier: "canonical",
    contentDir: "internal",
  },
  {
    id: "ai-model",
    label: "AI Model",
    tier: "canonical",
    directoryRoute: "ai-models",
    profileRoute: "ai-models",
    tableComponent: "ai-models-table",
    yamlFile: "ai-models",
    dbTable: "things",
  },
  {
    id: "benchmark",
    label: "Benchmark",
    tier: "canonical",
    directoryRoute: "benchmarks",
    profileRoute: "benchmarks",
    tableComponent: "benchmarks-table",
    apiRouteFile: "benchmarks",
    yamlFile: "benchmarks",
    dbTable: "benchmarks",
  },

  // ---- Sub-Entity Types ----
  {
    id: "grant",
    label: "Grant",
    tier: "sub-entity",
    directoryRoute: "grants",
    profileRoute: "grants",
    tableComponent: "grants-table",
    apiRouteFile: "grants",
    dbTable: "grants",
  },
  {
    id: "division",
    label: "Division",
    tier: "sub-entity",
    directoryRoute: "divisions",
    profileRoute: "divisions",
    apiRouteFile: "divisions",
    dbTable: "divisions",
  },
  {
    id: "funding-program",
    label: "Funding Program",
    tier: "sub-entity",
    directoryRoute: "funding-programs",
    profileRoute: "funding-programs",
    tableComponent: "funding-programs-table",
    apiRouteFile: "funding-programs",
    dbTable: "fundingPrograms",
  },
  {
    id: "publication",
    label: "Publication",
    tier: "sub-entity",
    directoryRoute: "publications",
    profileRoute: "publications",
    tableComponent: "publications-table",
    yamlPath: "data/publications.yaml",
    buildDataKey: "publications",
  },
  {
    id: "funding-round",
    label: "Funding Round",
    tier: "sub-entity",
    profileRoute: "funding-rounds",
    apiRouteFile: "funding-rounds",
    dbTable: "fundingRounds",
  },
  {
    id: "investment",
    label: "Investment",
    tier: "sub-entity",
    profileRoute: "investments",
    apiRouteFile: "investments",
    dbTable: "investments",
  },
  {
    id: "equity-position",
    label: "Equity Position",
    tier: "sub-entity",
    apiRouteFile: "equity-positions",
    dbTable: "equityPositions",
  },
  {
    id: "legislation",
    label: "Legislation",
    tier: "sub-entity",
    directoryRoute: "legislation",
    profileRoute: "legislation",
    tableComponent: "legislation-table",
    countsAsType: "policy",
    yamlFile: "responses",
  },
  {
    id: "personnel",
    label: "Personnel",
    tier: "sub-entity",
    apiRouteFile: "personnel",
    dbTable: "personnel",
  },
];

// ============================================================================
// SCORING FUNCTIONS
// ============================================================================

/** Score a count value using threshold breakpoints. */
export function scoreCount(
  value: number,
  thresholds: { yellow: number; green: number },
): number {
  if (value <= 0) return 0;
  if (value < thresholds.yellow) return 30;
  if (value < thresholds.green) return 60;
  return 100;
}

/** Score a boolean value (true = 80, false = 0). Existence is necessary but not sufficient. */
export function scoreBoolean(value: boolean): number {
  return value ? 80 : 0;
}

/** Score a percentage directly (0-100). */
export function scorePercentage(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Score an enum: maps string values to numeric scores. */
export function scoreEnum(
  value: string,
  mapping: Record<string, number>,
): number {
  return mapping[value] ?? 0;
}

/**
 * Scoring configuration for each dimension.
 * Maps dimension IDs to their scoring function.
 */
export function scoreDimension(dimensionId: string, raw: unknown): number {
  switch (dimensionId) {
    // Data Foundation
    case "yaml_entity_count":
      return scoreCount(raw as number, { yellow: 10, green: 50 });
    case "build_entity_count":
      return scoreCount(raw as number, { yellow: 10, green: 50 });
    case "db_record_count":
      return scoreCount(raw as number, { yellow: 10, green: 50 });
    case "kb_fact_count":
      return scoreCount(raw as number, { yellow: 10, green: 30 });
    case "db_table_exists":
      return scoreBoolean(raw as boolean);
    case "field_completeness":
      return scorePercentage(raw as number);
    case "zod_schema":
      return scoreEnum(raw as string, {
        none: 0,
        generic: 40,
        specialized: 100,
      });

    // Data Pipeline
    case "build_pipeline":
    case "type_guard":
    case "entity_ontology":
    case "db_sync":
      return scoreBoolean(raw as boolean);

    // API
    case "generic_api":
    case "dedicated_api_route":
    case "api_search":
      return scoreBoolean(raw as boolean);
    case "api_filtering":
      return scoreEnum(raw as string, { none: 0, basic: 50, rich: 100 });

    // UI: Discovery
    case "directory_page":
    case "table_component":
    case "explore_integration":
    case "sidebar_nav":
      return scoreBoolean(raw as boolean);

    // UI: Detail
    case "profile_route":
      return scoreBoolean(raw as boolean);
    case "profile_sections":
      return scoreCount(raw as number, { yellow: 3, green: 8 });
    case "wiki_page_shell":
    case "infobox":
      return scoreBoolean(raw as boolean);

    // Content
    case "mdx_page_count":
      return scoreCount(raw as number, { yellow: 10, green: 40 });
    case "avg_page_length":
      return scoreCount(raw as number, { yellow: 500, green: 1500 });
    case "citation_density":
      return scoreCount(raw as number, { yellow: 3, green: 8 });
    case "content_freshness":
      // Lower is better: days since edit
      if ((raw as number) <= 0) return 0;
      if ((raw as number) <= 30) return 100;
      if ((raw as number) <= 90) return 70;
      if ((raw as number) <= 180) return 40;
      return 15;

    // Quality
    case "verification_tables":
    case "hallucination_scored":
      return scoreBoolean(raw as boolean);
    case "verification_coverage":
      return scorePercentage(raw as number);

    // Testing
    case "test_files":
      return scoreCount(raw as number, { yellow: 1, green: 3 });
    case "gate_checks":
      return scoreBoolean(raw as boolean);

    default:
      return 0;
  }
}
