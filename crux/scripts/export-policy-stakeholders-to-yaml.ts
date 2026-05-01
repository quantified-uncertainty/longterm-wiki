/**
 * Rollback artifact: PG policy_stakeholders → YAML re-export (QUA-960 step 10).
 *
 * This is the runbook for "Phase 4 cutover went wrong, get back to YAML
 * authoritative." It reads `policy_stakeholders` from wiki-server PG and
 * re-emits `stakeholders:` blocks under each matching policy entity in
 * `data/entities/responses.yaml`.
 *
 * Round-trip stability:
 *   1. Stakeholders are sorted by (policyEntityId, position-then-name) for
 *      deterministic ordering across runs.
 *   2. Empty/null fields are omitted (not emitted as `null` or `[]`) to
 *      match the YAML convention used by the original writer.
 *   3. Field key order matches `apps/web/src/data/entity-schemas.ts`'s
 *      `PolicyStakeholder` schema so a re-import yields the same object.
 *
 * **Known gap (QUA-984):** PG does not store `role`, so the rollback cannot
 * restore role annotations like "Co-sponsor" or "Primary Author". This is
 * a hard blocker for rollback fidelity — the cutover PR (QUA-960) cannot
 * ship until QUA-984 closes. Until then, this script preserves the YAML
 * `role:` field by reading the existing block and merging on stakeholder
 * name (so a no-op rollback is byte-identical when rolled-back data hasn't
 * changed since the last YAML write).
 *
 * Usage:
 *   pnpm crux scripts/export-policy-stakeholders-to-yaml [--dry-run] [--out=path]
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";
import { parseCliArgs } from "../lib/cli.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const RESPONSES_YAML = join(PROJECT_ROOT, "data/entities/responses.yaml");
const PAGE_SIZE = 200;

interface PGStakeholderRow {
  id: string;
  policyEntityId: string;
  stakeholderEntityId: string | null;
  stakeholderDisplayName: string;
  position: string;
  importance: string | null;
  reason: string | null;
  source: string | null;
  context: string[] | null;
}

interface YamlStakeholder {
  name: string;
  entityId?: string;
  position: string;
  role?: string;
  importance?: string;
  reason?: string;
  source?: string;
  context?: string[];
}

interface YamlPolicyEntity {
  id: string;
  stableId?: string;
  type: string;
  stakeholders?: YamlStakeholder[];
  [k: string]: unknown;
}

const POSITION_ORDER: Record<string, number> = {
  support: 0,
  oppose: 1,
  mixed: 2,
  neutral: 3,
};

function comparePosition(a: string, b: string): number {
  return (POSITION_ORDER[a] ?? 99) - (POSITION_ORDER[b] ?? 99);
}

async function fetchAllStakeholders(): Promise<PGStakeholderRow[]> {
  const serverUrl = getServerUrl();
  const apiKey = getApiKey();
  if (!serverUrl) throw new Error("LONGTERMWIKI_SERVER_URL is required");
  if (!apiKey) throw new Error("LONGTERMWIKI_SERVER_API_KEY is required");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const all: PGStakeholderRow[] = [];
  let offset = 0;
  while (true) {
    const resp = await fetch(
      `${serverUrl}/api/policy-stakeholders/all?limit=${PAGE_SIZE}&offset=${offset}`,
      { headers, signal: AbortSignal.timeout(30_000) },
    );
    if (!resp.ok) throw new Error(`API ${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    const rows = (data.policyStakeholders || []) as PGStakeholderRow[];
    if (rows.length === 0) break;
    all.push(...rows);
    offset += rows.length;
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * Convert a PG row to YAML shape, optionally inheriting a `role` from a
 * pre-existing YAML stakeholder with the same display name (round-trip
 * preservation while QUA-984 is open).
 */
export function pgRowToYamlStakeholder(
  row: PGStakeholderRow,
  preservedRole: string | undefined,
): YamlStakeholder {
  const out: YamlStakeholder = {
    name: row.stakeholderDisplayName,
    position: row.position,
  };
  if (row.stakeholderEntityId) out.entityId = row.stakeholderEntityId;
  if (preservedRole) out.role = preservedRole;
  if (row.importance) out.importance = row.importance;
  if (row.reason) out.reason = row.reason;
  if (row.source) out.source = row.source;
  if (Array.isArray(row.context) && row.context.length > 0) out.context = row.context;
  return out;
}

/**
 * Build the rebuilt stakeholders[] array for one policy from PG rows.
 * Deterministic sort: position bucket, then case-insensitive name.
 */
export function rebuildStakeholdersForPolicy(
  pgRows: PGStakeholderRow[],
  existingYaml: YamlStakeholder[] | undefined,
): YamlStakeholder[] {
  const yamlRoleByName = new Map<string, string>();
  if (existingYaml) {
    for (const s of existingYaml) {
      if (s.name && s.role) yamlRoleByName.set(s.name, s.role);
    }
  }
  const sorted = [...pgRows].sort((a, b) => {
    const pos = comparePosition(a.position, b.position);
    if (pos !== 0) return pos;
    return a.stakeholderDisplayName.localeCompare(b.stakeholderDisplayName, undefined, {
      sensitivity: "base",
    });
  });
  return sorted.map((r) => pgRowToYamlStakeholder(r, yamlRoleByName.get(r.stakeholderDisplayName)));
}

interface ExportResult {
  policiesUpdated: number;
  policiesSkipped: number;
  totalStakeholders: number;
  yamlBefore: string;
  yamlAfter: string;
}

export async function exportPolicyStakeholdersToYaml(options?: {
  outPath?: string;
  dryRun?: boolean;
  rows?: PGStakeholderRow[];
  yamlInput?: string;
}): Promise<ExportResult> {
  const outPath = options?.outPath ?? RESPONSES_YAML;
  const yamlBefore =
    options?.yamlInput ?? (existsSync(outPath) ? readFileSync(outPath, "utf-8") : "");
  if (!yamlBefore) throw new Error(`Cannot read YAML at ${outPath}`);

  const parsed = parseYaml(yamlBefore) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Expected array in ${outPath}`);
  const entities = parsed as YamlPolicyEntity[];

  const rows = options?.rows ?? (await fetchAllStakeholders());
  const byPolicy = new Map<string, PGStakeholderRow[]>();
  for (const r of rows) {
    if (!byPolicy.has(r.policyEntityId)) byPolicy.set(r.policyEntityId, []);
    byPolicy.get(r.policyEntityId)!.push(r);
  }

  let updated = 0;
  let skipped = 0;
  for (const e of entities) {
    if (e.type !== "policy" || !e.stableId) continue;
    const pgRows = byPolicy.get(e.stableId);
    if (!pgRows || pgRows.length === 0) {
      // Not in PG → no rollback action. Leave YAML stakeholders as-is.
      skipped++;
      continue;
    }
    e.stakeholders = rebuildStakeholdersForPolicy(pgRows, e.stakeholders);
    updated++;
  }

  // yaml.stringify with options matching the existing writer (apply-verdicts.ts).
  const yamlAfter = stringifyYaml(entities, {
    indent: 2,
    lineWidth: 120,
    sortMapEntries: false,
  });

  if (!options?.dryRun) {
    writeFileSync(outPath, yamlAfter);
  }

  return {
    policiesUpdated: updated,
    policiesSkipped: skipped,
    totalStakeholders: rows.length,
    yamlBefore,
    yamlAfter,
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const outPath = typeof args.out === "string" ? args.out : undefined;

  console.log("[export-policy-stakeholders] Reading PG…");
  const result = await exportPolicyStakeholdersToYaml({ outPath, dryRun });
  console.log(
    `  Updated: ${result.policiesUpdated} policies (${result.totalStakeholders} stakeholders)`,
  );
  console.log(`  Skipped: ${result.policiesSkipped} policies (no PG rows)`);
  if (dryRun) {
    console.log("  [dry-run] No file written");
  } else {
    console.log(`  Wrote: ${outPath ?? RESPONSES_YAML}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Export failed:", err);
    process.exit(1);
  });
}
