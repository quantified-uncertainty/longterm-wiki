#!/usr/bin/env node
// For each unmatched record in a backfill-sources report, classify the
// failure mode and tally per-table + overall.
//
// Failure modes:
//   no-candidates              — search returned 0 URLs
//   all-self-domain            — every candidate was a self-domain (sourcing loop)
//   all-placeholder-url        — every candidate was a placeholder/draft URL
//   all-too-short              — every candidate had <50 chars of content
//   all-no-entity-mention      — page didn't mention the entity (cheap pre-LLM gate)
//   all-no-quote               — Haiku returned no supporting quote
//   all-quote-fabricated       — Haiku's quotes failed substring-verify
//   all-entailment-failed      — Sonnet judged the verified quotes as not supporting
//   mixed                      — multiple rejection reasons across the candidates
//
// Usage: node dev/bucket-unmatched.mjs [report-path]

import fs from "node:fs";

const reportPath = process.argv[2] || latestReport();
const r = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const unmatched = r.items.filter(i => i.outcome === "no-match");

const buckets = {};        // overall
const perTable = {};       // table -> bucket -> count

for (const item of unmatched) {
  const bucket = classify(item);
  buckets[bucket] = (buckets[bucket] || 0) + 1;
  perTable[item.record_table] ??= {};
  perTable[item.record_table][bucket] = (perTable[item.record_table][bucket] || 0) + 1;
}

console.log(`Report: ${reportPath}`);
console.log(`Unmatched records: ${unmatched.length}\n`);

console.log("=== Overall failure modes ===");
const sorted = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted) {
  console.log(`  ${v.toString().padStart(4)}  ${(v / unmatched.length * 100).toFixed(1).padStart(5)}%  ${k}`);
}

console.log("\n=== Per-table ===");
const tables = Object.keys(perTable).sort((a, b) => sumValues(perTable[b]) - sumValues(perTable[a]));
for (const table of tables) {
  const tot = sumValues(perTable[table]);
  console.log(`\n  [${table}] ${tot} unmatched`);
  const rows = Object.entries(perTable[table]).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of rows) {
    console.log(`    ${v.toString().padStart(4)}  ${(v / tot * 100).toFixed(0).padStart(3)}%  ${k}`);
  }
}

function classify(item) {
  const cs = item.candidates || [];
  if (cs.length === 0) return "no-candidates";
  const reasons = new Set(cs.map(c => c.rejection_reason));
  if (reasons.size === 1) {
    const only = [...reasons][0];
    return `all-${only}`;
  }
  return "mixed";
}

function sumValues(obj) {
  return Object.values(obj).reduce((a, b) => a + b, 0);
}

function latestReport() {
  const dir = "dev/reports";
  const files = fs.readdirSync(dir).filter(f => /^backfill-unmatched-.*\.json$/.test(f)).sort();
  return `${dir}/${files.at(-1)}`;
}
