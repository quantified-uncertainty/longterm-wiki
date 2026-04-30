#!/usr/bin/env -S node --import tsx/esm
// Recover verified+partial verdicts from existing claim batches and apply
// them to the FISA-702 entity in data/entities/responses.yaml.
//
// Used after a long-running improve-entity loop times out before workers
// finish processing claims. Pass batchIds as CLI args.

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { getClaimStatus } from "../lib/wiki-server/claims.ts";
import { applyVerdictsToPolicy, type VerifiedVerdict } from "../lib/research/apply-verdicts.ts";
import { policyCoverageScore, type PolicyEntity } from "../lib/research/gap-analyzer.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RESPONSES = path.join(ROOT, "data/entities/responses.yaml");

const SLUG = "fisa-702";

const batches = process.argv.slice(2);
if (batches.length === 0) {
  console.error("usage: apply-batches-to-fisa-702.ts <batchId> [<batchId>...]");
  process.exit(1);
}

interface ProposedClaimRow {
  id: number;
  claimText: string;
  status: string;
  verdictReasoning: string | null;
  extractedValue: string | null;
}

const all = yaml.load(fs.readFileSync(RESPONSES, "utf8")) as PolicyEntity[];
const idx = all.findIndex((e) => e.id === SLUG);
if (idx === -1) {
  console.error(`Entity not found: ${SLUG}`);
  process.exit(1);
}
let entity = all[idx];

const verdicts: VerifiedVerdict[] = [];
let totalVerified = 0;
let totalContradicted = 0;
let totalUnverifiable = 0;
let totalPending = 0;

for (const batchId of batches) {
  const r = await getClaimStatus(batchId);
  if (!r.ok) {
    console.error(`Batch ${batchId}: ${r.error ?? r.message}`);
    continue;
  }
  const data = r.data as { claims: ProposedClaimRow[]; allSettled: boolean; byStatus: Record<string, number> };
  console.log(`Batch ${batchId} settled=${data.allSettled} byStatus=${JSON.stringify(data.byStatus)}`);
  for (const c of data.claims) {
    if (c.status === "verified" || c.status === "partial") {
      totalVerified++;
      verdicts.push({
        // The original targetField, displayHint, sourceUrl are not in the
        // status response — we reconstruct best-effort from the claim text.
        // Strategy: parse the claim body to infer "provision.<slug>" or
        // "stakeholder.<slug>". For unrecoverable cases, target a freeform
        // provision and let the human review. For now, default to provision.
        targetField: inferTargetField(c.claimText),
        claimText: c.claimText,
        extractedValue: c.extractedValue,
        proposedValue: c.extractedValue,
        sourceUrl: "",
        status: c.status,
        displayHint: undefined,
      });
    } else if (c.status === "contradicted") totalContradicted++;
    else if (c.status === "unverifiable") totalUnverifiable++;
    else totalPending++;
  }
}

function inferTargetField(claimText: string): string {
  const lc = claimText.toLowerCase();
  // Detect known organizations / agencies → stakeholder
  const orgs = [
    ["aclu", "american-civil-liberties-union"],
    ["eff", "electronic-frontier-foundation"],
    ["fbi", "federal-bureau-of-investigation"],
    ["nsa", "national-security-agency"],
    ["odni", "office-of-the-director-of-national-intelligence"],
    ["cia", "central-intelligence-agency"],
    ["pclob", "privacy-and-civil-liberties-oversight-board"],
    ["fisc", "foreign-intelligence-surveillance-court"],
    ["fisa court", "foreign-intelligence-surveillance-court"],
    ["dni", "office-of-the-director-of-national-intelligence"],
    ["wyden", "ron-wyden"],
    ["jordan", "jim-jordan"],
    ["jayapal", "pramila-jayapal"],
    ["biggs", "andy-biggs"],
  ] as const;
  for (const [needle, slug] of orgs) {
    if (lc.includes(needle)) return `stakeholder.${slug}`;
  }
  // Topic-based provisions
  if (lc.includes("warrant") || lc.includes("query") || lc.includes("queries"))
    return "provision.us-person-query-procedures";
  if (lc.includes("upstream") || lc.includes("internet backbone"))
    return "provision.upstream-collection";
  if (lc.includes("prism")) return "provision.prism-collection-program";
  if (lc.includes("sunset") || lc.includes("reauthoriz"))
    return "provision.reauthorization-cycle";
  if (lc.includes("targeting") || lc.includes("non-us person"))
    return "provision.targeting-procedures";
  if (lc.includes("minimization")) return "provision.minimization-procedures";
  if (lc.includes("compelled") || lc.includes("electronic communication service provider"))
    return "provision.compelled-assistance";
  if (lc.includes("oversight") || lc.includes("compliance"))
    return "provision.oversight-and-compliance";
  // Default
  return "provision.miscellaneous";
}

console.log(
  `\nverified+partial=${totalVerified} contradicted=${totalContradicted} unverifiable=${totalUnverifiable} pending=${totalPending}`,
);

if (verdicts.length === 0) {
  console.log("Nothing to apply.");
  process.exit(0);
}

const apply = applyVerdictsToPolicy(entity, verdicts);
entity = apply.entity;

console.log("\nApplied changes:");
const counts: Record<string, number> = {};
for (const a of apply.applied) {
  counts[a.action] = (counts[a.action] ?? 0) + 1;
}
console.log(`  ${JSON.stringify(counts)}`);

all[idx] = entity;
fs.writeFileSync(
  RESPONSES,
  yaml.dump(all, { indent: 2, lineWidth: 120, noRefs: true, sortKeys: false }),
  "utf8",
);

const cov = policyCoverageScore(entity);
console.log(`\nFinal coverage: ${cov.score}`);
console.log(`Final facts: ${JSON.stringify(cov.facts_in_yaml)}`);
