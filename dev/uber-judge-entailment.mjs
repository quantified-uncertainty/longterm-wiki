#!/usr/bin/env node
// Tiebreaker for the 106 Sonnet-vs-vLLM entailment disagreements.
//
// For each disagreement: rebuild the production entailment prompt from the
// stored claim + verified-quotes + URL + title, send it to claude-opus,
// then tally whether opus sided with Sonnet (the production judge whose
// vote was actually written to the DB) or with vLLM.
//
// Output:
//   dev/audits/uber-judge-entailment-<ts>.jsonl   — per-case verdicts
//   stdout                                        — summary tallies + the
//                                                   cases where opus
//                                                   contradicts Sonnet
//
// Opus responses are cached on disk by SHA(prompt) so re-runs hit cache.
//
// Usage: node dev/uber-judge-entailment.mjs [report-path]

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { buildEntailmentPrompt } from "../crux/lib/backfill-sources/prompts.ts";

const OPUS_MODEL = "claude-opus-4-7";
const MAX_TOKENS = 200;
const CACHE_DIR = "dev/cache/opus-entailment";
const AUDIT_DIR = "dev/audits";

async function main() {
  const reportPath = process.argv[2] || latestReport();
  const apiKey = process.env.ANTHROPIC_BILLING_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_BILLING_KEY not set");
  const client = new Anthropic({ apiKey });

  const cases = collectDisagreements(reportPath);
  console.log(`Report: ${reportPath}`);
  console.log(`Disagreements found: ${cases.length}`);
  console.log(`Tiebreaker: ${OPUS_MODEL}\n`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(AUDIT_DIR, `uber-judge-entailment-${ts}.jsonl`);
  const out = fs.createWriteStream(outPath);

  let agreeWithSonnet = 0;
  let agreeWithVllm = 0;
  let unparseable = 0;
  const sonnetSaidNoOpusSaidYes = [];   // missed matches
  const sonnetSaidYesOpusSaidNo = [];   // false positives we wrote
  const opusUnparseable = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const prompt = buildEntailmentPrompt(c.claim, c.verifiedQuotes, c.url, c.title);
    const opus = await judge(client, prompt);
    const opusDecision =
      opus.parsed === true ? "supports" : opus.parsed === false ? "no-support" : "unparseable";

    const row = {
      record_id: c.recordId,
      claim: c.claim,
      url: c.url,
      verified_quotes: c.verifiedQuotes,
      sonnet: c.sonnet,
      vllm: c.vllm,
      opus: opusDecision,
      opus_raw: opus.text,
    };
    out.write(JSON.stringify(row) + "\n");

    if (opusDecision === "unparseable") {
      unparseable++;
      opusUnparseable.push(row);
    } else if (opusDecision === c.sonnet) {
      agreeWithSonnet++;
    } else if (opusDecision === c.vllm) {
      agreeWithVllm++;
    }

    if (c.sonnet === "no-support" && opusDecision === "supports") sonnetSaidNoOpusSaidYes.push(row);
    if (c.sonnet === "supports" && opusDecision === "no-support") sonnetSaidYesOpusSaidNo.push(row);

    process.stdout.write(
      `[${i + 1}/${cases.length}] sonnet=${c.sonnet.padEnd(10)} vllm=${c.vllm.padEnd(10)} opus=${opusDecision.padEnd(12)} ${c.recordId}\n`,
    );
  }
  out.end();

  console.log(`\n=== Tally ===`);
  console.log(`  ${agreeWithSonnet}  opus agreed with Sonnet`);
  console.log(`  ${agreeWithVllm}  opus agreed with vLLM`);
  console.log(`  ${unparseable}  opus unparseable`);

  console.log(`\n=== Records we MISSED matching (sonnet=no-support, opus=supports): ${sonnetSaidNoOpusSaidYes.length} ===`);
  for (const r of sonnetSaidNoOpusSaidYes) printCase(r);

  console.log(`\n=== Records WRONGLY matched (sonnet=supports, opus=no-support): ${sonnetSaidYesOpusSaidNo.length} ===`);
  for (const r of sonnetSaidYesOpusSaidNo) printCase(r);

  console.log(`\nWrote ${outPath}`);
}

function printCase(r) {
  console.log(`  ${r.record_id}`);
  console.log(`    url:    ${r.url}`);
  console.log(`    claim:  ${r.claim.slice(0, 140)}`);
  console.log(`    quotes: ${r.verified_quotes.join(" | ").slice(0, 200)}`);
  console.log(`    opus:   ${r.opus_raw.replace(/\s+/g, " ").slice(0, 160)}`);
}

function collectDisagreements(reportPath) {
  const r = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const cases = [];
  for (const item of r.items) {
    for (const c of item.candidates || []) {
      const en = c.entailment;
      if (!en || !en.vllm) continue;
      const sonnet = en.sonnet.supports ? "supports" : "no-support";
      const vllm = en.vllm.decision;
      if (vllm === "unparseable") continue;
      if (sonnet === vllm) continue;
      const verifiedQuotes = c.quote_extraction?.haiku_verified_quotes ?? [];
      cases.push({
        recordId: `${item.record_table}/${item.record_id}`,
        claim: item.claim,
        url: c.url,
        title: c.title,
        verifiedQuotes,
        sonnet,
        vllm,
      });
    }
  }
  return cases;
}

async function judge(client, prompt) {
  const sha = crypto.createHash("sha256").update(prompt).digest("hex");
  const cached = path.join(CACHE_DIR, `${sha}.txt`);
  if (fs.existsSync(cached)) {
    const text = fs.readFileSync(cached, "utf8");
    return { text, parsed: parseSupports(text) };
  }
  const stream = client.messages.stream({
    model: OPUS_MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();
  const text = message.content.map(c => c.type === "text" ? c.text : "").join("");
  fs.writeFileSync(cached, text);
  return { text, parsed: parseSupports(text) };
}

function parseSupports(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return typeof obj.supports === "boolean" ? obj.supports : null;
  } catch {
    return null;
  }
}

function latestReport() {
  const dir = "dev/reports";
  const files = fs.readdirSync(dir).filter(f => /^backfill-unmatched-.*\.json$/.test(f)).sort();
  return `${dir}/${files.at(-1)}`;
}

main().catch(e => { console.error(e); process.exit(1); });
