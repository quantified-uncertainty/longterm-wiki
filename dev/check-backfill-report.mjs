#!/usr/bin/env node
// Audits a backfill-sources report for likely false positives & false negatives.
// Usage: node dev/check-backfill-report.mjs [path-to-report.json]

import fs from 'node:fs';

const path = process.argv[2] ?? 'dev/reports/backfill-unmatched-2026-04-26T15-44-15-402Z.json';
const r = JSON.parse(fs.readFileSync(path, 'utf8'));

const matched = r.items.filter((i) => i.outcome === 'matched');
const unmatched = r.items.filter((i) => i.outcome === 'no-match');

// ---------- false positives ----------
const fp = [];
for (const m of matched) {
  const flags = [];
  const url = (m.url ?? '').toLowerCase();
  const quotes = Array.isArray(m.quotes) ? m.quotes.filter((q) => typeof q === 'string') : [];
  const entity = (m.entity_name ?? '').toLowerCase();

  if (/auto-draft|\/tag\/|\/category\/|\/feed\/|\/page\/\d+/i.test(url)) flags.push('low-quality URL');
  if (quotes.length === 0) flags.push('no quotes');
  if (quotes.length > 0 && quotes.every((q) => q.length < 30)) flags.push('all quotes very short');
  if (entity && quotes.length > 0 && !quotes.some((q) => q.toLowerCase().includes(entity.split(' ')[0]))) {
    flags.push('no quote mentions entity');
  }
  // URL is just a homepage for a "Notable For" / "Birth Year" / similar fact
  if (/^https?:\/\/[^/]+\/?$/i.test(m.url ?? '') && !/wikipedia/.test(url)) flags.push('bare homepage');
  // Y Combinator's own portfolio page is templated; flag for review but low priority
  if (/^https:\/\/ycombinator\.com\/companies\//.test(m.url ?? '')) flags.push('YC portfolio template (likely OK)');

  if (flags.length) fp.push({ id: `${m.record_table}/${m.record_id}`, url: m.url, claim: m.claim, flags, quotes });
}

console.log(`=== Likely false positives (${fp.length}/${matched.length}) ===`);
const high = fp.filter((f) => !f.flags.every((x) => x === 'YC portfolio template (likely OK)'));
console.log(`High-signal: ${high.length}`);
for (const f of high) {
  console.log(`  ${f.id}`);
  console.log(`    flags: ${f.flags.join(', ')}`);
  console.log(`    url:   ${f.url}`);
  console.log(`    claim: ${f.claim}`);
  if (f.quotes?.length === 0) console.log(`    quotes: (none)`);
}

// ---------- false negatives ----------
console.log(`\n=== Likely false negatives (sample, by reason bucket) ===`);
const reasons = {};
for (const u of unmatched) {
  const key = (u.reason ?? '').replace(/\d+/g, 'N');
  (reasons[key] ??= []).push(u);
}
for (const [reason, items] of Object.entries(reasons)) {
  console.log(`\n  [${items.length}] ${reason}`);
  for (const it of items.slice(0, 5)) {
    console.log(`    ${it.record_table}/${it.record_id}: ${it.claim.slice(0, 100)}`);
  }
}
