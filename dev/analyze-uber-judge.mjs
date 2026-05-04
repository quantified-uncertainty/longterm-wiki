#!/usr/bin/env node
// Summarize a uber-judge-entailment JSONL audit.
//   node dev/analyze-uber-judge.mjs [path]
// Defaults to the latest file in dev/audits/.

import fs from "node:fs";
import path from "node:path";

const file = process.argv[2] || latest();
const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

let header = null, footer = null;
const cases = [];
for (const l of lines) {
  const o = JSON.parse(l);
  if (o.type === "header") header = o;
  else if (o.type === "footer") footer = o;
  else if (o.type === "case") cases.push(o);
}

console.log(`File: ${file}`);
console.log(`Started:  ${header?.started_at}`);
console.log(`Finished: ${footer?.finished_at}`);
console.log(`Cases:    ${cases.length} (header reported ${header?.disagreements_found})`);
console.log("");

// Tally Opus vs Sonnet vs vLLM
let agreeSonnet = 0, agreeVllm = 0, agreeBoth = 0, agreeNeither = 0, unparseable = 0;
let cachedCount = 0, freshCount = 0, totalCost = 0, totalCostFresh = 0;
const byTable = {};
const missedMatch = [];   // sonnet=no, opus=yes (we missed a real match)
const wronglyMatch = [];  // sonnet=yes, opus=no (we wrongly accepted)

for (const c of cases) {
  const s = c.sonnet.decision;
  const v = c.vllm.decision;
  const o = c.opus.decision;
  if (o === "unparseable") unparseable++;
  else if (o === s && o === v) agreeBoth++;
  else if (o === s) agreeSonnet++;
  else if (o === v) agreeVllm++;
  else agreeNeither++;

  if (c.opus.cached) cachedCount++; else freshCount++;
  totalCost += c.opus.cost_usd ?? 0;
  if (!c.opus.cached) totalCostFresh += c.opus.cost_usd ?? 0;

  byTable[c.record_table] ??= { total: 0, missed: 0, wrong: 0 };
  byTable[c.record_table].total++;

  if (s === "no-support" && o === "supports") {
    missedMatch.push(c);
    byTable[c.record_table].missed++;
  }
  if (s === "supports" && o === "no-support") {
    wronglyMatch.push(c);
    byTable[c.record_table].wrong++;
  }
}

console.log("=== Opus tiebreaker tally ===");
console.log(`  ${agreeSonnet.toString().padStart(3)}  Opus agreed with Sonnet (vLLM was wrong)`);
console.log(`  ${agreeVllm.toString().padStart(3)}  Opus agreed with vLLM (Sonnet was wrong)`);
console.log(`  ${agreeBoth.toString().padStart(3)}  Opus agreed with both (impossible — sanity)`);
console.log(`  ${agreeNeither.toString().padStart(3)}  Opus disagreed with both`);
console.log(`  ${unparseable.toString().padStart(3)}  unparseable`);
const decisive = agreeSonnet + agreeVllm;
console.log(`  Sonnet right: ${pct(agreeSonnet, decisive)}   vLLM right: ${pct(agreeVllm, decisive)}`);
console.log("");

console.log("=== Match-quality impact ===");
console.log(`  ${missedMatch.length}  records we MISSED matching   (sonnet=no, opus=yes — fixable lift)`);
console.log(`  ${wronglyMatch.length}  records we WRONGLY matched   (sonnet=yes, opus=no — false positives)`);
console.log("");

console.log("=== By table ===");
const tables = Object.keys(byTable).sort();
console.log(`  table                  total  missed  wrong`);
for (const t of tables) {
  const b = byTable[t];
  console.log(`  ${t.padEnd(22)} ${pad(b.total)}   ${pad(b.missed)}    ${pad(b.wrong)}`);
}
console.log("");

console.log("=== Cost ===");
console.log(`  ${cachedCount}  cached cases  (no API call)`);
console.log(`  ${freshCount}  fresh cases   ($${totalCostFresh.toFixed(4)})`);
console.log(`  $${totalCost.toFixed(4)}  total cost reported (incl. cached recomputed from saved usage)`);
console.log(`  Footer reported: $${(footer?.totals?.total_cost_usd ?? 0).toFixed(4)}`);
console.log("");

if (missedMatch.length) {
  console.log("=== Missed match records (top 20 by short claim) ===");
  for (const c of missedMatch.slice(0, 20)) {
    console.log(`  ${c.record_id}`);
    console.log(`    url:   ${c.url}`);
    console.log(`    claim: ${trunc(c.claim, 120)}`);
    console.log(`    quote: ${trunc((c.verified_quotes[0] ?? "(none)"), 140)}`);
  }
  if (missedMatch.length > 20) console.log(`  ... ${missedMatch.length - 20} more`);
  console.log("");
}

if (wronglyMatch.length) {
  console.log("=== Wrongly matched records (top 20 by short claim) ===");
  for (const c of wronglyMatch.slice(0, 20)) {
    console.log(`  ${c.record_id}`);
    console.log(`    url:   ${c.url}`);
    console.log(`    claim: ${trunc(c.claim, 120)}`);
    console.log(`    quote: ${trunc((c.verified_quotes[0] ?? "(none)"), 140)}`);
  }
  if (wronglyMatch.length > 20) console.log(`  ... ${wronglyMatch.length - 20} more`);
}

function latest() {
  const dir = "dev/audits";
  const files = fs.readdirSync(dir)
    .filter(f => /^uber-judge-entailment-.*\.jsonl$/.test(f))
    .sort();
  return path.join(dir, files.at(-1));
}
function pct(n, d) { return d ? `${((n / d) * 100).toFixed(0)}%` : "n/a"; }
function pad(n) { return String(n).padStart(5); }
function trunc(s, n) { return (s ?? "").length > n ? s.slice(0, n) + "…" : (s ?? ""); }
