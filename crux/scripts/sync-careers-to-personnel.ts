/**
 * Syncs career data from career-data.json to the personnel table via wiki-server API.
 *
 * This replaces the FactBase YAML approach — career records belong in TableBase (PG),
 * not as FactBase facts.
 *
 * Usage:
 *   node --import tsx/esm crux/scripts/sync-careers-to-personnel.ts [--dry-run]
 *
 * Requires wiki-server running (or WIKI_SERVER_ENV=prod for production).
 */

import { config } from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateId } from "../lib/grant-import/id.ts";

// Load .env from repo root
config({ path: join(import.meta.dirname, "../../.env") });

// ── Types ──────────────────────────────────────────────────────────

interface CareerEntry {
  orgSlug: string | null;
  orgName: string;
  role: string;
  start: string;
  end?: string;
  source?: string;
  notes?: string;
}

interface PersonCareerData {
  personSlug: string;
  careers: CareerEntry[];
}

interface SyncItem {
  id: string;
  personId: string;
  organizationId: string;
  role: string;
  roleType: "career";
  startDate: string | null;
  endDate: string | null;
  isFounder: boolean;
  source: string | null;
  notes: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────

function loadEntityMap(yamlPath: string): Map<string, string> {
  const content = readFileSync(yamlPath, "utf-8");
  const map = new Map<string, string>();
  // Simple regex parse — avoids YAML library for speed
  const entries = content.matchAll(/^- id: (.+)\n  stableId: (.+)/gm);
  for (const match of entries) {
    map.set(match[1], match[2]);
  }
  return map;
}

function isFounderRole(role: string): boolean {
  return /\b(co-)?founder\b/i.test(role);
}

async function apiRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const isProd = process.env.WIKI_SERVER_ENV === "prod";
  const baseUrl = isProd
    ? process.env.PROD_LONGTERMWIKI_SERVER_URL
    : process.env.LONGTERMWIKI_SERVER_URL ?? "http://localhost:4850";
  const apiKey = isProd
    ? process.env.PROD_LONGTERMWIKI_SERVER_API_KEY
    : process.env.LONGTERMWIKI_SERVER_API_KEY;

  if (!baseUrl) {
    return { ok: false, error: "No wiki-server URL configured" };
  }

  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: `${res.status}: ${text.substring(0, 200)}` };
    }
    if (!res.ok) return { ok: false, error: `${res.status}: ${JSON.stringify(data)}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Main ───────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, "../..");
const CAREER_DATA_PATH = join(ROOT, "crux/scripts/career-data.json");
const dryRun = process.argv.includes("--dry-run");

// Load entity maps
const orgMap = loadEntityMap(join(ROOT, "data/entities/organizations.yaml"));
const peopleMap = loadEntityMap(join(ROOT, "data/entities/people.yaml"));

// Also check FactBase files for person stableIds not in people.yaml
function getPersonStableId(slug: string): string | null {
  const fromEntities = peopleMap.get(slug);
  if (fromEntities) return fromEntities;
  // Fall back to FactBase file
  const fbFile = join(ROOT, "packages/factbase/data/fb-entities", `${slug}.yaml`);
  if (existsSync(fbFile)) {
    const content = readFileSync(fbFile, "utf-8");
    const match = content.match(/^entity: (.+)/m);
    if (match) return match[1];
  }
  return null;
}

// Load career data
const careerData: PersonCareerData[] = JSON.parse(
  readFileSync(CAREER_DATA_PATH, "utf-8")
);

console.log(`Processing ${careerData.length} people...`);

const syncItems: SyncItem[] = [];
const missingPeople: string[] = [];
const missingOrgs = new Set<string>();

for (const person of careerData) {
  const personStableId = getPersonStableId(person.personSlug);
  if (!personStableId) {
    missingPeople.push(person.personSlug);
    continue;
  }

  for (const career of person.careers) {
    const orgStableId = career.orgSlug ? orgMap.get(career.orgSlug) ?? null : null;
    if (career.orgSlug && !orgStableId) {
      missingOrgs.add(career.orgSlug);
    }

    // Use stableId for personId/organizationId so the post-sync resolver can match
    const orgId = orgStableId ?? career.orgName;

    const id = generateId(
      `career|${personStableId}|${orgId}|${career.start}|${career.role}`
    );

    syncItems.push({
      id,
      personId: personStableId,
      organizationId: orgId,
      role: career.role,
      roleType: "career",
      startDate: career.start || null,
      endDate: career.end || null,
      isFounder: isFounderRole(career.role),
      source: career.source || null,
      notes: career.notes || null,
    });
  }
}

console.log(`Generated ${syncItems.length} personnel records`);

if (missingPeople.length > 0) {
  console.log(`\nSkipped people (no stableId): ${missingPeople.join(", ")}`);
}
if (missingOrgs.size > 0) {
  console.log(`\nUnresolved orgs (using display name): ${[...missingOrgs].sort().join(", ")}`);
}

if (dryRun) {
  console.log("\n[DRY RUN] Would sync the following records:");
  for (const item of syncItems.slice(0, 10)) {
    console.log(`  ${item.personId} → ${item.organizationId} | ${item.role} (${item.startDate}-${item.endDate || "present"})`);
  }
  if (syncItems.length > 10) {
    console.log(`  ... and ${syncItems.length - 10} more`);
  }
  process.exit(0);
}

// Batch sync to wiki-server
const BATCH_SIZE = 200;
let totalUpserted = 0;

for (let i = 0; i < syncItems.length; i += BATCH_SIZE) {
  const batch = syncItems.slice(i, i + BATCH_SIZE);
  console.log(`\nSyncing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} items)...`);

  const SKIP_REASON = encodeURIComponent("backfill: career records sync before/independent of person and org entity sync");
  // eslint-disable-next-line max-len
  const result = await apiRequest("POST", `/api/personnel/sync?skipEntityValidation=true&skipEntityValidationReason=${SKIP_REASON}&forceSkipSourcing=true&reason=${encodeURIComponent("bulk-import: career data backfill from FactBase")}`, { items: batch }); // skipEntityValidation-ok: one-shot backfill, see SKIP_REASON above
  if (result.ok) {
    totalUpserted += result.data?.upserted ?? 0;
    console.log(`  ✓ Upserted: ${result.data?.upserted}`);
  } else {
    console.error(`  ✗ Error: ${result.error}`);
    process.exit(1);
  }
}

console.log(`\n── Summary ──`);
console.log(`Total records synced: ${totalUpserted}`);
console.log(`People processed: ${careerData.length - missingPeople.length}`);
