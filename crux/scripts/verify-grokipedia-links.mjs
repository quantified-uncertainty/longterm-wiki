/**
 * Verify Grokipedia links in external-links.yaml via curl HEAD requests.
 * Removes broken (404) links and reports results.
 *
 * Usage:
 *   node --import tsx/esm crux/scripts/verify-grokipedia-links.mjs           # dry run
 *   node --import tsx/esm crux/scripts/verify-grokipedia-links.mjs --apply   # remove broken links
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parse, stringify } from "yaml";
import { execFileSync } from "child_process";

const PROJECT_ROOT = join(import.meta.dirname, "../..");
const EXTERNAL_LINKS_YAML = join(PROJECT_ROOT, "data/external-links.yaml");
const APP_EXTERNAL_LINKS_YAML = join(PROJECT_ROOT, "apps/web/src/data/external-links.yaml");

const apply = process.argv.includes("--apply");

/**
 * Check URL via curl HEAD request. Returns HTTP status code.
 */
function checkUrl(url) {
  try {
    const status = execFileSync(
      "curl",
      ["-sI", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8", url],
      { encoding: "utf-8", timeout: 12000 }
    ).trim();
    return parseInt(status, 10) || 0;
  } catch {
    return 0;
  }
}

// Load data
const entries = parse(readFileSync(EXTERNAL_LINKS_YAML, "utf-8")) || [];
const grokEntries = entries.filter(e => e.links?.grokipedia);
console.log(`Found ${grokEntries.length} entries with Grokipedia links\n`);

// Check all URLs sequentially (curl doesn't parallelize well via execSync)
const valid = [];
const broken = [];
const errors = [];

for (let i = 0; i < grokEntries.length; i++) {
  const entry = grokEntries[i];
  const url = entry.links.grokipedia;
  const status = checkUrl(url);

  if (i % 10 === 0 && i > 0) {
    process.stdout.write(`\r  Checked ${i}/${grokEntries.length} (${valid.length} valid, ${broken.length} broken)...`);
  }

  if (status >= 200 && status < 400) {
    valid.push({ pageId: entry.pageId, url, status });
  } else if (status === 404) {
    broken.push({ pageId: entry.pageId, url });
  } else {
    errors.push({ pageId: entry.pageId, url, status });
  }
}
process.stdout.write(`\r  Checked ${grokEntries.length}/${grokEntries.length}                                    \n\n`);

console.log(`VALID (${valid.length}):`);
valid.forEach(r => console.log(`  ${r.pageId} → ${r.url}`));

console.log(`\nBROKEN / 404 (${broken.length}):`);
broken.forEach(r => console.log(`  ${r.pageId} → ${r.url}`));

if (errors.length > 0) {
  console.log(`\nERRORS / TIMEOUT (${errors.length}):`);
  errors.forEach(r => console.log(`  ${r.pageId} → ${r.url} [${r.status}]`));
}

console.log(`\nSummary: ${valid.length} valid, ${broken.length} broken, ${errors.length} errors`);

if (apply && broken.length > 0) {
  console.log(`\nRemoving ${broken.length} broken Grokipedia links...`);
  const brokenIds = new Set(broken.map(r => r.pageId));

  for (const entry of entries) {
    if (brokenIds.has(entry.pageId) && entry.links.grokipedia) {
      delete entry.links.grokipedia;
    }
  }

  // Remove entries that now have empty links
  const cleaned = entries.filter(e => Object.keys(e.links).length > 0);
  cleaned.sort((a, b) => a.pageId.localeCompare(b.pageId));

  const yamlStr = stringify(cleaned, { lineWidth: 0, defaultKeyType: "PLAIN", defaultStringType: "PLAIN" });
  writeFileSync(EXTERNAL_LINKS_YAML, yamlStr);
  writeFileSync(APP_EXTERNAL_LINKS_YAML, yamlStr);
  console.log(`Removed ${broken.length} broken links. ${entries.length - cleaned.length} empty entries removed.`);
  console.log(`Written to both YAML files.`);
} else if (!apply && broken.length > 0) {
  console.log(`\nDry run — use --apply to remove broken links.`);
}
