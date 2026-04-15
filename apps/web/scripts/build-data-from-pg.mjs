/**
 * Build Data From PG — Phase 3a Equivalence Audit Prototype (QUA-510)
 *
 * NOT a replacement for build-data.mjs. This is a side-by-side prototype used
 * to answer the Phase 3 unblocking question: can `build-data.mjs` read
 * entities / facts from PG instead of YAML and produce an equivalent output?
 *
 * Scope:
 *   - Re-implements the entity-loading phase of build-data.mjs against the
 *     wiki-server PG mirror (`/api/entities/:id`) instead of YAML.
 *   - Imports `transformEntities()` from the existing build-data pipeline —
 *     the transform code is shared, NOT reimplemented, so any diff we see
 *     is a pure SOURCE diff, not a transformation diff.
 *   - Loads MDX pages through the normal `buildPagesRegistry` path (pages
 *     come from MDX content, which is unaffected by Phase 3).
 *   - Emits `typedEntities-from-pg.json` and `pg-audit-diff.json` beside
 *     `database.json`. The app does NOT read either.
 *
 * Usage:
 *   WIKI_SERVER_ENV=prod node apps/web/scripts/build-data-from-pg.mjs [--sample=N]
 *
 * Options:
 *   --sample=N   Only fetch N entities (for quick testing). Default: all.
 *
 * Output artifacts (written beside database.json):
 *   - typedEntities-from-pg.json  — PG-sourced typedEntities array
 *   - pg-audit-diff.json           — structural diff vs database.json
 *   - pg-audit-diff.md             — human-readable summary (top-level)
 *
 * Known limitations of this prototype (documented in the audit report):
 *   1. No bulk entity export endpoint exists. We paginate via /api/entities/
 *      and then fetch /api/entities/:stableId for each row to get the full
 *      shape (metadata, relatedEntries, customFields). ~2800 requests,
 *      runs in a few minutes with concurrency.
 *   2. This prototype only diffs `typedEntities`. Other database.json fields
 *      (kb, resources, records collections) are already PG-sourced or
 *      PG-overriding today — they are already equivalent by construction
 *      and out of scope for this audit phase.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { transformEntities } from "./lib/entity-transform.mjs";
import { OUTPUT_DIR } from "./lib/content-types.mjs";
import { buildPagesRegistry } from "./lib/pages-builder.mjs";
import { buildUrlToResourceMap } from "./lib/unconverted-links.mjs";
import { buildIdRegistry } from "./lib/id-registry.mjs";
import { collectPageWikiIds } from "./lib/frontmatter-scanner.mjs";
import { fetchJsonWithRetry } from "./lib/wiki-server-data.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SAMPLE_ARG = process.argv.find((a) => a.startsWith("--sample="));
const SAMPLE = SAMPLE_ARG ? Number(SAMPLE_ARG.split("=")[1]) : Infinity;

const envPrefix =
  process.env.WIKI_SERVER_ENV === "prod" ||
  process.env.WIKI_SERVER_ENV === "production"
    ? "PROD_"
    : "";
const SERVER_URL = process.env[`${envPrefix}LONGTERMWIKI_SERVER_URL`];
const API_KEY = process.env[`${envPrefix}LONGTERMWIKI_SERVER_API_KEY`];

if (!SERVER_URL) {
  console.error(
    `error: ${envPrefix}LONGTERMWIKI_SERVER_URL is not set. Use WIKI_SERVER_ENV=prod.`
  );
  process.exit(1);
}

const AUTH_HEADERS = API_KEY
  ? { Authorization: `Bearer ${API_KEY}` }
  : {};

// ---------------------------------------------------------------------------
// PG fetchers
// ---------------------------------------------------------------------------

// Thin wrapper: 3-attempt exponential backoff on 5xx/429/timeouts via the
// shared helper in wiki-server-data.mjs. Throws on terminal failure so the
// per-item try/catch in pMap can turn it into a skip.
async function fetchJson(path) {
  const result = await fetchJsonWithRetry(`${SERVER_URL}${path}`, {
    headers: AUTH_HEADERS,
  });
  if (!result.ok) {
    throw new Error(`GET ${path} → ${result.reason}`);
  }
  return result.data;
}

/** List all entity slugs + stableIds (one paginated call). */
async function listAllEntities() {
  const pageSize = 500;
  let offset = 0;
  const all = [];
  while (true) {
    const data = await fetchJson(
      `/api/entities?limit=${pageSize}&offset=${offset}`
    );
    all.push(...(data.entities || []));
    if ((data.entities || []).length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

/** Fetch full entity shape (with metadata, relatedEntries, customFields). */
async function fetchEntityFull(slug) {
  return fetchJson(`/api/entities/${encodeURIComponent(slug)}`);
}

/**
 * Concurrent map with a bounded worker pool. Returns results in input order.
 * Fails fast on first rejection.
 */
async function pMap(items, worker, concurrency = 20) {
  const out = new Array(items.length);
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, runner);
  await Promise.all(runners);
  return out;
}

// ---------------------------------------------------------------------------
// Transformation: PG entity row → raw entity shape expected by transformEntities
// ---------------------------------------------------------------------------

/**
 * PG stores type-specific fields inside `metadata` JSONB (via
 * sync-entities.ts::extractMetadata). `transformEntities()` expects them
 * at top-level on the raw entity object. Un-nest them so the transform
 * function sees the same shape it would from YAML.
 */
function pgRowToRawEntity(row) {
  const meta = row.metadata || {};
  // Base fields live at top-level on the PG row.
  // Type-specific fields live in metadata and are hoisted here.
  const raw = {
    id: row.id,
    stableId: row.stableId ?? undefined,
    wikiId: row.wikiId ?? undefined,
    type: row.entityType,
    title: row.title,
    description: row.description ?? undefined,
    website: row.website ?? undefined,
    tags: row.tags ?? undefined,
    clusters: row.clusters ?? undefined,
    status: row.status ?? undefined,
    lastUpdated: row.lastUpdated ?? undefined,
    customFields: row.customFields ?? undefined,
    relatedEntries: row.relatedEntries ?? undefined,
    ...meta, // un-nest type-specific fields
  };
  return raw;
}

/**
 * Extract a synthetic `experts` array from PG entity metadata. Mirrors the
 * YAML experts.yaml schema so `transformEntities()` can consume it unchanged.
 *
 * Every entity with metadata.expertPositions or metadata.expertRole or
 * metadata.knownFor or metadata.affiliation was an entry in experts.yaml
 * at sync time — sync-entities.ts::mergeExpertData hoists those fields
 * into metadata.
 */
function synthesizeExpertsFromPg(pgRows) {
  const experts = [];
  for (const row of pgRows) {
    const m = row.metadata || {};
    const hasExpertData =
      m.expertPositions || m.expertRole || m.knownFor || m.affiliation;
    if (!hasExpertData) continue;
    experts.push({
      id: row.id,
      name: row.title,
      website: row.website ?? undefined,
      affiliation: m.affiliation ?? undefined,
      role: m.expertRole ?? undefined,
      knownFor: m.knownFor ?? undefined,
      positions: m.expertPositions ?? undefined,
    });
  }
  return experts;
}

/**
 * Extract a synthetic `organizations` array from PG entity metadata. Mirrors
 * the YAML data/organizations.yaml schema.
 *
 * NOTE: This is where the known gap lives. sync-entities.ts does NOT today
 * carry data/organizations.yaml into PG the way it carries experts.yaml. So
 * this synthesis will return an empty (or mostly empty) array, producing a
 * visible Type A diff for the 31 orgs that rely on organizations.yaml for
 * founded/headquarters/employees/funding/keyPeople.
 */
function synthesizeOrganizationsFromPg(pgRows) {
  const orgs = [];
  for (const row of pgRows) {
    if (row.entityType !== "organization") continue;
    const m = row.metadata || {};
    const hasOrgData =
      m.founded || m.headquarters || m.employees || m.funding || m.keyPeople;
    if (!hasOrgData) continue;
    orgs.push({
      id: row.id,
      name: row.title,
      type: m.orgType ?? undefined,
      founded: m.founded ?? undefined,
      headquarters: m.headquarters ?? undefined,
      employees: m.employees ?? undefined,
      funding: m.funding ?? undefined,
      website: row.website ?? undefined,
      keyPeople: m.keyPeople ?? undefined,
    });
  }
  return orgs;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Compare two typedEntities arrays, reporting per-field diffs.
 *
 * Diff types (matching QUA-510 taxonomy):
 *   A — field present in YAML side, absent/null in PG side
 *   B — field present in PG side, absent/null in YAML side
 *   C — same field, different value (same shape)
 *   D — row in YAML not in PG (or vice versa)
 *   E — ordering/sort difference only
 */
function diffTypedEntities(yamlArr, pgArr) {
  const yamlById = new Map(yamlArr.map((e) => [e.id, e]));
  const pgById = new Map(pgArr.map((e) => [e.id, e]));

  const yamlOnly = []; // Type D
  const pgOnly = []; // Type D
  const fieldDiffs = []; // Type A/B/C

  for (const [id, yamlE] of yamlById) {
    const pgE = pgById.get(id);
    if (!pgE) {
      yamlOnly.push(id);
      continue;
    }
    const allKeys = new Set([...Object.keys(yamlE), ...Object.keys(pgE)]);
    for (const key of allKeys) {
      const yv = yamlE[key];
      const pv = pgE[key];
      if (isEqual(yv, pv)) continue;
      const yPresent = isPresent(yv);
      const pPresent = isPresent(pv);
      let type;
      if (yPresent && !pPresent) type = "A";
      else if (!yPresent && pPresent) type = "B";
      else type = "C";
      fieldDiffs.push({ id, entityType: yamlE.entityType, key, type, yaml: truncate(yv), pg: truncate(pv) });
    }
  }

  for (const id of pgById.keys()) {
    if (!yamlById.has(id)) pgOnly.push(id);
  }

  return { yamlOnly, pgOnly, fieldDiffs };
}

/** A value is "present" if it's not null/undefined and not an empty array. */
function isPresent(v) {
  if (v == null) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function isEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object" && a != null && b != null) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (!isEqual(a[aKeys[i]], b[bKeys[i]])) return false;
    }
    return true;
  }
  return false;
}

function truncate(v) {
  if (v == null) return v;
  const s = JSON.stringify(v);
  return s && s.length > 120 ? s.slice(0, 120) + "…" : v;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Building typedEntities from PG (${SERVER_URL})...\n`);

  // --- Step 1: enumerate all entities ---
  console.log("1. Listing entity slugs from PG...");
  const stubs = await listAllEntities();
  const slugs = stubs.map((s) => s.id).slice(0, SAMPLE);
  console.log(
    `   ${slugs.length} entities${Number.isFinite(SAMPLE) && slugs.length < stubs.length ? ` (sampled from ${stubs.length})` : ""}`
  );

  // --- Step 2: fetch full shape for each ---
  console.log("2. Fetching full entity shapes (metadata + relatedEntries + customFields)...");
  let skipped = 0;
  const fullRows = await pMap(
    slugs,
    async (slug) => {
      try {
        return await fetchEntityFull(slug);
      } catch (err) {
        skipped++;
        console.warn(`   skip ${slug}: ${err.message}`);
        return null;
      }
    },
    20
  );
  const pgRows = fullRows.filter((r) => r != null);
  console.log(`   ${pgRows.length} entities fetched${skipped > 0 ? ` (${skipped} skipped)` : ""}`);
  if (skipped > 0 && skipped / slugs.length > 0.01) {
    console.error(`   ERROR: skip rate ${(skipped / slugs.length * 100).toFixed(1)}% exceeds 1% — diff would have spurious Type-D entries. Aborting.`);
    process.exit(1);
  }

  // --- Step 3: convert to raw entity shape for transform ---
  const rawEntities = pgRows.map(pgRowToRawEntity);
  const synthExperts = synthesizeExpertsFromPg(pgRows);
  const synthOrganizations = synthesizeOrganizationsFromPg(pgRows);
  console.log(
    `3. Synthesized: ${synthExperts.length} experts, ${synthOrganizations.length} orgs from PG metadata`
  );

  // --- Step 4: load pages (same source as build-data.mjs) ---
  // transformEntities uses pages for path-based type overrides and for
  // filling in missing descriptions from page.description. Both pipelines
  // must see the same pages list for the diff to be apples-to-apples, so
  // we pay the MDX-scan cost even though it's expensive.
  console.log("4. Loading pages from MDX frontmatter...");
  const urlToResource = buildUrlToResourceMap([]);
  const pages = buildPagesRegistry(urlToResource, new Map(), { gitCreatedMap: new Map(), gitModifiedMap: new Map() }, new Map(), new Map());
  console.log(`   ${pages.length} pages loaded`);

  // --- Step 4b: assign fallback wikiIds via the same buildIdRegistry path
  // that build-data.mjs uses. Without this, entities that don't yet have a
  // persisted wikiId in PG (because they never allocated one via
  // assign-ids.mjs and the fallback lives only in database.json) would
  // show up as spurious Type A diffs on `wikiId`. The registry mutates
  // `entity.wikiId` in place.
  const CONTENT_DIR = join(REPO_ROOT, "content/docs");
  const reservedPageWikiIds = collectPageWikiIds(CONTENT_DIR);
  buildIdRegistry(rawEntities, reservedPageWikiIds);

  // --- Step 5: run the shared transform ---
  console.log("5. Running transformEntities()...");
  const typedEntitiesFromPg = transformEntities(
    rawEntities,
    pages,
    synthExperts,
    synthOrganizations
  );
  console.log(`   ${typedEntitiesFromPg.length} typedEntities produced from PG`);

  // --- Step 6: load the existing YAML-sourced typedEntities as baseline ---
  console.log("6. Loading YAML-sourced typedEntities from database.json...");
  const dbPath = join(OUTPUT_DIR, "database.json");
  if (!existsSync(dbPath)) {
    console.error(`   ERROR: ${dbPath} not found — run 'node apps/web/scripts/build-data.mjs' first`);
    process.exit(1);
  }
  const db = JSON.parse(readFileSync(dbPath, "utf-8"));
  const typedEntitiesFromYaml = db.typedEntities || [];
  console.log(`   ${typedEntitiesFromYaml.length} typedEntities from YAML baseline`);

  // --- Step 7: write PG output + diff ---
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  const pgOut = join(OUTPUT_DIR, "typedEntities-from-pg.json");
  writeFileSync(pgOut, JSON.stringify(typedEntitiesFromPg, null, 2));
  console.log(`\n✓ Wrote ${pgOut}`);

  console.log("\n7. Diffing YAML-sourced vs PG-sourced typedEntities...");
  const diff = diffTypedEntities(typedEntitiesFromYaml, typedEntitiesFromPg);

  const summary = summarizeDiff(diff);
  console.log(summary.human);

  const diffOut = join(OUTPUT_DIR, "pg-audit-diff.json");
  writeFileSync(
    diffOut,
    JSON.stringify(
      {
        counts: summary.counts,
        yamlOnly: diff.yamlOnly,
        pgOnly: diff.pgOnly,
        fieldDiffs: diff.fieldDiffs,
      },
      null,
      2
    )
  );
  console.log(`✓ Wrote ${diffOut}`);

  const mdOut = join(OUTPUT_DIR, "pg-audit-diff.md");
  writeFileSync(mdOut, summary.markdown);
  console.log(`✓ Wrote ${mdOut}`);
}

function summarizeDiff(diff) {
  const byType = { A: 0, B: 0, C: 0 };
  const byField = new Map();
  for (const d of diff.fieldDiffs) {
    byType[d.type]++;
    const fieldKey = `${d.type}:${d.key}`;
    byField.set(fieldKey, (byField.get(fieldKey) || 0) + 1);
  }
  byType.D = diff.yamlOnly.length + diff.pgOnly.length;

  const topFields = [...byField.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);

  const lines = [];
  lines.push(`Diff summary: ${diff.fieldDiffs.length} field diffs, ${diff.yamlOnly.length} yaml-only rows, ${diff.pgOnly.length} pg-only rows`);
  lines.push(`  Type A (yaml-only field): ${byType.A}`);
  lines.push(`  Type B (pg-only field):   ${byType.B}`);
  lines.push(`  Type C (value mismatch):  ${byType.C}`);
  lines.push(`  Type D (missing row):     ${byType.D}`);
  lines.push("");
  lines.push("Top 25 field diffs (type:field — count):");
  for (const [k, v] of topFields) {
    lines.push(`  ${k}: ${v}`);
  }

  const human = lines.join("\n");

  const md = [];
  md.push("# PG Audit Diff — typedEntities\n");
  md.push(`Generated: ${new Date().toISOString()}\n`);
  md.push("## Counts\n");
  md.push(`- Type A (field in YAML, missing in PG): **${byType.A}**`);
  md.push(`- Type B (field in PG, missing in YAML): **${byType.B}**`);
  md.push(`- Type C (same field, different value): **${byType.C}**`);
  md.push(`- Type D (missing row): **${byType.D}** (yamlOnly=${diff.yamlOnly.length}, pgOnly=${diff.pgOnly.length})`);
  md.push("\n## Top 25 field diffs\n");
  md.push("| Type:field | Count |");
  md.push("|---|---|");
  for (const [k, v] of topFields) md.push(`| \`${k}\` | ${v} |`);
  md.push("\n## Yaml-only row samples\n");
  md.push(diff.yamlOnly.slice(0, 20).map((id) => `- ${id}`).join("\n") || "_none_");
  md.push("\n## PG-only row samples\n");
  md.push(diff.pgOnly.slice(0, 20).map((id) => `- ${id}`).join("\n") || "_none_");
  const markdown = md.join("\n");

  return {
    counts: { ...byType, fieldDiffs: diff.fieldDiffs.length, yamlOnly: diff.yamlOnly.length, pgOnly: diff.pgOnly.length },
    human,
    markdown,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
