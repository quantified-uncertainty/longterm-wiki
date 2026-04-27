/**
 * Factbase Equivalence Audit — Phase 3a (QUA-510)
 *
 * Companion to `build-data-from-pg.mjs`. Loads all FactBase YAML (via the
 * canonical `loadKB` + `serialize` pipeline) and compares every fact to
 * the PG mirror (`/api/facts/export`), classifying each diff per the
 * QUA-510 taxonomy (Type A/B/C/D).
 *
 * Why separate from build-data-from-pg.mjs: the YAML side here runs through
 * the FactBase loader (not entity YAML), and the PG side uses a different
 * endpoint. Sharing the diff helper isn't worth cross-file plumbing.
 *
 * Usage:
 *   WIKI_SERVER_ENV=prod node --import tsx/esm apps/web/scripts/audit-factbase-pg.mjs
 *
 * Outputs:
 *   - docs/audits/phase-3-equivalence-audit-factbase.diff.json  — committed
 *   - apps/web/src/data/factbase-audit-diff.md                    — gitignored
 *
 * NOT wired into the default build.
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { fetchJsonWithRetry } from "./lib/wiki-server-data.mjs";
import { getServerUrl, getApiKey, getEnvPrefix } from "./lib/wiki-server-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const AUDIT_DIR = join(REPO_ROOT, "docs", "audits");
const FACTBASE_DATA_DIR = join(REPO_ROOT, "packages", "factbase", "data");
const OUT_MD_DIR = join(REPO_ROOT, "apps", "web", "src", "data");

const SERVER_URL = getServerUrl();
const API_KEY = getApiKey();

if (!SERVER_URL) {
  console.error(
    `error: ${getEnvPrefix()}LONGTERMWIKI_SERVER_URL is not set. Use WIKI_SERVER_ENV=prod.`
  );
  process.exit(1);
}
const AUTH_HEADERS = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};

// ---------------------------------------------------------------------------
// Load YAML side via canonical factbase loader
// ---------------------------------------------------------------------------

/**
 * Return a map of entityId → Fact[] sourced from YAML. Skips derived/inverse
 * facts to match what /api/facts/export (PG) stores. Uses the same
 * filename→id mapping the loader produces so output is comparable.
 */
async function loadYamlFacts() {
  const { loadKB } = await import("../../../packages/factbase/src/index.ts");
  const { graph } = await loadKB(FACTBASE_DATA_DIR);
  const entities = graph.getAllEntities();
  const byEntity = {};
  let total = 0;
  let droppedDerived = 0;
  for (const entity of entities) {
    const facts = graph.getFacts(entity.id);
    const kept = [];
    for (const fact of facts) {
      if (fact.derivedFrom) {
        droppedDerived++;
        continue;
      }
      kept.push(fact);
      total++;
    }
    if (kept.length > 0) byEntity[entity.id] = kept;
  }
  return { byEntity, entities, total, droppedDerived };
}

// ---------------------------------------------------------------------------
// Load PG side
// ---------------------------------------------------------------------------

async function fetchPgFacts() {
  // /api/facts/export paginates via limit+offset. NOTE: the response's
  // `returned` field counts rows AFTER skipping malformed ones on the server,
  // so it is NOT a reliable "end of pagination" signal — a page with N DB
  // rows and one malformed row will report `returned = N-1 < pageSize` while
  // later offsets still have rows. We drive the loop off `total` + `offset`
  // only. (CodeRabbit catch on PR #4384.)
  const all = {};
  let offset = 0;
  const pageSize = 5000;
  let total = 0;
  while (true) {
    const result = await fetchJsonWithRetry(
      `${SERVER_URL}/api/facts/export?limit=${pageSize}&offset=${offset}`,
      { headers: AUTH_HEADERS }
    );
    if (!result.ok) {
      throw new Error(`GET /api/facts/export → ${result.reason}`);
    }
    const facts = result.data.facts || {};
    for (const [entityId, list] of Object.entries(facts)) {
      if (!all[entityId]) all[entityId] = [];
      all[entityId].push(...list);
    }
    total = result.data.total ?? total;
    offset += pageSize;
    if (offset >= total) break;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Diff — fact by (entityId, factId)
// ---------------------------------------------------------------------------

/** Canonicalize a fact to a shape we can compare across the YAML/PG boundary. */
function canonicalizeFact(f) {
  return {
    id: f.id,
    subjectId: f.subjectId,
    propertyId: f.propertyId ?? "",
    asOf: f.asOf ?? null,
    validEnd: f.validEnd ?? null,
    source: f.source ?? null,
    sourceQuote: f.sourceQuote ?? null,
    notes: f.notes ?? null,
    currency: f.currency ?? null,
    usdEquivalent: f.usdEquivalent ?? null,
    exchangeRate: f.exchangeRate ?? null,
    exchangeRateDate: f.exchangeRateDate ?? null,
    dollarYear: f.dollarYear ?? null,
    value: canonicalizeValue(f.value),
  };
}

function canonicalizeValue(v) {
  if (v == null || typeof v !== "object") return v;
  // FactValue is a discriminated union. Collapse to a stable string shape.
  switch (v.type) {
    case "number":
      return `number:${v.value}`;
    case "text":
    case "date":
      return `${v.type}:${v.value}`;
    case "boolean":
      return `boolean:${v.value}`;
    case "ref":
      return `ref:${v.value}`;
    case "refs":
      return `refs:${(v.value || []).join(",")}`;
    case "range":
      return `range:${v.low}-${v.high}`;
    case "min":
      return `min:${v.value}`;
    case "json":
      try { return `json:${JSON.stringify(v.value)}`; } catch { return "json:?"; }
    default:
      return JSON.stringify(v);
  }
}

function diffFacts(yamlByEntity, pgByEntity) {
  // Build per-fact index: key = "entityId:factId"
  const yamlIndex = new Map();
  for (const [entityId, list] of Object.entries(yamlByEntity)) {
    for (const f of list) yamlIndex.set(`${entityId}:${f.id}`, canonicalizeFact(f));
  }
  const pgIndex = new Map();
  for (const [entityId, list] of Object.entries(pgByEntity)) {
    for (const f of list) pgIndex.set(`${entityId}:${f.id}`, canonicalizeFact(f));
  }

  const yamlOnly = []; // Type D — fact in YAML missing from PG
  const pgOnly = []; // Type D — fact in PG missing from YAML
  const fieldDiffs = []; // Type A/B/C

  for (const [key, yf] of yamlIndex) {
    const pf = pgIndex.get(key);
    if (!pf) {
      yamlOnly.push(key);
      continue;
    }
    for (const fieldKey of new Set([...Object.keys(yf), ...Object.keys(pf)])) {
      const yv = yf[fieldKey];
      const pv = pf[fieldKey];
      if (yv === pv) continue;
      if (yv == null && pv == null) continue;
      const yPresent = yv != null;
      const pPresent = pv != null;
      let type;
      if (yPresent && !pPresent) type = "A";
      else if (!yPresent && pPresent) type = "B";
      else type = "C";
      fieldDiffs.push({
        id: key,
        key: fieldKey,
        type,
        yaml: shortVal(yv),
        pg: shortVal(pv),
      });
    }
  }
  for (const key of pgIndex.keys()) {
    if (!yamlIndex.has(key)) pgOnly.push(key);
  }

  return { yamlOnly, pgOnly, fieldDiffs };
}

function shortVal(v) {
  if (v == null) return v;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 150 ? s.slice(0, 150) + "…" : v;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Auditing FactBase YAML vs PG (${SERVER_URL})...\n`);

  console.log("1. Loading YAML facts via loadKB...");
  const yaml = await loadYamlFacts();
  console.log(
    `   ${yaml.total} source facts across ${Object.keys(yaml.byEntity).length} entities (${yaml.droppedDerived} derived facts skipped)`
  );

  console.log("\n2. Fetching PG facts via /api/facts/export...");
  const pgFacts = await fetchPgFacts();
  const pgTotal = Object.values(pgFacts).reduce((s, arr) => s + arr.length, 0);
  console.log(`   ${pgTotal} facts across ${Object.keys(pgFacts).length} entities`);

  console.log("\n3. Diffing per-fact...");
  const diff = diffFacts(yaml.byEntity, pgFacts);

  // Counts
  const byType = { A: 0, B: 0, C: 0 };
  const byField = new Map();
  for (const d of diff.fieldDiffs) {
    byType[d.type]++;
    const k = `${d.type}:${d.key}`;
    byField.set(k, (byField.get(k) || 0) + 1);
  }
  const topFields = [...byField.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);

  console.log(
    `\nDiff summary: ${diff.fieldDiffs.length} field diffs, ${diff.yamlOnly.length} yaml-only facts, ${diff.pgOnly.length} pg-only facts`
  );
  console.log(`  Type A (yaml-only field): ${byType.A}`);
  console.log(`  Type B (pg-only field):   ${byType.B}`);
  console.log(`  Type C (value mismatch):  ${byType.C}`);
  console.log(`  Type D (missing fact):    ${diff.yamlOnly.length + diff.pgOnly.length}`);
  console.log(`\nTop field diffs:`);
  for (const [k, v] of topFields) console.log(`  ${k}: ${v}`);

  // --- Write artifacts ---
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  if (!existsSync(OUT_MD_DIR)) mkdirSync(OUT_MD_DIR, { recursive: true });

  // Committed artifact — no timestamp/run metadata (see build-data-from-pg.mjs
  // for rationale: byte-identical regeneration enables drift detection).
  const diffOut = join(AUDIT_DIR, "phase-3-equivalence-audit-factbase.diff.json");
  writeFileSync(
    diffOut,
    JSON.stringify(
      {
        counts: {
          yamlTotalFacts: yaml.total,
          yamlDroppedDerived: yaml.droppedDerived,
          yamlEntities: Object.keys(yaml.byEntity).length,
          pgTotalFacts: pgTotal,
          pgEntities: Object.keys(pgFacts).length,
          A: byType.A, B: byType.B, C: byType.C,
          D: diff.yamlOnly.length + diff.pgOnly.length,
          fieldDiffs: diff.fieldDiffs.length,
          yamlOnly: diff.yamlOnly.length,
          pgOnly: diff.pgOnly.length,
        },
        yamlOnly: [...diff.yamlOnly].sort(),
        pgOnly: [...diff.pgOnly].sort(),
        fieldDiffs: [...diff.fieldDiffs].sort(
          (a, b) => a.id.localeCompare(b.id) || a.key.localeCompare(b.key)
        ),
      },
      null,
      2
    )
  );
  console.log(`\n✓ Wrote ${diffOut} (committed artifact)`);

  const mdOut = join(OUT_MD_DIR, "factbase-audit-diff.md");
  const md = [
    "# FactBase Audit Diff — per-fact\n",
    `Generated: ${new Date().toISOString()}\n`,
    "## Counts\n",
    `- YAML source facts: **${yaml.total}** (${Object.keys(yaml.byEntity).length} entities, ${yaml.droppedDerived} derived skipped)`,
    `- PG source facts: **${pgTotal}** (${Object.keys(pgFacts).length} entities)`,
    `- Type A (field in YAML, missing in PG): **${byType.A}**`,
    `- Type B (field in PG, missing in YAML): **${byType.B}**`,
    `- Type C (same field, different value): **${byType.C}**`,
    `- Type D (missing fact): **${diff.yamlOnly.length + diff.pgOnly.length}** (yamlOnly=${diff.yamlOnly.length}, pgOnly=${diff.pgOnly.length})`,
    "\n## Top field diffs\n",
    "| Type:field | Count |",
    "|---|---|",
    ...topFields.map(([k, v]) => `| \`${k}\` | ${v} |`),
  ].join("\n");
  writeFileSync(mdOut, md);
  console.log(`✓ Wrote ${mdOut} (gitignored)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
