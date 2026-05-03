#!/usr/bin/env node
// Replay the quote-extraction stage of backfill-sources against a single
// piece of text, sending the SAME prompt to Haiku and to the local vLLM,
// and print both raw responses + parsed quotes side by side.
//
// Usage: node dev/replay-judges-on-text.mjs <text-file> "<claim>" "<entity>"

import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { buildQuoteExtractionPrompt, parseQuoteResponse, verifyQuoteInContent } from "../crux/lib/backfill-sources/prompts.ts";
import { callVllm, loadVllmConfig } from "../crux/lib/backfill-sources/vllm-client.ts";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 400;

async function main() {
  const [textPath, claim, entity] = process.argv.slice(2);
  if (!textPath || !claim || !entity) {
    console.error('Usage: node dev/replay-judges-on-text.mjs <text-file> "<claim>" "<entity>"');
    process.exit(1);
  }

  const content = fs.readFileSync(textPath, "utf8");
  const prompt = buildQuoteExtractionPrompt(claim, entity, content);

  console.log(`Content length: ${content.length} chars`);
  console.log(`Prompt length:  ${prompt.length} chars`);
  console.log(`Claim:          ${claim}`);
  console.log(`Entity:         ${entity}`);

  const apiKey = process.env.ANTHROPIC_BILLING_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_BILLING_KEY not set");
  const anthropic = new Anthropic({ apiKey });
  const vllmCfg = loadVllmConfig();

  const [haiku, vllm] = await Promise.all([
    callHaiku(anthropic, prompt),
    callVllm(prompt, MAX_TOKENS, vllmCfg),
  ]);

  console.log(`\n=== Haiku (${haiku.durationMs}ms) ===`);
  console.log("RAW:", haiku.text);
  const haikuQuotes = parseQuoteResponse(haiku.text) ?? [];
  console.log(`Parsed quotes: ${haikuQuotes.length}`);
  for (const q of haikuQuotes) {
    const ok = verifyQuoteInContent(q, content);
    console.log(`  [${ok ? "verbatim" : "FABRICATED"}] ${q}`);
  }

  console.log(`\n=== vLLM (${vllm?.durationMs ?? "n/a"}ms) ===`);
  console.log("RAW:", vllm?.text ?? "(no response)");
  const vllmQuotes = vllm ? (parseQuoteResponse(vllm.text) ?? []) : [];
  console.log(`Parsed quotes: ${vllmQuotes.length}`);
  for (const q of vllmQuotes) {
    const ok = verifyQuoteInContent(q, content);
    console.log(`  [${ok ? "verbatim" : "FABRICATED"}] ${q}`);
  }
}

async function callHaiku(client, prompt) {
  const started = Date.now();
  // Match the live backfill path exactly: it uses messages.stream() then
  // awaits stream.finalMessage() (see crux/lib/llm.ts streamingCreate).
  const stream = client.messages.stream({
    model: HAIKU_MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();
  const text = message.content.map(c => c.type === "text" ? c.text : "").join("");
  return { text, durationMs: Date.now() - started };
}

main().catch(e => { console.error(e); process.exit(1); });
