/**
 * Checks all source URLs in FactBase YAML files for HTTP accessibility.
 * Reports broken URLs (404, 403, timeouts) grouped by entity.
 *
 * Usage: node --import tsx/esm crux/scripts/check-source-urls.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const THINGS_DIR = join(import.meta.dirname, "../../packages/factbase/data/fb-entities");
const TIMEOUT_MS = 10_000;
const CONCURRENCY = 20;

interface UrlCheck {
  url: string;
  entity: string;
  factId: string;
  property: string;
  status: number | "timeout" | "error";
  error?: string;
}

// Extract all source URLs with context
const urlChecks: UrlCheck[] = [];
for (const filename of readdirSync(THINGS_DIR).filter((f) => f.endsWith(".yaml"))) {
  const entity = filename.replace(".yaml", "");
  const content = readFileSync(join(THINGS_DIR, filename), "utf-8");

  // Parse fact blocks to get source URLs with their fact context
  let currentFactId = "";
  let currentProperty = "";
  for (const line of content.split("\n")) {
    const idMatch = line.match(/^\s+-\s+id:\s+(.+)/);
    if (idMatch) currentFactId = idMatch[1].replace(/"/g, "");
    const propMatch = line.match(/^\s+property:\s+"?([^"\n]+)"?/);
    if (propMatch) currentProperty = propMatch[1];
    const srcMatch = line.match(/^\s+source:\s+"?([^"\s][^"\n]*)"?/);
    if (srcMatch) {
      const url = srcMatch[1].trim();
      if (url.startsWith("http")) {
        urlChecks.push({ url, entity, factId: currentFactId, property: currentProperty, status: 0 });
      }
    }
  }
}

// Deduplicate URLs (check each unique URL once)
const uniqueUrls = new Map<string, UrlCheck[]>();
for (const check of urlChecks) {
  const existing = uniqueUrls.get(check.url) ?? [];
  existing.push(check);
  uniqueUrls.set(check.url, existing);
}

console.log(`Checking ${uniqueUrls.size} unique URLs from ${urlChecks.length} source references...`);

// Check URLs with concurrency limit
const results: UrlCheck[] = [];
const urls = [...uniqueUrls.entries()];
let completed = 0;

async function checkUrl(url: string): Promise<{ status: number | "timeout" | "error"; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Longterm Wiki sourcing)" },
    });
    clearTimeout(timeout);
    return { status: res.status };
  } catch (e: unknown) {
    clearTimeout(timeout);
    if (e instanceof Error && e.name === "AbortError") return { status: "timeout" };
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

// Process in batches
for (let i = 0; i < urls.length; i += CONCURRENCY) {
  const batch = urls.slice(i, i + CONCURRENCY);
  const checks = await Promise.all(
    batch.map(async ([url, facts]) => {
      const result = await checkUrl(url);
      completed++;
      if (completed % 50 === 0) process.stderr.write(`  ${completed}/${uniqueUrls.size}\n`);
      return { url, facts, ...result };
    })
  );

  for (const { url, facts, status, error } of checks) {
    if (status === 200 || status === 301 || status === 302) continue; // OK
    for (const fact of facts) {
      results.push({ ...fact, status, error });
    }
  }
}

// Report
const byStatus = new Map<string, UrlCheck[]>();
for (const r of results) {
  const key = String(r.status);
  const existing = byStatus.get(key) ?? [];
  existing.push(r);
  byStatus.set(key, existing);
}

console.log(`\n── Results ──`);
console.log(`Total URLs checked: ${uniqueUrls.size}`);
console.log(`Broken: ${results.length} references across ${new Set(results.map((r) => r.url)).size} unique URLs`);
console.log(`OK: ${uniqueUrls.size - new Set(results.map((r) => r.url)).size}`);

for (const [status, checks] of [...byStatus.entries()].sort()) {
  console.log(`\n  Status ${status}: ${checks.length} references`);
  // Group by URL
  const byUrl = new Map<string, UrlCheck[]>();
  for (const c of checks) {
    const existing = byUrl.get(c.url) ?? [];
    existing.push(c);
    byUrl.set(c.url, existing);
  }
  for (const [url, facts] of [...byUrl.entries()].slice(0, 20)) {
    console.log(`    ${url}`);
    for (const f of facts.slice(0, 3)) {
      console.log(`      → ${f.entity} / ${f.property} (${f.factId})`);
    }
    if (facts.length > 3) console.log(`      ... and ${facts.length - 3} more`);
  }
  if (byUrl.size > 20) console.log(`    ... and ${byUrl.size - 20} more URLs`);
}
