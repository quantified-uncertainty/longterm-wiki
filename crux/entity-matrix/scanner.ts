/**
 * Entity Completeness Matrix — Scanner
 *
 * Introspects the codebase to detect what infrastructure exists
 * for each entity type. Combines filesystem scanning, build-data
 * analysis, and (optionally) API queries.
 */

import { existsSync, readdirSync, readFileSync, statSync, globSync } from "fs";
import { join, basename } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { ENTITY_TYPES, DIMENSIONS, DIMENSION_GROUPS, scoreDimension } from "./config.ts";
import { apiRequest, type ApiResult } from "../lib/wiki-server/client.ts";
import type {
  CellValue,
  EntityTypeMeta,
  EntityTypeRow,
  MatrixSnapshot,
} from "./types.ts";

// ============================================================================
// PATH CONSTANTS
// ============================================================================

const APP_DIR = join(PROJECT_ROOT, "apps/web/src");
const APP_ROUTES = join(APP_DIR, "app");
const COMPONENTS_DIR = join(APP_DIR, "components");
const DATA_DIR = join(APP_DIR, "data");
const WIKI_SERVER_ROUTES = join(
  PROJECT_ROOT,
  "apps/wiki-server/src/routes",
);
const YAML_ENTITIES_DIR = join(PROJECT_ROOT, "data/entities");
const KB_THINGS_DIR = join(PROJECT_ROOT, "packages/kb/data/things");
const CONTENT_DIR = join(PROJECT_ROOT, "content/docs");

// ============================================================================
// CACHED FILE CONTENTS
// ============================================================================

let _entitySchemasContent: string | null = null;
function getEntitySchemasContent(): string {
  if (!_entitySchemasContent) {
    const schemaPath = join(DATA_DIR, "entity-schemas.ts");
    _entitySchemasContent = existsSync(schemaPath)
      ? readFileSync(schemaPath, "utf-8")
      : "";
  }
  return _entitySchemasContent;
}

let _entityOntologyContent: string | null = null;
function getEntityOntologyContent(): string {
  if (!_entityOntologyContent) {
    const ontPath = join(DATA_DIR, "entity-ontology.ts");
    _entityOntologyContent = existsSync(ontPath)
      ? readFileSync(ontPath, "utf-8")
      : "";
  }
  return _entityOntologyContent;
}

let _wikiNavContent: string | null = null;
function getWikiNavContent(): string {
  if (!_wikiNavContent) {
    const navPath = join(APP_DIR, "lib/wiki-nav.ts");
    _wikiNavContent = existsSync(navPath)
      ? readFileSync(navPath, "utf-8")
      : "";
  }
  return _wikiNavContent;
}

let _wikiServerSchemaContent: string | null = null;
function getWikiServerSchemaContent(): string {
  if (!_wikiServerSchemaContent) {
    const schemaPath = join(
      PROJECT_ROOT,
      "apps/wiki-server/src/schema.ts",
    );
    _wikiServerSchemaContent = existsSync(schemaPath)
      ? readFileSync(schemaPath, "utf-8")
      : "";
  }
  return _wikiServerSchemaContent;
}

// ============================================================================
// WIKI-SERVER DB STATS (cached, optional)
// ============================================================================

interface DbStats {
  entityCounts: Record<string, number>;  // entityType → count from entities table
  tableCounts: Record<string, number>;   // table name → count (grants, personnel, etc.)
}

let _dbStats: DbStats | null | undefined = undefined; // undefined = not fetched yet
async function fetchDbStats(): Promise<DbStats | null> {
  if (_dbStats !== undefined) return _dbStats;

  try {
    const entityResult = await apiRequest<{ total: number; byType: Record<string, number> }>(
      "GET", "/api/entities/stats",
    );

    const entityCounts: Record<string, number> = {};
    if (entityResult.ok) {
      Object.assign(entityCounts, entityResult.data.byType);
    }

    // Fetch sub-entity table counts
    const tableCounts: Record<string, number> = {};
    const subEntityEndpoints = [
      { route: "/api/grants", key: "grants" },
      { route: "/api/personnel", key: "personnel" },
      { route: "/api/divisions", key: "divisions" },
      { route: "/api/funding-rounds", key: "fundingRounds" },
      { route: "/api/investments", key: "investments" },
      { route: "/api/equity-positions", key: "equityPositions" },
      { route: "/api/funding-programs", key: "fundingPrograms" },
      { route: "/api/benchmarks", key: "benchmarks" },
    ];

    await Promise.all(
      subEntityEndpoints.map(async ({ route, key }) => {
        const result = await apiRequest<{ total: number }>("GET", `${route}/stats`);
        if (result.ok && typeof result.data.total === "number") {
          tableCounts[key] = result.data.total;
        }
      }),
    );

    _dbStats = { entityCounts, tableCounts };
    return _dbStats;
  } catch (e) {
    console.warn(`  entity-matrix: wiki-server unavailable for DB stats: ${e instanceof Error ? e.message : String(e)}`);
    _dbStats = null;
    return null;
  }
}

// ============================================================================
// YAML PARSING (lightweight — no external dep)
// ============================================================================

interface YamlEntity {
  slug?: string;
  entityType?: string;
  type?: string;
  [key: string]: unknown;
}

function parseYamlEntities(filePath: string): YamlEntity[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  // Simple YAML array parsing: each "- slug:" starts a new entity
  const entities: YamlEntity[] = [];
  let current: Record<string, unknown> | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("- ")) {
      if (current) entities.push(current);
      current = {};
      const kvMatch = trimmed.slice(2).match(/^(\w[\w-]*):\s*(.*)$/);
      if (kvMatch) {
        current[kvMatch[1]] = kvMatch[2].replace(/^["']|["']$/g, "");
      }
    } else if (current && trimmed.match(/^\w[\w-]*:/)) {
      const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kvMatch) {
        const val = kvMatch[2].replace(/^["']|["']$/g, "");
        current[kvMatch[1]] = val === "" ? null : val;
      }
    }
  }
  if (current) entities.push(current);
  return entities;
}

// ============================================================================
// DATABASE.JSON LOADING (optional — for build-data dimensions)
// ============================================================================

interface DatabaseJson {
  typedEntities?: Array<{
    id: string;
    slug?: string;
    entityType: string;
    numericId?: string;
    [key: string]: unknown;
  }>;
  pages?: Array<{
    numericId?: string;
    title?: string;
    entityType?: string;
    wordCount?: number;
    quality?: number;
    hallucinationRisk?: { level?: string; score?: number } | number;
    lastUpdated?: string;
    filePath?: string;
    citationHealth?: { total?: number; withQuotes?: number; accuracyChecked?: number; avgScore?: number | null };
    footnoteCount?: number;
    [key: string]: unknown;
  }>;
}

let _databaseJson: DatabaseJson | null = null;
function getDatabaseJson(): DatabaseJson | null {
  if (_databaseJson !== null) return _databaseJson;
  const dbPath = join(APP_DIR, "data/database.json");
  if (!existsSync(dbPath)) {
    _databaseJson = {} as DatabaseJson;
    return null;
  }
  try {
    _databaseJson = JSON.parse(readFileSync(dbPath, "utf-8"));
    return _databaseJson;
  } catch {
    _databaseJson = {} as DatabaseJson;
    return null;
  }
}

// ============================================================================
// DIMENSION SCANNERS
// ============================================================================

type DimensionScanner = (
  meta: EntityTypeMeta,
) => CellValue | Promise<CellValue>;

function naCell(details?: string): CellValue {
  return { raw: null, score: -1, details: details ?? "N/A" };
}

function cell(raw: number | boolean | string | null, dimensionId: string, details?: string): CellValue {
  return {
    raw,
    score: raw === null ? -1 : scoreDimension(dimensionId, raw),
    details,
  };
}

// --- Data Foundation ---

function scanYamlEntityCount(meta: EntityTypeMeta): CellValue {
  if (!meta.yamlFile) return naCell("No YAML file mapped");

  const filePath = join(YAML_ENTITIES_DIR, `${meta.yamlFile}.yaml`);
  const entities = parseYamlEntities(filePath);

  // Filter by type field matching this entity type
  const matching = entities.filter((e) => {
    const type = (e.type as string) || "";
    return type === meta.id;
  });

  // If the YAML file is single-type (same name as entity type), count all
  const isSingleTypeFile = meta.yamlFile === meta.id ||
    meta.yamlFile === meta.id + "s" ||
    meta.yamlFile === meta.id.replace(/-/g, "");
  const count = matching.length > 0
    ? matching.length
    : isSingleTypeFile
      ? entities.length
      : 0;
  return cell(count, "yaml_entity_count", `${count} in ${meta.yamlFile}.yaml`);
}

function scanBuildEntityCount(meta: EntityTypeMeta): CellValue {
  const db = getDatabaseJson();
  if (!db?.typedEntities) return naCell("database.json not available");

  const count = db.typedEntities.filter(
    (e: { entityType: string }) => e.entityType === meta.id,
  ).length;

  return cell(count, "build_entity_count", `${count} entities in database.json`);
}

async function scanDbRecordCount(meta: EntityTypeMeta): Promise<CellValue> {
  const stats = await fetchDbStats();
  if (!stats) return naCell("Wiki-server unavailable");

  // Canonical types → entities table (by entityType)
  if (meta.tier === "canonical") {
    const count = stats.entityCounts[meta.id] ?? 0;
    return cell(count, "db_record_count", `${count} rows in entities table`);
  }

  // Sub-entities → dedicated table
  if (meta.dbTable && stats.tableCounts[meta.dbTable] !== undefined) {
    const count = stats.tableCounts[meta.dbTable];
    return cell(count, "db_record_count", `${count} rows in ${meta.dbTable} table`);
  }

  return naCell("No DB table for this type");
}

function scanKbFactCount(meta: EntityTypeMeta): CellValue {
  if (!existsSync(KB_THINGS_DIR)) return naCell("KB things dir missing");

  const kbFiles = new Set(
    readdirSync(KB_THINGS_DIR)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => basename(f, ".yaml")),
  );

  // Get slugs from database.json (most accurate) or YAML
  const db = getDatabaseJson();
  let slugs: Set<string>;

  if (db?.typedEntities) {
    slugs = new Set(
      db.typedEntities
        .filter((e) => e.entityType === meta.id)
        .map((e) => e.slug || e.id)
        .filter(Boolean),
    );
  } else if (meta.yamlFile) {
    const filePath = join(YAML_ENTITIES_DIR, `${meta.yamlFile}.yaml`);
    const entities = parseYamlEntities(filePath);
    slugs = new Set(
      entities
        .filter((e) => (e.type as string) === meta.id)
        .map((e) => e.slug as string)
        .filter(Boolean),
    );
  } else {
    return cell(0, "kb_fact_count", "No data source to match slugs");
  }

  if (slugs.size === 0) return naCell("No entities of this type");

  const matching = [...slugs].filter((s) => kbFiles.has(s));
  return cell(
    matching.length,
    "kb_fact_count",
    `${matching.length}/${slugs.size} entities have KB facts`,
  );
}

function scanDbTableExists(meta: EntityTypeMeta): CellValue {
  if (!meta.dbTable) return naCell("No DB table mapped");
  const schema = getWikiServerSchemaContent();
  const exists = schema.includes(`"${meta.dbTable}"`) || schema.includes(`'${meta.dbTable}'`);
  return cell(exists, "db_table_exists", exists ? `Table: ${meta.dbTable}` : "Table not found in schema");
}

function scanFieldCompleteness(meta: EntityTypeMeta): CellValue {
  const db = getDatabaseJson();
  if (!db?.typedEntities) return naCell("No database.json");

  const entities = db.typedEntities.filter(
    (e) => e.entityType === meta.id,
  );
  if (entities.length === 0) return naCell("No entities of this type");

  // Count non-null fields across all entities
  const fieldCounts: Record<string, number> = {};
  const totalEntities = entities.length;

  for (const entity of entities) {
    for (const [key, value] of Object.entries(entity)) {
      if (key === "slug" || key === "entityType") continue;
      if (!fieldCounts[key]) fieldCounts[key] = 0;
      if (
        value !== null &&
        value !== undefined &&
        value !== "" &&
        !(Array.isArray(value) && value.length === 0)
      ) {
        fieldCounts[key]++;
      }
    }
  }

  const totalFields = Object.keys(fieldCounts).length;
  if (totalFields === 0) return cell(0, "field_completeness");

  const avgCompleteness =
    Object.values(fieldCounts).reduce((sum, c) => sum + c, 0) /
    (totalFields * totalEntities) *
    100;

  return cell(
    Math.round(avgCompleteness),
    "field_completeness",
    `${totalFields} fields, ${totalEntities} entities`,
  );
}

function scanZodSchema(meta: EntityTypeMeta): CellValue {
  if (meta.tier === "sub-entity") return naCell("Sub-entities use DB schemas");

  const content = getEntitySchemasContent();
  // Look for type-specific schema names
  const typePascal = meta.id
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");

  const hasSpecialized = content.includes(`${typePascal}EntitySchema`) ||
    content.includes(`${typePascal}Schema`);
  const hasGeneric = content.includes(`GenericEntity`);

  const level = hasSpecialized ? "specialized" : hasGeneric ? "generic" : "none";
  return cell(level, "zod_schema", level);
}

// --- Data Pipeline ---

function scanBuildPipeline(meta: EntityTypeMeta): CellValue {
  // All canonical types go through build-data.mjs
  if (meta.tier === "canonical") {
    return cell(true, "build_pipeline", "Canonical types processed by build-data");
  }
  // Sub-entities with DB tables are synced via wiki-server
  return cell(!!meta.dbTable, "build_pipeline", meta.dbTable ? "Via wiki-server" : "No pipeline");
}

function scanTypeGuard(meta: EntityTypeMeta): CellValue {
  if (meta.tier === "sub-entity") return naCell("Sub-entities don't use type guards");

  const content = getEntitySchemasContent();
  const typePascal = meta.id
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  const has = content.includes(`function is${typePascal}`) ||
    content.includes(`const is${typePascal}`);
  return cell(has, "type_guard", has ? `is${typePascal}()` : "No type guard");
}

function scanEntityOntology(meta: EntityTypeMeta): CellValue {
  if (meta.tier === "sub-entity") return naCell("Sub-entities not in ontology");

  const content = getEntityOntologyContent();
  // Check if the type ID appears in the ontology's ENTITY_TYPES definition
  const has =
    content.includes(`"${meta.id}"`) || content.includes(`'${meta.id}'`);
  return cell(has, "entity_ontology", has ? "Has label, icon, colors" : "Not in ontology");
}

function scanDbSync(meta: EntityTypeMeta): CellValue {
  // Check if there's a wiki-server route that syncs/serves this type
  if (meta.dbTable || meta.apiRouteFile) {
    return cell(true, "db_sync", "Synced via wiki-server");
  }
  // Canonical types are synced via the entities table
  if (meta.tier === "canonical") {
    return cell(true, "db_sync", "Via generic entities sync");
  }
  return cell(false, "db_sync", "No DB sync");
}

// --- API ---

function scanGenericApi(meta: EntityTypeMeta): CellValue {
  // All canonical types are queryable via /entities?type=X
  if (meta.tier === "canonical") {
    return cell(true, "generic_api", "Via /entities endpoint");
  }
  return naCell("Sub-entities use dedicated routes");
}

function scanDedicatedApiRoute(meta: EntityTypeMeta): CellValue {
  const routeFile = meta.apiRouteFile;
  if (routeFile) {
    const filePath = join(WIKI_SERVER_ROUTES, `${routeFile}.ts`);
    const exists = existsSync(filePath);
    return cell(exists, "dedicated_api_route", exists ? `routes/${routeFile}.ts` : "Route file missing");
  }

  // Check common naming patterns
  const candidates = [
    `${meta.id}.ts`,
    `${meta.id}s.ts`,
    `${meta.id.replace(/-/g, "-")}.ts`,
  ];
  for (const candidate of candidates) {
    if (existsSync(join(WIKI_SERVER_ROUTES, candidate))) {
      return cell(true, "dedicated_api_route", `routes/${candidate}`);
    }
  }

  return cell(false, "dedicated_api_route", "No dedicated route");
}

function scanApiSearch(meta: EntityTypeMeta): CellValue {
  // This would require testing the API — mark as needing API detection
  if (meta.tier === "canonical") {
    return cell(true, "api_search", "Via /entities/search");
  }
  if (meta.apiRouteFile) {
    return cell(true, "api_search", "Via dedicated route");
  }
  return cell(false, "api_search", "No search support");
}

function scanApiFiltering(meta: EntityTypeMeta): CellValue {
  if (meta.apiRouteFile) {
    // Check if the route file has filter/sort params
    const filePath = join(WIKI_SERVER_ROUTES, `${meta.apiRouteFile}.ts`);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      const hasFilter =
        content.includes("filter") || content.includes("sort") || content.includes("orderBy");
      return cell(
        hasFilter ? "rich" : "basic",
        "api_filtering",
        hasFilter ? "Has filter/sort params" : "Basic listing only",
      );
    }
  }
  if (meta.tier === "canonical") {
    return cell("basic", "api_filtering", "Type filter via /entities");
  }
  return cell("none", "api_filtering", "No filtering");
}

// --- UI: Discovery ---

function scanDirectoryPage(meta: EntityTypeMeta): CellValue {
  if (!meta.directoryRoute) return naCell("No directory route configured");

  // Check various route locations
  const candidates = [
    join(APP_ROUTES, meta.directoryRoute, "page.tsx"),
    join(APP_ROUTES, `(directories)/${meta.directoryRoute}`, "page.tsx"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return cell(true, "directory_page", `/${meta.directoryRoute}`);
    }
  }

  return cell(false, "directory_page", "Route not found");
}

function scanTableComponent(meta: EntityTypeMeta): CellValue {
  if (!meta.tableComponent) {
    // Try to find one by convention in components/tables/ or app route dirs
    const candidates = [
      ...globSync(`${COMPONENTS_DIR}/tables/*${meta.id}*table*.tsx`),
      ...(meta.directoryRoute
        ? globSync(`${APP_ROUTES}/${meta.directoryRoute}/*table*.tsx`)
        : []),
    ];
    if (candidates.length > 0) {
      return cell(true, "table_component", basename(candidates[0]));
    }
    return naCell("No table component configured");
  }

  // Check both components/tables/ and the route directory
  const candidates = [
    join(COMPONENTS_DIR, "tables", `${meta.tableComponent}.tsx`),
    ...(meta.directoryRoute
      ? [join(APP_ROUTES, meta.directoryRoute, `${meta.tableComponent}.tsx`)]
      : []),
  ];

  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      return cell(true, "table_component", basename(filePath));
    }
  }

  return cell(false, "table_component", "File not found");
}

function scanExploreIntegration(meta: EntityTypeMeta): CellValue {
  if (meta.tier === "sub-entity") return naCell("Sub-entities not in explore");

  const content = getEntityOntologyContent();
  // Check ENTITY_GROUPS for this type
  const inGroups =
    content.includes(`"${meta.id}"`) || content.includes(`'${meta.id}'`);
  return cell(inGroups, "explore_integration", inGroups ? "In explore grid" : "Not in explore");
}

function scanSidebarNav(meta: EntityTypeMeta): CellValue {
  if (!meta.contentDir) return naCell("No content directory");

  const navContent = getWikiNavContent();
  const inNav =
    navContent.includes(meta.contentDir) ||
    navContent.includes(`"${meta.id}"`) ||
    navContent.includes(`'${meta.id}'`);
  return cell(inNav, "sidebar_nav", inNav ? "In sidebar" : "Not in sidebar");
}

// --- UI: Detail ---

function scanProfileRoute(meta: EntityTypeMeta): CellValue {
  if (!meta.profileRoute) return naCell("No profile route configured");

  const candidates = [
    join(APP_ROUTES, meta.profileRoute, "[slug]", "page.tsx"),
    join(APP_ROUTES, meta.profileRoute, "[id]", "page.tsx"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return cell(true, "profile_route", `/${meta.profileRoute}/[...]`);
    }
  }

  return cell(false, "profile_route", "Route not found");
}

function scanProfileSections(meta: EntityTypeMeta): CellValue {
  if (!meta.profileRoute) return naCell("No profile route");

  const profileDirs = [
    join(APP_ROUTES, meta.profileRoute, "[slug]"),
    join(APP_ROUTES, meta.profileRoute, "[id]"),
  ];

  for (const dir of profileDirs) {
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      const files = readdirSync(dir).filter(
        (f) => f.endsWith(".tsx") && f !== "page.tsx" && f !== "layout.tsx",
      );
      return cell(
        files.length,
        "profile_sections",
        `${files.length} section components`,
      );
    }
  }

  return cell(0, "profile_sections", "No section components");
}

function scanWikiPageShell(meta: EntityTypeMeta): CellValue {
  const db = getDatabaseJson();
  if (!db?.typedEntities) return naCell("No database.json");

  const hasNumericId = db.typedEntities.some(
    (e) => e.entityType === meta.id && e.numericId,
  );
  return cell(
    hasNumericId,
    "wiki_page_shell",
    hasNumericId ? "Entities have numeric IDs" : "No numeric IDs",
  );
}

function scanInfobox(meta: EntityTypeMeta): CellValue {
  // InfoBox/DataInfoBox is used in MDX wiki pages, not profile pages.
  // Check if any MDX pages of this type use DataInfoBox.
  if (!meta.contentDir) {
    // For sub-entities with profile routes, check the profile page instead
    if (meta.profileRoute) {
      const dirs = [
        join(APP_ROUTES, meta.profileRoute, "[slug]"),
        join(APP_ROUTES, meta.profileRoute, "[id]"),
      ];
      for (const dir of dirs) {
        const pageFile = join(dir, "page.tsx");
        if (existsSync(pageFile)) {
          const content = readFileSync(pageFile, "utf-8");
          const has = content.includes("InfoBox") || content.includes("DataInfoBox") || content.includes("ProfileStatCard");
          return cell(has, "infobox", has ? "Has structured metadata display" : "No InfoBox");
        }
      }
    }
    return naCell("No content directory or profile route");
  }

  // Check MDX pages for DataInfoBox usage
  const contentPath = join(CONTENT_DIR, meta.contentDir);
  if (!existsSync(contentPath)) return naCell("Content directory not found");

  const mdxFiles = globSync(join(contentPath, "**/*.mdx"));
  const withInfoBox = mdxFiles.filter((f) => {
    const content = readFileSync(f, "utf-8");
    return content.includes("DataInfoBox") || content.includes("<InfoBox");
  });

  const has = withInfoBox.length > 0;
  return cell(
    has,
    "infobox",
    has ? `${withInfoBox.length}/${mdxFiles.length} pages use InfoBox` : "No InfoBox usage",
  );
}

// --- Content ---

function scanMdxPageCount(meta: EntityTypeMeta): CellValue {
  const db = getDatabaseJson();
  if (!db?.pages) {
    // Fallback: count MDX files in content directory
    if (meta.contentDir) {
      const dir = join(CONTENT_DIR, meta.contentDir);
      if (existsSync(dir)) {
        const files = globSync(`${dir}/**/*.mdx`);
        return cell(files.length, "mdx_page_count", `${files.length} MDX files`);
      }
    }
    return naCell("No database.json or content dir");
  }

  // From database.json pages, match by entityType
  const pages = db.pages.filter((p) => p.entityType === meta.id);
  if (pages.length > 0) {
    return cell(pages.length, "mdx_page_count", `${pages.length} pages`);
  }

  // Fallback: content directory
  if (meta.contentDir) {
    const dir = join(CONTENT_DIR, meta.contentDir);
    if (existsSync(dir)) {
      const files = globSync(`${dir}/**/*.mdx`);
      return cell(files.length, "mdx_page_count", `${files.length} MDX files (by dir)`);
    }
  }

  return cell(0, "mdx_page_count", "No pages found");
}

function scanAvgPageLength(meta: EntityTypeMeta): CellValue {
  const db = getDatabaseJson();
  if (!db?.pages) return naCell("No database.json");

  const pages = db.pages.filter(
    (p) => p.entityType === meta.id && p.wordCount,
  );
  if (pages.length === 0) return naCell("No pages with word count");

  const avg = Math.round(
    pages.reduce((sum, p) => sum + (p.wordCount ?? 0), 0) / pages.length,
  );
  return cell(avg, "avg_page_length", `avg ${avg} words across ${pages.length} pages`);
}

function scanCitationDensity(meta: EntityTypeMeta): CellValue {
  const db = getDatabaseJson();
  if (!db?.pages) return naCell("No database.json");

  const pages = db.pages.filter((p) => p.entityType === meta.id);
  if (pages.length === 0) return naCell("No pages of this type");

  const totalCitations = pages.reduce(
    (sum, p) => sum + (p.citationHealth?.total ?? p.footnoteCount ?? 0),
    0,
  );
  const avg = Math.round((totalCitations / pages.length) * 10) / 10;
  return cell(avg, "citation_density", `avg ${avg} citations/page`);
}

function scanContentFreshness(meta: EntityTypeMeta): CellValue {
  const db = getDatabaseJson();
  if (!db?.pages) return naCell("No database.json");

  const now = Date.now();
  const pages = db.pages.filter(
    (p) => p.entityType === meta.id && p.lastUpdated,
  );
  if (pages.length === 0) return naCell("No pages with dates");

  const daysAges = pages.map((p) => {
    const edited = new Date(p.lastUpdated!).getTime();
    return Math.round((now - edited) / (1000 * 60 * 60 * 24));
  });

  // Median
  daysAges.sort((a, b) => a - b);
  const median = daysAges[Math.floor(daysAges.length / 2)];
  return cell(median, "content_freshness", `median ${median} days old`);
}

// --- Quality ---

function scanVerificationTables(meta: EntityTypeMeta): CellValue {
  if (!meta.dbTable) return naCell("No DB table");

  const schema = getWikiServerSchemaContent();
  // Check for verification-related tables
  const hasVerification =
    schema.includes(`${meta.dbTable}Verification`) ||
    schema.includes(`record_verifications`) ||
    schema.includes(`recordVerifications`);

  return cell(
    hasVerification,
    "verification_tables",
    hasVerification ? "Has verification tables" : "No verification",
  );
}

function scanVerificationCoverage(_meta: EntityTypeMeta): CellValue {
  // Requires API call — return placeholder
  return naCell("Requires wiki-server API");
}

function scanHallucinationScored(meta: EntityTypeMeta): CellValue {
  const db = getDatabaseJson();
  if (!db?.pages) return naCell("No database.json");

  const pages = db.pages.filter((p) => p.entityType === meta.id);
  if (pages.length === 0) return naCell("No pages of this type");

  const scored = pages.filter((p) => {
    if (p.hallucinationRisk === undefined || p.hallucinationRisk === null) return false;
    if (typeof p.hallucinationRisk === "object") return p.hallucinationRisk.score !== undefined;
    return true;
  });
  return cell(
    scored.length > 0,
    "hallucination_scored",
    `${scored.length}/${pages.length} pages scored`,
  );
}

// --- Testing ---

function scanTestFiles(meta: EntityTypeMeta): CellValue {
  const patterns = [
    `${APP_DIR}/**/*${meta.id}*.test.{ts,tsx}`,
    `${PROJECT_ROOT}/crux/**/*${meta.id}*.test.ts`,
    `${PROJECT_ROOT}/apps/wiki-server/**/*${meta.id}*.test.ts`,
  ];

  let total = 0;
  for (const pattern of patterns) {
    total += globSync(pattern).length;
  }

  // Also check for utils files that imply testing
  const utilPatterns = [
    `${APP_DIR}/**/*${meta.id}*-utils*.test.{ts,tsx}`,
    `${COMPONENTS_DIR}/**/*${meta.id}*.test.{ts,tsx}`,
  ];
  for (const pattern of utilPatterns) {
    total += globSync(pattern).length;
  }

  return cell(total, "test_files", `${total} test files`);
}

function scanGateChecks(meta: EntityTypeMeta): CellValue {
  // Gate checks cover all canonical types via schema validation, MDX compilation, etc.
  if (meta.tier === "canonical") {
    return cell(true, "gate_checks", "Covered by schema + MDX gate");
  }
  // Sub-entities with DB tables have migration checks
  if (meta.dbTable) {
    return cell(true, "gate_checks", "Covered by DB migration checks");
  }
  return cell(false, "gate_checks", "No gate coverage");
}

// ============================================================================
// SCANNER MAP
// ============================================================================

const SCANNERS: Record<string, DimensionScanner> = {
  // Data Foundation
  yaml_entity_count: scanYamlEntityCount,
  build_entity_count: scanBuildEntityCount,
  db_record_count: scanDbRecordCount,
  kb_fact_count: scanKbFactCount,
  db_table_exists: scanDbTableExists,
  field_completeness: scanFieldCompleteness,
  zod_schema: scanZodSchema,

  // Data Pipeline
  build_pipeline: scanBuildPipeline,
  type_guard: scanTypeGuard,
  entity_ontology: scanEntityOntology,
  db_sync: scanDbSync,

  // API
  generic_api: scanGenericApi,
  dedicated_api_route: scanDedicatedApiRoute,
  api_search: scanApiSearch,
  api_filtering: scanApiFiltering,

  // UI: Discovery
  directory_page: scanDirectoryPage,
  table_component: scanTableComponent,
  explore_integration: scanExploreIntegration,
  sidebar_nav: scanSidebarNav,

  // UI: Detail
  profile_route: scanProfileRoute,
  profile_sections: scanProfileSections,
  wiki_page_shell: scanWikiPageShell,
  infobox: scanInfobox,

  // Content
  mdx_page_count: scanMdxPageCount,
  avg_page_length: scanAvgPageLength,
  citation_density: scanCitationDensity,
  content_freshness: scanContentFreshness,

  // Quality
  verification_tables: scanVerificationTables,
  verification_coverage: scanVerificationCoverage,
  hallucination_scored: scanHallucinationScored,

  // Testing
  test_files: scanTestFiles,
  gate_checks: scanGateChecks,
};

// ============================================================================
// MAIN SCAN FUNCTION
// ============================================================================

export async function scanMatrix(): Promise<MatrixSnapshot> {
  const rows: EntityTypeRow[] = [];

  for (const entityType of ENTITY_TYPES) {
    const cells: Record<string, CellValue> = {};

    for (const dim of DIMENSIONS) {
      const scanner = SCANNERS[dim.id];
      if (scanner) {
        try {
          cells[dim.id] = await scanner(entityType);
        } catch (e) {
          cells[dim.id] = {
            raw: null,
            score: -1,
            details: `Scanner error: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      } else {
        cells[dim.id] = naCell("No scanner implemented");
      }
    }

    // Compute aggregate scores
    const applicableCells = Object.entries(cells).filter(
      ([, v]) => v.score >= 0,
    );
    const dimensionMap = new Map(DIMENSIONS.map((d) => [d.id, d]));

    let weightedSum = 0;
    let totalWeight = 0;
    for (const [dimId, cellVal] of applicableCells) {
      const dim = dimensionMap.get(dimId);
      if (dim) {
        weightedSum += cellVal.score * dim.importance;
        totalWeight += dim.importance;
      }
    }
    // Apply coverage penalty: if <50% of dimensions are applicable,
    // penalize the score proportionally. This prevents entities with
    // very few applicable dimensions from scoring artificially high.
    const totalPossibleWeight = DIMENSIONS.reduce((s, d) => s + d.importance, 0);
    const coverageRatio = totalWeight / totalPossibleWeight;
    const coveragePenalty = coverageRatio < 0.5
      ? 0.6 + (coverageRatio / 0.5) * 0.4  // Scale from 0.6 to 1.0
      : 1.0;
    const rawScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const aggregateScore = Math.round(rawScore * coveragePenalty);

    // Compute group scores
    const groupScores: Record<string, number> = {};
    for (const group of DIMENSION_GROUPS) {
      const groupDims = DIMENSIONS.filter((d) => d.group === group.id);
      const groupCells = groupDims
        .map((d) => cells[d.id])
        .filter((c) => c && c.score >= 0);
      if (groupCells.length > 0) {
        const groupWeightedSum = groupDims.reduce((sum, d) => {
          const c = cells[d.id];
          return c && c.score >= 0 ? sum + c.score * d.importance : sum;
        }, 0);
        const groupTotalWeight = groupDims.reduce((sum, d) => {
          const c = cells[d.id];
          return c && c.score >= 0 ? sum + d.importance : sum;
        }, 0);
        groupScores[group.id] =
          groupTotalWeight > 0
            ? Math.round(groupWeightedSum / groupTotalWeight)
            : 0;
      }
    }

    // Pick a sample entity that has an actual MDX page
    const db = getDatabaseJson();
    const pageIds = new Set(
      db?.pages
        ?.filter((p) => p.entityType === entityType.id && p.numericId)
        .map((p) => p.numericId) ?? [],
    );
    // Prefer an entity that has a page; fall back to any entity with a numericId
    const sampleEntity = pageIds.size > 0
      ? db?.typedEntities?.find(
          (e) => e.entityType === entityType.id && pageIds.has(e.numericId),
        )
      : db?.typedEntities?.find(
          (e) => e.entityType === entityType.id && e.numericId,
        );

    rows.push({
      entityType: entityType.id,
      label: entityType.label,
      tier: entityType.tier,
      cells,
      aggregateScore,
      groupScores,
      sampleEntityId: sampleEntity?.numericId,
      sampleEntitySlug: sampleEntity?.slug || sampleEntity?.id,
    });
  }

  // Compute overall averages
  const overallScore =
    rows.length > 0
      ? Math.round(
          rows.reduce((sum, r) => sum + r.aggregateScore, 0) / rows.length,
        )
      : 0;

  const groupAverages: Record<string, number> = {};
  for (const group of DIMENSION_GROUPS) {
    const scores = rows
      .map((r) => r.groupScores[group.id])
      .filter((s) => s !== undefined);
    groupAverages[group.id] =
      scores.length > 0
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : 0;
  }

  const dimensionAverages: Record<string, number> = {};
  for (const dim of DIMENSIONS) {
    const scores = rows
      .map((r) => r.cells[dim.id]?.score)
      .filter((s) => s !== undefined && s >= 0);
    dimensionAverages[dim.id] =
      scores.length > 0
        ? Math.round(
            (scores as number[]).reduce((a, b) => a + b, 0) / scores.length,
          )
        : 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    entityTypes: ENTITY_TYPES,
    dimensions: DIMENSIONS,
    dimensionGroups: DIMENSION_GROUPS,
    rows,
    overallScore,
    groupAverages,
    dimensionAverages,
  };
}
