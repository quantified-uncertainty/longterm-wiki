#!/usr/bin/env node
// Compare Haiku vs vLLM observations from a backfill-sources report.
// Reads the v2 report shape: candidate.quote_extraction.{haiku,vllm} and
// candidate.entailment.{sonnet,vllm}.
//
// Usage: node dev/compare-judges.mjs [report-path]

import fs from "node:fs";

const reportPath = process.argv[2] || latestReport();
const r = JSON.parse(fs.readFileSync(reportPath, "utf8"));

let qBoth = 0, qAgree = 0, qOnlyHaiku = 0, qOnlyVllm = 0, qBothEmpty = 0;
let eBoth = 0, eAgree = 0, eHaikuOnly = 0, eVllmOnly = 0, eVllmUnparseable = 0;
const disagreements = [];

for (const item of r.items) {
  for (const c of item.candidates || []) {
    const qe = c.quote_extraction;
    if (qe && qe.vllm) {
      qBoth++;
      const h = qe.haiku.quotes.length, v = qe.vllm.quotes.length;
      if (h > 0 && v > 0) qAgree++;
      else if (h > 0 && v === 0) qOnlyHaiku++;
      else if (h === 0 && v > 0) qOnlyVllm++;
      else qBothEmpty++;
    }
    const en = c.entailment;
    if (en && en.vllm) {
      eBoth++;
      const h = en.sonnet.supports ? "supports" : "no-support";
      const v = en.vllm.decision;
      if (v === "unparseable") {
        eVllmUnparseable++;
      } else if (h === v) {
        eAgree++;
      } else if (h === "supports" && v === "no-support") {
        eHaikuOnly++;
        disagreements.push({ kind: "entailment", haiku: h, vllm: v, c, item });
      } else {
        eVllmOnly++;
        disagreements.push({ kind: "entailment", haiku: h, vllm: v, c, item });
      }
    }
  }
}

console.log(`Report: ${reportPath}`);
console.log(`\n=== Quote extraction (n=${qBoth} candidates ran both) ===`);
console.log(`  ${qAgree.toString().padStart(3)} both found quotes`);
console.log(`  ${qBothEmpty.toString().padStart(3)} both returned empty`);
console.log(`  ${qOnlyHaiku.toString().padStart(3)} only Haiku found quotes`);
console.log(`  ${qOnlyVllm.toString().padStart(3)} only vLLM found quotes`);
const qAgreeRate = qBoth ? (qAgree + qBothEmpty) / qBoth : 0;
console.log(`  agreement rate: ${(qAgreeRate * 100).toFixed(1)}%`);

console.log(`\n=== Entailment (n=${eBoth} candidates ran both) ===`);
console.log(`  ${eAgree.toString().padStart(3)} agree`);
console.log(`  ${eHaikuOnly.toString().padStart(3)} Sonnet=supports, vLLM=no-support`);
console.log(`  ${eVllmOnly.toString().padStart(3)} Sonnet=no-support, vLLM=supports`);
console.log(`  ${eVllmUnparseable.toString().padStart(3)} vLLM unparseable`);

if (disagreements.length) {
  console.log(`\n=== Entailment disagreements (${disagreements.length}) ===`);
  for (const d of disagreements) {
    console.log(`  ${d.item.record_id} :: Sonnet=${d.haiku} vLLM=${d.vllm}`);
    console.log(`    url:   ${d.c.url}`);
    console.log(`    claim: ${d.item.claim.slice(0, 120)}`);
    console.log(`    quotes: ${(d.c.quote_extraction?.haiku_verified_quotes || []).join(" | ").slice(0, 200)}`);
  }
}

function latestReport() {
  const dir = "dev/reports";
  const files = fs.readdirSync(dir).filter(f => /^backfill-unmatched-.*\.json$/.test(f)).sort();
  return `${dir}/${files.at(-1)}`;
}
