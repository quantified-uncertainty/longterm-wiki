#!/usr/bin/env node

/**
 * Strict policy-stakeholders validator (QUA-964 / QUA-941 bridge).
 *
 * Runs the canonical sync-route Zod schema against every
 * `policy.stakeholders[]` block in `data/entities/responses.yaml` (and any
 * other YAML file under `data/entities/`).
 *
 * Why this exists: the QUA-941 incident was a YAML PR introducing
 * `position: reform` (an unsupported enum value). The build helper
 * silently swallowed the resulting Zod 400 from the sync route and 10 rows
 * never made it to PG. This validator runs the same Zod schema the route
 * uses, at PR-review time, so the same class of mistake fails CI rather
 * than corrupts data.
 *
 * Schema source-of-truth:
 *   apps/wiki-server/src/routes/tablebase/policy-stakeholders-schema.ts
 *
 * The validator imports `SyncStakeholderItemSchema` directly so any future
 * tightening of the route schema (new required fields, narrower enums,
 * etc.) is automatically enforced here too.
 *
 * Usage:
 *   npx tsx crux/validate/validate-policy-stakeholders-strict.ts
 *   npx tsx crux/validate/validate-policy-stakeholders-strict.ts --ci
 *
 * Exit codes:
 *   0 = OK
 *   1 = at least one stakeholder fails strict schema
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import type { ZodIssue } from "zod";
import { PROJECT_ROOT, DATA_DIR } from "../lib/content-types.ts";
import {
  SyncStakeholderItemSchema,
  VALID_POSITIONS,
  VALID_IMPORTANCE,
} from "../../apps/wiki-server/src/routes/tablebase/policy-stakeholders-schema.ts";
import type { ValidatorResult } from "./types.ts";

interface Stakeholder {
  name?: unknown;
  entityId?: unknown;
  position?: unknown;
  importance?: unknown;
  reason?: unknown;
  source?: unknown;
  context?: unknown;
  sourcing?: unknown;
}

interface PolicyEntity {
  id?: string;
  type?: string;
  stableId?: string;
  stakeholders?: Stakeholder[];
}

export interface StrictFinding {
  policyId: string;
  stakeholder: string;
  field: string;
  message: string;
  sourceFile: string;
}

function generateShortId(input: string): string {
  return createHash("sha256").update(input).digest("base64url").substring(0, 10);
}

function loadPolicyEntities(): Array<PolicyEntity & { _sourceFile: string }> {
  const entitiesDir = join(PROJECT_ROOT, DATA_DIR, "entities");
  if (!existsSync(entitiesDir)) return [];
  const files = readdirSync(entitiesDir).filter((f) => f.endsWith(".yaml"));
  const out: Array<PolicyEntity & { _sourceFile: string }> = [];
  for (const file of files) {
    const filepath = join(entitiesDir, file);
    const data = parseYaml(readFileSync(filepath, "utf-8"));
    if (!Array.isArray(data)) continue;
    for (const item of data) {
      if (item?.type === "policy" && Array.isArray(item.stakeholders) && item.stakeholders.length > 0) {
        out.push({ ...item, _sourceFile: filepath });
      }
    }
  }
  return out;
}

/**
 * Build the EXACT `item` shape that wiki-server-data.mjs sends to the sync
 * route. Mirrors the transform at apps/web/scripts/lib/wiki-server-data.mjs:917-929
 * — including its `||` semantics (any falsy value collapses to null) — so the
 * validator sends Zod the same payload the runtime helper would, and any
 * drift between the two transforms shows up here as a strict-schema failure
 * rather than a false-negative pass.
 *
 * If the route's Zod schema would reject a value (e.g. `entityId: 42`,
 * `context: "string"`, `name: 17`), we let it through unmodified and Zod
 * catches it — same as the runtime path.
 *
 * Returns null only when the helper itself would skip (no policy.stableId).
 * QUA-964 ticket calls out this exact-mirror property.
 */
function buildSyncItem(
  policy: PolicyEntity,
  s: Stakeholder,
): Record<string, unknown> {
  // The helper at wiki-server-data.mjs:914 generates the id from `${policyEntityId}:${s.name}`.
  // If either is non-string, JS coercion produces "[object Object]" / "undefined" / etc.
  // and Zod catches the bad shape via stakeholderDisplayName (must-string) or
  // policyEntityId (must-string min(1)) — same as the runtime path would.
  const nameForId = String(s.name ?? "");
  const policyEntityId = policy.stableId;
  const id = generateShortId(`${String(policyEntityId ?? "")}:${nameForId}`);
  const item: Record<string, unknown> = {
    id,
    policyEntityId,
    stakeholderEntityId: s.entityId || null,
    stakeholderDisplayName: s.name,
    position: s.position,
    reason: s.reason || null,
    source: s.source || null,
    context: s.context || null,
  };
  if (s.importance) item.importance = s.importance;
  if (s.sourcing) item.sourcing = s.sourcing;
  return item;
}

function describeIssue(issue: ZodIssue): string {
  const path = issue.path.join(".") || "(root)";
  return `${path}: ${issue.message}`;
}

export interface RunOptions {
  ci?: boolean;
}

export interface RunResult extends ValidatorResult {
  findings: StrictFinding[];
  checkedStakeholders: number;
  checkedPolicies: number;
}

/**
 * Pure evaluator — given a list of policies, return findings + counts.
 * Split from `runCheck` so tests can drive the negative path with synthetic
 * fixtures instead of mutating real YAML on disk.
 */
export function evaluatePolicies(
  policies: Array<PolicyEntity & { _sourceFile: string }>,
): {
  findings: StrictFinding[];
  checkedStakeholders: number;
  checkedPolicies: number;
  skippedPolicies: number;
} {
  const findings: StrictFinding[] = [];
  let checkedStakeholders = 0;
  let skippedPolicies = 0;

  for (const policy of policies) {
    if (!policy.stableId) {
      // Policies without stableId never get synced — mirror the build helper's
      // behavior (apps/web/scripts/lib/wiki-server-data.mjs:908-911 skips).
      skippedPolicies++;
      continue;
    }
    const policyId = policy.id ?? "(unknown)";
    for (const s of policy.stakeholders ?? []) {
      const item = buildSyncItem(policy, s);
      const stakeholderLabel =
        typeof s.name === "string" ? s.name : "(missing name)";
      checkedStakeholders++;
      const result = SyncStakeholderItemSchema.safeParse(item);
      if (!result.success) {
        for (const issue of result.error.issues) {
          findings.push({
            policyId,
            stakeholder: stakeholderLabel,
            field: issue.path.join(".") || "(root)",
            message: describeIssue(issue),
            sourceFile: policy._sourceFile,
          });
        }
      }
    }
  }

  return {
    findings,
    checkedStakeholders,
    checkedPolicies: policies.length - skippedPolicies,
    skippedPolicies,
  };
}

export async function runCheck(options: RunOptions = {}): Promise<RunResult> {
  const policies = loadPolicyEntities();
  const { findings, checkedStakeholders, checkedPolicies, skippedPolicies } =
    evaluatePolicies(policies);

  if (options.ci) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: findings.length === 0,
          checkedPolicies,
          checkedStakeholders,
          findings,
        },
        null,
        2,
      ) + "\n",
    );
  } else if (findings.length === 0) {
    console.log(
      `✓ policy-stakeholders strict: ${checkedStakeholders} stakeholders across ${checkedPolicies} policies pass route Zod schema.`,
    );
    if (skippedPolicies > 0) {
      console.log(
        `  (${skippedPolicies} polic${skippedPolicies === 1 ? "y" : "ies"} skipped — no stableId, won't sync)`,
      );
    }
  } else {
    console.error(
      `✗ policy-stakeholders strict: ${findings.length} schema violation${findings.length === 1 ? "" : "s"} (across ${checkedStakeholders} stakeholders):`,
    );
    for (const f of findings) {
      console.error(
        `  [${f.policyId} / ${f.stakeholder}] ${f.message}  (${f.sourceFile})`,
      );
    }
    console.error("");
    console.error(
      `Allowed positions: ${VALID_POSITIONS.join(", ")}`,
    );
    console.error(
      `Allowed importance: ${VALID_IMPORTANCE.join(", ")}`,
    );
    console.error(
      "\nThe sync route's Zod schema rejects these payloads with a 400. " +
        "Build now fails loud (QUA-964) — so silent data drops like QUA-941 cannot recur. " +
        "Fix the YAML or extend the schema in policy-stakeholders-schema.ts.",
    );
  }

  return {
    passed: findings.length === 0,
    errors: findings.length,
    warnings: 0,
    infos: 0,
    findings,
    checkedStakeholders,
    checkedPolicies,
  };
}

async function main(): Promise<void> {
  const ci = process.argv.includes("--ci") || process.argv.includes("--json");
  const result = await runCheck({ ci });
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("validate-policy-stakeholders-strict crashed:", err);
    process.exit(1);
  });
}
