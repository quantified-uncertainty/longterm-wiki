#!/usr/bin/env node
// Tiebreaker for the Sonnet-vs-vLLM entailment disagreements in a backfill
// report.
//
// For each disagreement: rebuild the production entailment prompt from the
// stored claim + verified-quotes + URL + title, send it to claude-opus, then
// classify whether opus sided with Sonnet (the production judge whose vote
// drove the DB write) or with vLLM.
//
// Output (single file, all info — no JSONL):
//   dev/audits/uber-judge-entailment-<ts>.json
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

// Opus 4.x pricing (USD per token). Update if Anthropic changes rates.
const OPUS_INPUT_USD_PER_TOKEN = 15 / 1_000_000;
const OPUS_OUTPUT_USD_PER_TOKEN = 75 / 1_000_000;
const OPUS_CACHE_WRITE_USD_PER_TOKEN = 18.75 / 1_000_000;
const OPUS_CACHE_READ_USD_PER_TOKEN = 1.5 / 1_000_000;

function usageCostUsd(usage) {
  if (!usage) return 0;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    input * OPUS_INPUT_USD_PER_TOKEN +
    output * OPUS_OUTPUT_USD_PER_TOKEN +
    cacheWrite * OPUS_CACHE_WRITE_USD_PER_TOKEN +
    cacheRead * OPUS_CACHE_READ_USD_PER_TOKEN
  );
}

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

  // Stream JSONL. Layout:
  //   line 1   — {type: "header", ...run metadata}
  //   line 2-N — {type: "case", ...all info for one disagreement}
  //   line N+1 — {type: "footer", totals + categorized record_ids + total cost}
  //
  // Each case line is flushed immediately so the file is useful even if the
  // run is interrupted mid-loop.
  const out = fs.createWriteStream(outPath, { flags: "w" });
  const writeLine = obj => out.write(JSON.stringify(obj) + "\n");

  const startedAt = new Date().toISOString();
  writeLine({
    type: "header",
    started_at: startedAt,
    source_report: reportPath,
    tiebreaker_model: OPUS_MODEL,
    max_tokens: MAX_TOKENS,
    disagreements_found: cases.length,
  });

  let agreeWithSonnet = 0;
  let agreeWithVllm = 0;
  let unparseable = 0;
  let totalCostUsd = 0;
  const missedMatchIds = [];        // sonnet=no, opus=yes
  const wronglyMatchedIds = [];     // sonnet=yes, opus=no
  const unparseableIds = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const prompt = buildEntailmentPrompt(c.claim, c.verifiedQuotes, c.url, c.title);
    const opus = await judge(client, prompt);
    const opusDecision =
      opus.parsed === true ? "supports" : opus.parsed === false ? "no-support" : "unparseable";

    totalCostUsd += opus.costUsd;

    const row = {
      type: "case",
      index: i,
      record_id: c.recordId,
      record_table: c.recordTable,
      record_id_only: c.recordIdOnly,
      claim: c.claim,
      url: c.url,
      title: c.title,
      content_sha256: c.contentSha256,
      content_chars: c.contentChars,
      verified_quotes: c.verifiedQuotes,
      sonnet: {
        decision: c.sonnetDecision,
        raw_text: c.sonnetRawText,
        duration_ms: c.sonnetDurationMs,
      },
      vllm: {
        decision: c.vllmDecision,
        raw_text: c.vllmRawText,
        duration_ms: c.vllmDurationMs,
      },
      opus: {
        decision: opusDecision,
        raw_text: opus.text,
        duration_ms: opus.durationMs,
        prompt_sha256: opus.promptSha,
        cached: opus.cached,
        usage: opus.usage,
        cost_usd: opus.costUsd,
      },
    };
    writeLine(row);

    if (opusDecision === "unparseable") {
      unparseable++;
      unparseableIds.push(c.recordId);
    } else if (opusDecision === c.sonnetDecision) {
      agreeWithSonnet++;
    } else if (opusDecision === c.vllmDecision) {
      agreeWithVllm++;
    }

    if (c.sonnetDecision === "no-support" && opusDecision === "supports") {
      missedMatchIds.push(c.recordId);
    }
    if (c.sonnetDecision === "supports" && opusDecision === "no-support") {
      wronglyMatchedIds.push(c.recordId);
    }

    process.stdout.write(
      `[${i + 1}/${cases.length}] sonnet=${c.sonnetDecision.padEnd(10)} vllm=${c.vllmDecision.padEnd(10)} opus=${opusDecision.padEnd(12)} ${c.recordId}\n`,
    );
  }

  const finishedAt = new Date().toISOString();
  writeLine({
    type: "footer",
    started_at: startedAt,
    finished_at: finishedAt,
    totals: {
      disagreements_found: cases.length,
      opus_agreed_with_sonnet: agreeWithSonnet,
      opus_agreed_with_vllm: agreeWithVllm,
      opus_unparseable: unparseable,
      total_cost_usd: totalCostUsd,
    },
    missed_match_record_ids: missedMatchIds,
    wrongly_matched_record_ids: wronglyMatchedIds,
    unparseable_record_ids: unparseableIds,
  });
  out.end();

  console.log(`\n=== Tally ===`);
  console.log(`  ${agreeWithSonnet}  opus agreed with Sonnet`);
  console.log(`  ${agreeWithVllm}  opus agreed with vLLM`);
  console.log(`  ${unparseable}  opus unparseable`);
  console.log(`  $${totalCostUsd.toFixed(4)}  total cost`);

  console.log(`\n=== Records we MISSED matching (sonnet=no-support, opus=supports): ${missedMatchIds.length} ===`);
  for (const id of missedMatchIds) console.log(`  ${id}`);

  console.log(`\n=== Records WRONGLY matched (sonnet=supports, opus=no-support): ${wronglyMatchedIds.length} ===`);
  for (const id of wronglyMatchedIds) console.log(`  ${id}`);

  console.log(`\nWrote ${outPath}`);
}

function printCase(r) {
  console.log(`  ${r.record_id}`);
  console.log(`    url:    ${r.url}`);
  console.log(`    claim:  ${r.claim.slice(0, 140)}`);
  console.log(`    quotes: ${r.verified_quotes.join(" | ").slice(0, 200)}`);
  console.log(`    opus:   ${r.opus.raw_text.replace(/\s+/g, " ").slice(0, 160)}`);
}

function collectDisagreements(reportPath) {
  const r = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const cases = [];
  for (const item of r.items) {
    for (const c of item.candidates || []) {
      const en = c.entailment;
      if (!en || !en.vllm) continue;
      const sonnetDecision = en.sonnet.supports ? "supports" : "no-support";
      const vllmDecision = en.vllm.decision;
      if (vllmDecision === "unparseable") continue;
      if (sonnetDecision === vllmDecision) continue;
      const verifiedQuotes = c.quote_extraction?.haiku_verified_quotes ?? [];
      cases.push({
        recordId: `${item.record_table}/${item.record_id}`,
        recordTable: item.record_table,
        recordIdOnly: item.record_id,
        claim: item.claim,
        url: c.url,
        title: c.title ?? null,
        contentSha256: c.content_sha256 ?? null,
        contentChars: c.content_chars ?? null,
        verifiedQuotes,
        sonnetDecision,
        sonnetRawText: en.sonnet.raw_text,
        sonnetDurationMs: en.sonnet.duration_ms,
        vllmDecision,
        vllmRawText: en.vllm.raw_text,
        vllmDurationMs: en.vllm.duration_ms,
      });
    }
  }
  return cases;
}

async function judge(client, prompt) {
  const promptSha = crypto.createHash("sha256").update(prompt).digest("hex");
  const textCache = path.join(CACHE_DIR, `${promptSha}.txt`);
  const usageCache = path.join(CACHE_DIR, `${promptSha}.usage.json`);
  if (fs.existsSync(textCache)) {
    const text = fs.readFileSync(textCache, "utf8");
    let usage = null;
    if (fs.existsSync(usageCache)) {
      try { usage = JSON.parse(fs.readFileSync(usageCache, "utf8")); } catch { /* ignore */ }
    }
    return {
      text,
      parsed: parseSupports(text),
      durationMs: 0,
      promptSha,
      cached: true,
      usage,
      costUsd: usageCostUsd(usage),
    };
  }
  const started = Date.now();
  const stream = client.messages.stream({
    model: OPUS_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();
  const text = message.content.map(c => c.type === "text" ? c.text : "").join("");
  const usage = message.usage ?? null;
  fs.writeFileSync(textCache, text);
  if (usage) fs.writeFileSync(usageCache, JSON.stringify(usage));
  return {
    text,
    parsed: parseSupports(text),
    durationMs: Date.now() - started,
    promptSha,
    cached: false,
    usage,
    costUsd: usageCostUsd(usage),
  };
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
