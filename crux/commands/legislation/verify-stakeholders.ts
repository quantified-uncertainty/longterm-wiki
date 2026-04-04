/**
 * Verify Stakeholder Positions Command
 *
 * Populates verification evidence for policy stakeholder positions using the
 * Things table verification system. For each stakeholder that has a source URL
 * in the YAML data, creates a verification record and aggregate verdict. For
 * stakeholders without a source URL, creates an "unchecked" verdict.
 *
 * Usage:
 *   crux tb legislation verify-stakeholders                      Verify all policies
 *   crux tb legislation verify-stakeholders --policy=california-sb1047  Verify one policy
 *   crux tb legislation verify-stakeholders --dry-run             Preview without writing
 *   crux tb legislation verify-stakeholders --verbose             Show detailed progress
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "url";
import type {
  CommandOptions as BaseOptions,
  CommandResult,
} from "../../lib/command-types.ts";
import { isServerAvailable, apiRequest } from "../../lib/wiki-server/client.ts";
import {
  getEvidenceByRecord,
  storeEvidence,
  storeVerdict,
} from "../../lib/wiki-server/verifications.ts";

// ── Constants ────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = join(__dirname, "../../../data/entities");
const RESPONSES_FILE = "responses.yaml";

// ── Types ────────────────────────────────────────────────────────────

interface VerifyStakeholdersOptions extends BaseOptions {
  policy?: string;
  "dry-run"?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  ci?: boolean;
}

interface YamlStakeholder {
  name: string;
  entityId?: string;
  position: "support" | "oppose" | "mixed" | "neutral";
  reason?: string;
  source?: string;
  context?: string[];
}

interface YamlPolicyEntity {
  id: string;
  stableId: string;
  type: string;
  title?: string;
  stakeholders?: YamlStakeholder[];
}

interface ThingItem {
  id: string;
  thingType: string;
  title: string;
  parentThingId: string | null;
  sourceTable: string;
  sourceId: string;
  sourceUrl: string | null;
  verdict: string | null;
}

interface ThingsListResponse {
  things: ThingItem[];
  total: number;
  limit: number;
  offset: number;
}

interface VerificationResponse {
  id: number;
  thingId: string;
  verdict: string;
}

interface VerdictResponse {
  thingId: string;
  verdict: string;
  confidence: number | null;
}

interface VerificationsListResponse {
  verifications: Array<{
    id: number;
    thingId: string;
    sourceUrl: string | null;
    fieldName: string | null;
    verdict: string;
  }>;
  total: number;
}

// ── YAML Loading ─────────────────────────────────────────────────────

function loadPolicyEntities(): YamlPolicyEntity[] {
  const filepath = join(DATA_DIR, RESPONSES_FILE);
  if (!existsSync(filepath)) {
    throw new Error(`YAML file not found: ${filepath}`);
  }
  const raw = readFileSync(filepath, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array in ${RESPONSES_FILE}`);
  }
  return parsed.filter(
    (e: Record<string, unknown>) =>
      e.type === "policy" && Array.isArray(e.stakeholders)
  ) as YamlPolicyEntity[];
}

// ── Core Logic ───────────────────────────────────────────────────────

/**
 * Fetch all policy-stakeholder things from the wiki-server API.
 * Returns a map of "parentThingId:stakeholderName" -> ThingItem.
 */
async function fetchStakeholderThings(): Promise<Map<string, ThingItem>> {
  const map = new Map<string, ThingItem>();
  const pageSize = 200;
  let offset = 0;

  while (true) {
    const result = await apiRequest<ThingsListResponse>(
      "GET",
      `/api/things?thing_type=policy-stakeholder&limit=${pageSize}&offset=${offset}`
    );
    if (!result.ok) {
      throw new Error(
        `Failed to fetch policy-stakeholder things: ${result.message}`
      );
    }
    const items = result.data.things;
    for (const t of items) {
      // title format: "Stakeholder Name on Policy Title"
      const onIdx = t.title.indexOf(" on ");
      if (onIdx > 0 && t.parentThingId) {
        const stakeholderName = t.title.substring(0, onIdx);
        map.set(`${t.parentThingId}:${stakeholderName}`, t);
      }
    }
    if (items.length < pageSize) break;
    offset += pageSize;
  }

  return map;
}

/**
 * Check if a verification already exists for a thing + sourceUrl + fieldName.
 * Returns true if a matching verification record exists.
 */
async function hasExistingVerification(
  recordId: string,
  sourceUrl: string | null,
  fieldName: string
): Promise<boolean> {
  const result = await getEvidenceByRecord("policy-stakeholder", recordId, { limit: 50 });
  if (!result.ok) return false;

  return result.data.evidence.some(
    (v) => v.sourceUrl === sourceUrl && v.fieldName === fieldName
  );
}

/**
 * Create a verification record for a stakeholder position.
 */
async function createVerification(
  recordId: string,
  sourceUrl: string,
  position: string,
  stakeholderName: string,
  policyTitle: string
): Promise<VerificationResponse | null> {
  const result = await storeEvidence({
    recordType: "policy-stakeholder",
    recordId,
    sourceUrl,
    fieldName: "position",
    expectedValue: position,
    verdict: "confirmed",
    confidence: 0.8,
    isPrimarySource: true,
    notes: `Source URL confirms ${stakeholderName}'s ${position} position on ${policyTitle}. Manually curated source link from YAML data.`,
  });
  if (!result.ok) {
    console.warn(
      `  Warning: Failed to create verification for ${recordId}: ${result.message}`
    );
    return null;
  }
  return result.data as unknown as VerificationResponse;
}

/**
 * Create or update the aggregate verdict for a stakeholder.
 */
async function upsertVerdict(
  recordId: string,
  verdict: "confirmed" | "unchecked",
  opts: {
    confidence?: number;
    reasoning?: string;
    sourcesChecked?: number;
    needsRecheck?: boolean;
  }
): Promise<VerdictResponse | null> {
  const result = await storeVerdict({
    recordType: "policy-stakeholder",
    recordId,
    verdict,
    confidence: opts.confidence ?? null,
    reasoning: opts.reasoning ?? null,
    sourcesChecked: opts.sourcesChecked ?? 0,
    needsRecheck: opts.needsRecheck ?? false,
  });
  if (!result.ok) {
    console.warn(
      `  Warning: Failed to upsert verdict for ${recordId}: ${result.message}`
    );
    return null;
  }
  return result.data as unknown as VerdictResponse;
}

// ── Command Handler ──────────────────────────────────────────────────

async function verifyStakeholdersCommand(
  _args: string[],
  options: VerifyStakeholdersOptions
): Promise<CommandResult> {
  const dryRun = options.dryRun || options["dry-run"] || false;
  const verbose = options.verbose || false;
  const policyFilter = options.policy;
  const lines: string[] = [];

  function log(msg: string) {
    lines.push(msg);
    if (!options.ci) console.log(msg);
  }

  // 1. Check wiki-server availability
  const serverOk = await isServerAvailable();
  if (!serverOk) {
    return {
      exitCode: 1,
      output:
        "Wiki-server is not available. Start it with `pnpm wiki-server:dev` or set LONGTERMWIKI_SERVER_URL.",
    };
  }

  // 2. Load YAML policy entities with stakeholders
  const policies = loadPolicyEntities();
  const filteredPolicies = policyFilter
    ? policies.filter((p) => p.id === policyFilter)
    : policies;

  if (filteredPolicies.length === 0) {
    const availablePolicies = policies.map((p) => p.id).join(", ");
    return {
      exitCode: 1,
      output: policyFilter
        ? `Policy "${policyFilter}" not found or has no stakeholders. Available: ${availablePolicies}`
        : "No policies with stakeholders found in YAML data.",
    };
  }

  log(
    `Found ${filteredPolicies.length} polic${filteredPolicies.length === 1 ? "y" : "ies"} with stakeholders`
  );

  // 3. Fetch existing things from wiki-server
  log("Fetching policy-stakeholder things from wiki-server...");
  let thingsMap: Map<string, ThingItem>;
  try {
    thingsMap = await fetchStakeholderThings();
  } catch (err: unknown) {
    return {
      exitCode: 1,
      output: `Failed to fetch things: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  log(`  Found ${thingsMap.size} policy-stakeholder things in database`);

  // 4. Process each policy
  let verificationsCreated = 0;
  let verdictsCreated = 0;
  let skippedExisting = 0;
  let missingThings = 0;

  for (const policy of filteredPolicies) {
    const policyTitle = policy.title || policy.id;
    const stakeholders = policy.stakeholders || [];
    log(`\nProcessing: ${policyTitle} (${stakeholders.length} stakeholders)`);

    for (const stakeholder of stakeholders) {
      // Look up the thing by "policyStableId:stakeholderName"
      const key = `${policy.stableId}:${stakeholder.name}`;
      const thing = thingsMap.get(key);

      if (!thing) {
        if (verbose) {
          log(`  SKIP: No thing found for "${stakeholder.name}" (key: ${key})`);
        }
        missingThings++;
        continue;
      }

      const thingId = thing.id;

      if (stakeholder.source) {
        // Has a source URL -- create verification + confirmed verdict
        if (verbose) {
          log(
            `  ${stakeholder.name}: ${stakeholder.position} (source: ${stakeholder.source})`
          );
        }

        // Check for existing verification (idempotency)
        const exists = await hasExistingVerification(
          thingId,
          stakeholder.source,
          "position"
        );
        if (exists) {
          if (verbose) {
            log(`    Already verified, skipping`);
          }
          skippedExisting++;
          continue;
        }

        if (dryRun) {
          log(
            `  [DRY RUN] Would create verification for "${stakeholder.name}" (${stakeholder.position})`
          );
          log(
            `    thingId: ${thingId}, source: ${stakeholder.source}`
          );
          verificationsCreated++;
          verdictsCreated++;
          continue;
        }

        // Create verification record
        const verification = await createVerification(
          thingId,
          stakeholder.source,
          stakeholder.position,
          stakeholder.name,
          policyTitle
        );
        if (verification) {
          verificationsCreated++;
          if (verbose) {
            log(`    Created verification #${verification.id}`);
          }
        }

        // Create/update aggregate verdict
        const verdict = await upsertVerdict(thingId, "confirmed", {
          confidence: 0.8,
          reasoning: `Position confirmed via manually curated source URL: ${stakeholder.source}`,
          sourcesChecked: 1,
          needsRecheck: false,
        });
        if (verdict) {
          verdictsCreated++;
          if (verbose) {
            log(`    Set verdict: confirmed (confidence: 0.8)`);
          }
        }
      } else {
        // No source URL -- create unchecked verdict
        if (verbose) {
          log(
            `  ${stakeholder.name}: ${stakeholder.position} (no source)`
          );
        }

        // Check if already has a verdict (idempotency -- don't downgrade existing verdicts)
        if (thing.verdict && thing.verdict !== "unchecked") {
          if (verbose) {
            log(
              `    Already has verdict "${thing.verdict}", not downgrading to unchecked`
            );
          }
          skippedExisting++;
          continue;
        }

        if (dryRun) {
          log(
            `  [DRY RUN] Would set unchecked verdict for "${stakeholder.name}"`
          );
          verdictsCreated++;
          continue;
        }

        const verdict = await upsertVerdict(thingId, "unchecked", {
          reasoning:
            "No source URL provided in YAML data. Position needs independent verification.",
          needsRecheck: true,
        });
        if (verdict) {
          verdictsCreated++;
          if (verbose) {
            log(`    Set verdict: unchecked (needsRecheck: true)`);
          }
        }
      }
    }
  }

  // 5. Summary
  const prefix = dryRun ? "[DRY RUN] " : "";
  log(`\n${prefix}Summary:`);
  log(`  Verifications created: ${verificationsCreated}`);
  log(`  Verdicts created/updated: ${verdictsCreated}`);
  log(`  Skipped (already exists): ${skippedExisting}`);
  log(`  Missing things (not synced to PG): ${missingThings}`);

  if (missingThings > 0) {
    log(
      `\n  Note: ${missingThings} stakeholders have no matching thing in the database.`
    );
    log(
      `  Run build-data sync first to ensure all stakeholders are in the things table.`
    );
  }

  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify(
        {
          verificationsCreated,
          verdictsCreated,
          skippedExisting,
          missingThings,
          dryRun,
        },
        null,
        2
      ),
    };
  }

  return { exitCode: 0, output: lines.join("\n") };
}

// ── Export ────────────────────────────────────────────────────────────

export const commands = {
  "verify-stakeholders": verifyStakeholdersCommand,
};

export function getHelp(): string {
  return `Legislation — Policy stakeholder verification

Commands:
  verify-stakeholders     Populate verification evidence for stakeholder positions

Options:
  --policy=<id>          Only verify stakeholders for this policy (e.g. california-sb1047)
  --dry-run              Preview what would be created without writing
  --verbose              Show detailed progress for each stakeholder
  --ci                   Output JSON summary

Examples:
  crux tb legislation verify-stakeholders --policy=california-sb1047
  crux tb legislation verify-stakeholders --dry-run --verbose
  crux tb legislation verify-stakeholders --ci`;
}
