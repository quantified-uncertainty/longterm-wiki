#!/usr/bin/env -S node --import tsx/esm
// Post-mortem analysis of the FISA-702 seeding session.
// For every (claim, resource) pair, fetches citation_content and buckets the claim.

import fs from "node:fs";
import path from "node:path";
import { getCitationContentByUrl } from "../lib/wiki-server/citations.ts";
import { getClaimStatus } from "../lib/wiki-server/claims.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const STATE_PATH = path.join(ROOT, ".claude/snapshots/fisa-702-seed.json");

const MAX_SOURCE_CONTENT_CHARS = 6000;

type ClaimVerdict = "verified" | "contradicted" | "unverifiable" | "pending" | "verifying";

interface CachedClaim {
  id: number;
  claimText: string;
  status: ClaimVerdict;
  verdictReasoning: string | null;
  extractedValue: string | null;
}

interface SeedState {
  resources?: Array<{ nickname: string; url: string; resourceId: string; status: string; contentLength: number | null }>;
  proposedClaims?: Array<{ key: string; claimId: number; sourceUrl: string; resourceId: string | null }>;
  lastStatus?: { batches: string[] } | unknown;
}

function loadState(): SeedState {
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as SeedState;
}

/** Extract distinguishing tokens from a claim — proper nouns, numbers, dates, statute refs. */
function keyTokens(claimText: string): string[] {
  const tokens = new Set<string>();
  // 4-digit years
  for (const m of claimText.matchAll(/\b(19|20)\d{2}\b/g)) tokens.add(m[0]);
  // Acronyms (3+ caps)
  for (const m of claimText.matchAll(/\b[A-Z]{3,}\b/g)) tokens.add(m[0]);
  // Multi-word capitalized phrases (proper nouns)
  for (const m of claimText.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g)) tokens.add(m[0]);
  // Statutory refs like "50 U.S.C. § 1881a"
  for (const m of claimText.matchAll(/\b\d+\s+U\.?S\.?C\.?\s*§?\s*\d+\w*/gi)) tokens.add(m[0]);
  // Vote tallies "212-212" or "273-147"
  for (const m of claimText.matchAll(/\b\d{2,4}-\d{2,4}\b/g)) tokens.add(m[0]);
  // Quoted phrases
  for (const m of claimText.matchAll(/'([^']{4,30})'/g)) tokens.add(m[1]);
  return [...tokens];
}

function bucket(content: string, tokens: string[]): {
  bucket: "first-6000" | "past-6000" | "absent" | "no-tokens";
  hits: Array<{ token: string; firstIdx: number }>;
  notFound: string[];
} {
  if (tokens.length === 0) return { bucket: "no-tokens", hits: [], notFound: [] };
  const lc = content.toLowerCase();
  const hits: Array<{ token: string; firstIdx: number }> = [];
  const notFound: string[] = [];
  for (const tok of tokens) {
    const idx = lc.indexOf(tok.toLowerCase());
    if (idx === -1) notFound.push(tok);
    else hits.push({ token: tok, firstIdx: idx });
  }
  if (hits.length === 0) return { bucket: "absent", hits, notFound };
  const minIdx = Math.min(...hits.map((h) => h.firstIdx));
  if (minIdx < MAX_SOURCE_CONTENT_CHARS) return { bucket: "first-6000", hits, notFound };
  return { bucket: "past-6000", hits, notFound };
}

async function main() {
  const state = loadState();
  const resources = state.resources ?? [];
  const claims = state.proposedClaims ?? [];

  // Fetch citation_content for each unique URL once.
  const urlContents = new Map<string, { length: number; firstChars: string }>();
  for (const r of resources) {
    if (r.status !== "ok") continue;
    const result = await getCitationContentByUrl(r.url);
    if (!result.ok) {
      urlContents.set(r.url, { length: 0, firstChars: "" });
      continue;
    }
    const text = (result.data as { fullText?: string }).fullText ?? "";
    urlContents.set(r.url, { length: text.length, firstChars: text });
  }

  console.log("=".repeat(80));
  console.log("Post-mortem: claim → source-content matching");
  console.log("=".repeat(80));

  const lastStatus = state.lastStatus as { batches: string[] } | undefined;

  // Pull the actual claim verdicts from the latest poll for each batch.
  const verdictByClaimId = new Map<number, CachedClaim>();
  for (const batchId of lastStatus?.batches ?? []) {
    const r = await getClaimStatus(batchId);
    if (!r.ok) continue;
    for (const c of (r.data as { claims: CachedClaim[] }).claims) {
      verdictByClaimId.set(c.id, c);
    }
  }

  const buckets: Record<string, number> = {
    "first-6000": 0,
    "past-6000": 0,
    absent: 0,
    "content-empty": 0,
    "no-tokens": 0,
  };
  const verdictByBucket: Record<string, Record<string, number>> = {};

  for (const claim of claims) {
    const verdict = verdictByClaimId.get(claim.claimId);
    if (!verdict) {
      console.log(`#${claim.claimId} ${claim.key} — no verdict yet`);
      continue;
    }
    const content = urlContents.get(claim.sourceUrl);
    if (!content || content.length === 0) {
      buckets["content-empty"]++;
      verdictByBucket["content-empty"] ??= {};
      verdictByBucket["content-empty"][verdict.status] = (verdictByBucket["content-empty"][verdict.status] ?? 0) + 1;
      console.log(`\n[${verdict.status}] #${claim.claimId} ${claim.key}`);
      console.log(`  bucket: content-empty (resource fetch failed or no content stored)`);
      continue;
    }
    const tokens = keyTokens(verdict.claimText);
    const result = bucket(content.firstChars, tokens);
    buckets[result.bucket]++;
    verdictByBucket[result.bucket] ??= {};
    verdictByBucket[result.bucket][verdict.status] = (verdictByBucket[result.bucket][verdict.status] ?? 0) + 1;

    console.log(`\n[${verdict.status}] #${claim.claimId} ${claim.key}`);
    console.log(`  source: ${claim.sourceUrl} (${content.length} chars)`);
    console.log(`  tokens: ${tokens.join(", ") || "(none extracted)"}`);
    console.log(`  bucket: ${result.bucket}`);
    if (result.hits.length > 0) {
      const sample = result.hits.slice(0, 3).map((h) => `${h.token}@${h.firstIdx}`).join(", ");
      console.log(`  hits: ${sample}`);
    }
    if (result.notFound.length > 0) {
      console.log(`  notFound: ${result.notFound.join(", ")}`);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("Summary by bucket × verdict:");
  console.log("=".repeat(80));
  for (const [b, count] of Object.entries(buckets)) {
    const breakdown = verdictByBucket[b]
      ? Object.entries(verdictByBucket[b]).map(([v, n]) => `${v}=${n}`).join(", ")
      : "—";
    console.log(`  ${b.padEnd(20)} ${count}  (${breakdown})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
