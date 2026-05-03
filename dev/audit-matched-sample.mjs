#!/usr/bin/env node
// Audit a sample of "matched" items from a backfill-sources report.
// For each sampled item: fetch the URL (cached on disk), strip to main text,
// ask an LLM whether the page actually backs up the claim.
//
// Usage:
//   node dev/audit-matched-sample.mjs [report-path] [N]
// Defaults: latest dev/reports/backfill-unmatched-*.json, N=60

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const JUDGE_MODEL = "claude-haiku-4-5-20251001";
const CACHE_DIR = "dev/cache/url-fetches";
const AUDIT_DIR = "dev/audits";
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function latestReport() {
  const dir = "dev/reports";
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^backfill-unmatched-.*\.json$/.test(f))
    .sort();
  if (!files.length) throw new Error("no backfill-unmatched reports found");
  return path.join(dir, files.at(-1));
}

function sampleMatched(reportPath, n) {
  const r = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const matched = r.items.filter((i) => i.outcome === "matched");
  const rng = mulberry32(0xC0FFEE);
  const idx = [...matched.keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).map((i) => matched[i]);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cachePathFor(url) {
  const h = crypto.createHash("sha256").update(url).digest("hex");
  return path.join(CACHE_DIR, `${h}.html`);
}

async function fetchAndExtract(url) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = cachePathFor(url);
  let html;
  if (fs.existsSync(cached)) {
    html = fs.readFileSync(cached, "utf8");
    if (html.startsWith("__FETCH_ERROR__")) {
      return { ok: false, error: html.replace("__FETCH_ERROR__", "").trim(), text: "" };
    }
  } else {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
        redirect: "follow",
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) {
        const err = `HTTP ${res.status}`;
        fs.writeFileSync(cached, `__FETCH_ERROR__ ${err}`);
        return { ok: false, error: err, text: "" };
      }
      html = await res.text();
      fs.writeFileSync(cached, html);
    } catch (e) {
      const err = e.name === "AbortError" ? "timeout" : String(e.message || e);
      fs.writeFileSync(cached, `__FETCH_ERROR__ ${err}`);
      return { ok: false, error: err, text: "" };
    }
  }

  return { ok: true, text: htmlToText(html).slice(0, 20_000) };
}

function htmlToText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function judgeClaim(client, item, pageText) {
  const quotes = (item.quotes || []).map((q, i) => `Q${i + 1}: ${q}`).join("\n");
  const sys =
    "You audit whether a webpage actually backs up a factual claim. " +
    'Reply with strict JSON: {"verdict":"supported|contradicted|unverifiable|page_unreachable","rationale":"<one sentence>"}.';
  const user =
    `CLAIM: ${item.claim}\n\n` +
    `URL: ${item.url}\n\n` +
    `QUOTES THE BACKFILL EXTRACTED:\n${quotes || "(none)"}\n\n` +
    `PAGE TEXT (truncated):\n${pageText || "(empty)"}`;
  const res = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 300,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  const out = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return { verdict: "unverifiable", rationale: `judge did not return JSON: ${out.slice(0, 120)}` };
  try {
    const j = JSON.parse(m[0]);
    return { verdict: j.verdict || "unverifiable", rationale: j.rationale || "" };
  } catch {
    return { verdict: "unverifiable", rationale: `bad JSON: ${m[0].slice(0, 120)}` };
  }
}

async function main() {
  const reportPath = process.argv[2] || latestReport();
  const N = Number(process.argv[3] || 60);
  const apiKey = process.env.ANTHROPIC_BILLING_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_BILLING_KEY not set");

  const client = new Anthropic({ apiKey });
  const sample = sampleMatched(reportPath, N);
  console.log(`Report: ${reportPath}`);
  console.log(`Sampling ${sample.length} matched items (judge=${JUDGE_MODEL})\n`);

  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(AUDIT_DIR, `matched-sample-${ts}.jsonl`);
  const out = fs.createWriteStream(outPath);

  const results = [];
  for (let i = 0; i < sample.length; i++) {
    const item = sample[i];
    const fetched = await fetchAndExtract(item.url);
    let verdict, rationale;
    if (!fetched.ok) {
      verdict = "page_unreachable";
      rationale = `fetch failed: ${fetched.error}`;
    } else {
      const j = await judgeClaim(client, item, fetched.text);
      verdict = j.verdict;
      rationale = j.rationale;
    }
    const row = {
      record_id: `${item.record_table}/${item.record_id}`,
      entity: item.entity_name,
      claim: item.claim,
      url: item.url,
      verdict,
      rationale,
    };
    out.write(JSON.stringify(row) + "\n");
    results.push(row);
    process.stdout.write(`[${i + 1}/${sample.length}] ${verdict.padEnd(16)} ${row.record_id}\n`);
  }
  out.end();

  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log(`\n=== Summary (n=${results.length}) ===`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.toString().padStart(3)}  ${k}`);
  }

  const failures = results.filter((r) => r.verdict !== "supported");
  console.log(`\n=== Non-supported (${failures.length}) ===`);
  for (const f of failures) {
    console.log(`  ${f.verdict}  ${f.record_id}`);
    console.log(`    url: ${f.url}`);
    console.log(`    claim: ${f.claim}`);
    console.log(`    why:   ${f.rationale}`);
  }

  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
