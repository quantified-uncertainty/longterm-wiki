// @ts-nocheck — standalone experiment script, not part of the app build
/**
 * Source-First Claim Extraction Experiment — Kalshi
 *
 * The KEY experiment: extract claims directly from raw source documents,
 * never looking at the existing wiki page. Then compose a page from those
 * claims. This tests the actual proposed claim-first workflow:
 *
 *   Source documents → Extract claims → Deduplicate → Verify (cross-ref) → Compose
 *
 * Compare output against the existing Kalshi wiki page to measure whether
 * source-first produces better/worse/different knowledge.
 *
 * Usage:
 *   node --import tsx/esm crux/experiments/claim-first-kalshi-from-sources.ts [--verbose]
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { citationContent as citationContentDb } from "../lib/knowledge-db.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../");

const OUTPUT_DIR = path.join(ROOT, ".claude/claim-first-experiment/source-first");
const KALSHI_ARCHIVE = path.join(ROOT, "data/citation-archive/kalshi.yaml");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── LLM Helper ────────────────────────────────────────────────────────────────
let callOpenRouter: (system: string, user: string, opts?: { model?: string; maxTokens?: number }) => Promise<string>;

async function initLLM() {
  const mod = await import("../lib/quote-extractor.ts");
  callOpenRouter = mod.callOpenRouter;
}

const FAST_MODEL = "google/gemini-2.0-flash-001";
const STRONG_MODEL = "anthropic/claude-sonnet-4";

interface CostTracker { calls: number; inputTokensEst: number; outputTokensEst: number; }
const cost: CostTracker = { calls: 0, inputTokensEst: 0, outputTokensEst: 0 };

async function llm(system: string, user: string, opts?: { model?: string; maxTokens?: number }): Promise<string> {
  cost.calls++;
  cost.inputTokensEst += Math.ceil((system.length + user.length) / 4);
  const result = await callOpenRouter(system, user, { model: opts?.model ?? FAST_MODEL, maxTokens: opts?.maxTokens ?? 4096 });
  cost.outputTokensEst += Math.ceil(result.length / 4);
  return result;
}

// ─── Types ──────────────────────────────────────────────────────────────────────

interface SourceClaim {
  id: string;
  text: string;
  type: "factual" | "numeric" | "consensus" | "analytical" | "speculative" | "relational";
  sourceUrl: string;
  sourceTitle: string;
  sourceQuote?: string; // supporting quote from the source
  entityRefs: string[];
  topic: string; // auto-assigned topic cluster
  temporal?: { type: string; date?: string; };
  importance?: number; // 1-10, assigned during editorial pass
}

interface DeduplicatedClaim extends SourceClaim {
  sourceCount: number; // how many sources mentioned this
  allSources: { url: string; title: string; quote?: string }[];
  confidence: "multi-source" | "single-source" | "analytical";
}

// ─── Utility ────────────────────────────────────────────────────────────────────

function save(filename: string, data: unknown): string {
  const filepath = path.join(OUTPUT_DIR, filename);
  if (typeof data === "string") fs.writeFileSync(filepath, data);
  else fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`  → Saved: ${path.relative(ROOT, filepath)}`);
  return filepath;
}

function parseJsonRobust(raw: string): any[] | null {
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;
  const text = jsonMatch[0];
  try { return JSON.parse(text); } catch {}
  const cleaned = text
    .replace(/[\x00-\x1f]/g, " ")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\\'/g, "'")
    .replace(/\\\$/g, "$")
    .replace(/\n\s*\/\/[^\n]*/g, "");
  try { return JSON.parse(cleaned); } catch {}
  // Object-by-object extraction
  try {
    const objects: any[] = [];
    const objRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
    let match;
    while ((match = objRegex.exec(cleaned)) !== null) {
      try {
        const obj = JSON.parse(match[0]);
        if (obj.text) objects.push(obj);
      } catch {
        try {
          const obj = JSON.parse(match[0].replace(/,\s*\}/g, "}"));
          if (obj.text) objects.push(obj);
        } catch {}
      }
    }
    if (objects.length > 0) return objects;
  } catch {}
  return null;
}

const verbose = process.argv.includes("--verbose");
function log(msg: string) { if (verbose) console.log(`  [debug] ${msg}`); }

// ─── Step 1: Load Source Documents ──────────────────────────────────────────────

interface SourceDoc {
  url: string;
  title: string;
  content: string;
  importance: number; // estimated from source type
}

function step1_loadSources(): SourceDoc[] {
  console.log("\n━━━ Step 1: Load Source Documents ━━━\n");

  const archive: any = yaml.load(fs.readFileSync(KALSHI_ARCHIVE, "utf-8"));
  const citations = archive.citations ?? [];
  const uniqueUrls = [...new Set(citations.map((c: any) => c.url))] as string[];

  const sources: SourceDoc[] = [];
  for (const url of uniqueUrls) {
    const cached = citationContentDb.getByUrl(url);
    if (!cached?.full_text || cached.full_text.length < 200) continue;

    // Estimate importance based on source type
    let importance = 5;
    if (url.includes("wikipedia.org")) importance = 7;
    else if (url.includes("contrary.com") || url.includes("sacra.com")) importance = 8;
    else if (url.includes("forum.effectivealtruism.org")) importance = 6;
    else if (url.includes("news.kalshi.com") || url.includes("kalshi.com")) importance = 7;
    else if (url.includes("nhl.com") || url.includes("espn.com")) importance = 7;
    else if (url.includes("cbsnews.com") || url.includes("axios.com")) importance = 7;
    else if (url.includes("substack.com")) importance = 5;
    else if (url.includes("gamblingharm.org")) importance = 4;

    sources.push({
      url,
      title: cached.page_title ?? url,
      content: cached.full_text,
      importance,
    });
  }

  // Sort by importance (most important first)
  sources.sort((a, b) => b.importance - a.importance || b.content.length - a.content.length);

  console.log(`  Loaded ${sources.length} source documents`);
  console.log(`  Total content: ${sources.reduce((s, d) => s + d.content.length, 0).toLocaleString()} chars`);
  console.log(`  Top sources:`);
  for (const s of sources.slice(0, 8)) {
    console.log(`    [imp=${s.importance}] ${s.title?.slice(0, 70)} (${(s.content.length / 1000).toFixed(1)}K)`);
  }

  save("step1-sources.json", sources.map(s => ({ url: s.url, title: s.title, importance: s.importance, contentLength: s.content.length })));
  return sources;
}

// ─── Step 2: Extract Claims from Each Source ────────────────────────────────────

async function step2_extractClaims(sources: SourceDoc[]): Promise<SourceClaim[]> {
  console.log("\n━━━ Step 2: Extract Claims from Source Documents ━━━\n");

  const allClaims: SourceClaim[] = [];
  let claimCounter = 0;

  for (const source of sources) {
    console.log(`  Extracting from: ${source.title?.slice(0, 60)} (${(source.content.length / 1000).toFixed(1)}K)`);

    // Use up to 5000 chars per source (enough for good extraction, fits in context)
    const contentChunk = source.content.slice(0, 5000);

    const prompt = `Extract all factual claims about Kalshi from this source document. For each claim, output a JSON array of objects:

- "text": the atomic claim as plain text (one verifiable fact per claim)
- "type": "factual" | "numeric" | "consensus" | "analytical" | "speculative" | "relational"
- "quote": the exact phrase or sentence from the source supporting this claim (max 200 chars)
- "entityRefs": entity IDs mentioned (lowercase-hyphenated: "kalshi", "cftc", "polymarket")
- "topic": classify into one of: "founding", "funding", "regulatory", "operations", "partnerships", "competition", "ai-safety", "community-reception", "consumer-concerns", "market-data"
- "temporal": {"type": "historical"|"point-in-time"|"ongoing"|"projection", "date": "YYYY" or "YYYY-MM"} if applicable

Rules:
- Extract ONLY claims about Kalshi or directly relevant to Kalshi
- One claim per verifiable fact
- Keep claim text as simple plain text
- Include supporting quote from the source text
- Skip opinions that aren't attributed to specific people/organizations

Source title: ${source.title}
Source URL: ${source.url}
Source content:
${contentChunk}

Output ONLY a valid JSON array:`;

    try {
      const response = await llm(
        "You extract factual claims about a specific company from source documents. Output only valid JSON arrays. Be thorough but precise.",
        prompt,
        { maxTokens: 8192 }
      );

      const parsed = parseJsonRobust(response);
      if (!parsed || parsed.length === 0) {
        console.log(`    ⚠ No claims extracted`);
        continue;
      }

      for (const raw of parsed) {
        if (!raw.text) continue;
        claimCounter++;
        allClaims.push({
          id: `cs-${String(claimCounter).padStart(3, "0")}`,
          text: raw.text,
          type: raw.type ?? "factual",
          sourceUrl: source.url,
          sourceTitle: source.title,
          sourceQuote: raw.quote,
          entityRefs: raw.entityRefs ?? [],
          topic: raw.topic ?? "operations",
          temporal: raw.temporal,
        });
      }
      console.log(`    ✓ ${parsed.length} claims`);
    } catch (err: any) {
      console.log(`    ⚠ Error: ${err.message}`);
    }
  }

  console.log(`\n  Total raw claims: ${allClaims.length} from ${sources.length} sources`);

  // Topic breakdown
  const byTopic: Record<string, number> = {};
  for (const c of allClaims) { byTopic[c.topic] = (byTopic[c.topic] ?? 0) + 1; }
  console.log("  By topic:", byTopic);

  save("step2-raw-claims.json", allClaims);
  return allClaims;
}

// ─── Step 3: Deduplicate Claims Across Sources ──────────────────────────────────

function step3_deduplicate(claims: SourceClaim[]): DeduplicatedClaim[] {
  console.log("\n━━━ Step 3: Deduplicate Claims Across Sources ━━━\n");

  function normalize(text: string): Set<string> {
    return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2));
  }

  function jaccard(a: Set<string>, b: Set<string>): number {
    const intersection = new Set([...a].filter(x => b.has(x)));
    const union = new Set([...a, ...b]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  const normalized = claims.map(c => ({ claim: c, words: normalize(c.text) }));
  const groups: number[][] = []; // groups of duplicate indices
  const assigned = new Set<number>();

  for (let i = 0; i < normalized.length; i++) {
    if (assigned.has(i)) continue;
    const group = [i];
    assigned.add(i);

    for (let j = i + 1; j < normalized.length; j++) {
      if (assigned.has(j)) continue;
      if (jaccard(normalized[i].words, normalized[j].words) >= 0.65) {
        group.push(j);
        assigned.add(j);
      }
    }
    groups.push(group);
  }

  // Merge each group into a single deduplicated claim
  const deduplicated: DeduplicatedClaim[] = [];
  for (const group of groups) {
    // Pick the longest/best claim text as the representative
    const members = group.map(i => claims[i]);
    const best = members.reduce((a, b) => (a.text.length > b.text.length ? a : b));

    deduplicated.push({
      ...best,
      id: `cd-${String(deduplicated.length + 1).padStart(3, "0")}`,
      sourceCount: members.length,
      allSources: members.map(m => ({ url: m.sourceUrl, title: m.sourceTitle, quote: m.sourceQuote })),
      confidence: members.length >= 3 ? "multi-source" :
                  members.length >= 2 ? "multi-source" :
                  best.type === "analytical" ? "analytical" : "single-source",
    });
  }

  console.log(`  Raw claims: ${claims.length}`);
  console.log(`  After deduplication: ${deduplicated.length} (removed ${claims.length - deduplicated.length} duplicates)`);

  // Source count distribution
  const multiSource = deduplicated.filter(c => c.sourceCount >= 2).length;
  const tripleSource = deduplicated.filter(c => c.sourceCount >= 3).length;
  console.log(`  Multi-source claims (2+): ${multiSource}`);
  console.log(`  Triple-source claims (3+): ${tripleSource}`);

  save("step3-deduplicated.json", deduplicated);
  return deduplicated;
}

// ─── Step 4: Editorial Direction ────────────────────────────────────────────────

interface EditorialDirection {
  keyNarrative: string;
  sections: { heading: string; topics: string[]; }[];
  audienceNote: string;
}

async function step4_editorial(claims: DeduplicatedClaim[]): Promise<EditorialDirection> {
  console.log("\n━━━ Step 4: Generate Editorial Direction ━━━\n");

  const byTopic: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  for (const c of claims) {
    byTopic[c.topic] = (byTopic[c.topic] ?? 0) + 1;
    byConfidence[c.confidence] = (byConfidence[c.confidence] ?? 0) + 1;
  }

  const topMultiSource = claims
    .filter(c => c.sourceCount >= 2)
    .sort((a, b) => b.sourceCount - a.sourceCount)
    .slice(0, 20)
    .map(c => `- [${c.sourceCount} sources, ${c.topic}] ${c.text}`)
    .join("\n");

  const prompt = `You are an editorial analyst for an AI safety wiki. Plan a comprehensive wiki page about Kalshi based on these claim statistics.

CLAIM STORE: ${claims.length} deduplicated claims
By topic: ${JSON.stringify(byTopic)}
By confidence: ${JSON.stringify(byConfidence)}

STRONGEST CLAIMS (multi-source):
${topMultiSource}

This wiki focuses on AI safety. Kalshi is a prediction market with LIMITED AI safety relevance. The page should be a balanced corporate profile.

Output a JSON object with:
{
  "keyNarrative": "one sentence",
  "sections": [
    { "heading": "Section Title", "topics": ["topic-slugs that map here"] }
  ],
  "audienceNote": "who reads this"
}

Rules:
- 8-12 sections covering all topics
- MUST include dedicated "AI Safety Markets" section
- MUST include "Overview" as first section
- Map every topic slug to at least one section
- Output ONLY JSON.`;

  const response = await llm(
    "You are a senior editorial analyst.",
    prompt,
    { model: STRONG_MODEL, maxTokens: 2048 }
  );

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  const raw = JSON.parse(jsonMatch![0]);

  const editorial: EditorialDirection = {
    keyNarrative: raw.keyNarrative ?? "Kalshi corporate profile",
    sections: raw.sections ?? [],
    audienceNote: raw.audienceNote ?? "AI safety researchers",
  };

  console.log(`  Key narrative: ${editorial.keyNarrative}`);
  console.log(`  Sections: ${editorial.sections.length}`);
  for (const s of editorial.sections) {
    console.log(`    ${s.heading} → [${s.topics.join(", ")}]`);
  }

  save("step4-editorial.json", editorial);
  return editorial;
}

// ─── Step 5: Compose Wiki Page ──────────────────────────────────────────────────

async function step5_compose(
  claims: DeduplicatedClaim[],
  editorial: EditorialDirection
): Promise<string> {
  console.log("\n━━━ Step 5: Compose Wiki Page from Source-Extracted Claims ━━━\n");

  const composedSections: string[] = [];
  let footnoteCounter = 0;
  const footnotes: string[] = [];
  const usedClaimIds = new Set<string>();

  // Assign claims to sections by topic
  const claimBySectionMap = new Map<string, DeduplicatedClaim[]>();
  const assigned = new Set<string>();

  for (const section of editorial.sections) {
    const sectionClaims = claims.filter(c =>
      !assigned.has(c.id) && section.topics.includes(c.topic)
    );
    // Prioritize multi-source claims
    sectionClaims.sort((a, b) => b.sourceCount - a.sourceCount);
    for (const c of sectionClaims) assigned.add(c.id);
    claimBySectionMap.set(section.heading, sectionClaims);
  }

  for (const section of editorial.sections) {
    const sectionClaims = claimBySectionMap.get(section.heading) ?? [];
    if (sectionClaims.length === 0) {
      log(`Skipping empty section: ${section.heading}`);
      continue;
    }

    // Take top claims (limit to avoid overwhelming the composer)
    const topClaims = sectionClaims.slice(0, 25);
    for (const c of topClaims) usedClaimIds.add(c.id);

    console.log(`  Composing: ${section.heading} (${topClaims.length} claims, ${topClaims.filter(c => c.sourceCount >= 2).length} multi-source)`);

    const claimList = topClaims.map(c => {
      const srcInfo = c.sourceCount >= 2 ? ` [${c.sourceCount} sources]` : "";
      return `- [${c.id}] (${c.type}${srcInfo}) ${c.text}`;
    }).join("\n");

    const sectionPrompt = `Compose a wiki section from ONLY these verified claims. Do not invent facts.

SECTION: ${section.heading}
NARRATIVE: ${editorial.keyNarrative}

CLAIMS (use these and ONLY these):
${claimList}

RULES:
1. Write 200-500 words of coherent prose
2. Prioritize multi-source claims (marked with [N sources]) — these are most reliable
3. Use hedging language ("reportedly") for single-source claims
4. After each factual sentence, add a footnote [^N]
5. Add claim IDs as comments: {/* claims: cd-XXX */}
6. NO new factual claims beyond what's listed above
7. Transitions and framing sentences are fine

Output ONLY the section content (no heading).`;

    try {
      const content = await llm(
        "You compose wiki sections from verified claims. Never invent facts. Prioritize multi-source claims.",
        sectionPrompt,
        { model: STRONG_MODEL, maxTokens: 2048 }
      );

      composedSections.push(`## ${section.heading}\n\n${content.trim()}`);

      // Build footnotes from claim sources
      for (const claim of topClaims) {
        footnoteCounter++;
        const bestSource = claim.allSources[0];
        footnotes.push(`[^${footnoteCounter}]: [${claim.text.slice(0, 60)}...](${bestSource.url})`);
      }
    } catch (err: any) {
      console.log(`    ⚠ Error: ${err.message}`);
    }
  }

  // Report unused claims
  const unused = claims.filter(c => !usedClaimIds.has(c.id));
  console.log(`\n  Used: ${usedClaimIds.size} claims across ${composedSections.length} sections`);
  console.log(`  Unused: ${unused.length} claims`);

  const frontmatter = `---
title: "Kalshi (Prediction Market)"
description: "First CFTC-regulated US prediction market exchange — composed from source documents"
entityType: organization
subcategory: epistemic-orgs
quality: 25
lastEdited: "${new Date().toISOString().slice(0, 10)}"
---`;

  const fullPage = [
    frontmatter,
    "",
    `{/* SOURCE-FIRST COMPOSITION: This page was composed from ${claims.length} claims extracted directly from ${new Set(claims.map(c => c.sourceUrl)).size} source documents, without referencing the existing wiki page. */}`,
    "",
    ...composedSections,
    "",
    "## Sources",
    "",
    ...footnotes,
  ].join("\n");

  console.log(`\n  Composed: ${composedSections.length} sections, ${fullPage.split(/\s+/).length} words`);
  save("step5-composed-page.mdx", fullPage);
  return fullPage;
}

// ─── Step 6: Compare ────────────────────────────────────────────────────────────

function step6_compare(composedPage: string, claims: DeduplicatedClaim[]): void {
  console.log("\n━━━ Step 6: Compare Source-First vs Original ━━━\n");

  const original = fs.readFileSync(
    path.join(ROOT, "content/docs/knowledge-base/organizations/kalshi.mdx"),
    "utf-8"
  );

  function stats(page: string) {
    const body = page.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    return {
      words: body.split(/\s+/).length,
      lines: body.split("\n").length,
      sections: (body.match(/\n## /g) ?? []).length,
      footnotes: (body.match(/\[\^(\d+)\]/g) ?? []).length,
    };
  }

  const orig = stats(original);
  const comp = stats(composedPage);

  const byTopic: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  for (const c of claims) {
    byTopic[c.topic] = (byTopic[c.topic] ?? 0) + 1;
    byConfidence[c.confidence] = (byConfidence[c.confidence] ?? 0) + 1;
  }

  const multiSourceCount = claims.filter(c => c.sourceCount >= 2).length;
  const tripleSourceCount = claims.filter(c => c.sourceCount >= 3).length;

  const report = `# Source-First Experiment: Kalshi

## Method
Claims extracted directly from ${new Set(claims.map(c => c.sourceUrl)).size} source documents (379K chars total).
No reference to the existing wiki page during extraction or composition.

## Comparison: Original vs Source-First Composed

| Metric | Original | Source-First |
|--------|----------|-------------|
| Words | ${orig.words} | ${comp.words} |
| Sections | ${orig.sections} | ${comp.sections} |
| Footnote refs | ${orig.footnotes} | ${comp.footnotes} |

## Claim Store Statistics

- **Total raw claims extracted**: (see step2)
- **After deduplication**: ${claims.length}
- **Multi-source (2+)**: ${multiSourceCount} (${((multiSourceCount / claims.length) * 100).toFixed(1)}%)
- **Triple-source (3+)**: ${tripleSourceCount}

### By Topic
${Object.entries(byTopic).sort((a, b) => b[1] - a[1]).map(([t, n]) => `- ${t}: ${n}`).join("\n")}

### By Confidence
${Object.entries(byConfidence).map(([c, n]) => `- ${c}: ${n}`).join("\n")}

## Cost
- LLM calls: ${cost.calls}
- Estimated input tokens: ~${cost.inputTokensEst.toLocaleString()}
- Estimated output tokens: ~${cost.outputTokensEst.toLocaleString()}

## Key Question
Does the source-first page contain claims/information NOT present in the original?
Does the original contain claims NOT found in any source document?
(Requires manual review of the two pages)
`;

  console.log(`  Original: ${orig.words} words, ${orig.sections} sections`);
  console.log(`  Source-first: ${comp.words} words, ${comp.sections} sections`);
  console.log(`  Claims: ${claims.length} deduplicated, ${multiSourceCount} multi-source`);

  save("step6-report.md", report);
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const dotenv = await import("dotenv");
  dotenv.config({ path: path.join(ROOT, ".env") });
  await initLLM();

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Source-First Claim Extraction Experiment: Kalshi            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`Output: ${path.relative(ROOT, OUTPUT_DIR)}/`);

  const startTime = Date.now();

  const sources = step1_loadSources();
  const rawClaims = await step2_extractClaims(sources);
  const deduplicated = step3_deduplicate(rawClaims);
  const editorial = await step4_editorial(deduplicated);
  const composedPage = await step5_compose(deduplicated, editorial);
  step6_compare(composedPage, deduplicated);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n━━━ Experiment Complete ━━━`);
  console.log(`  Duration: ${elapsed}s`);
  console.log(`  LLM calls: ${cost.calls}`);
  console.log(`  Sources: ${sources.length} documents`);
  console.log(`  Claims: ${rawClaims.length} raw → ${deduplicated.length} deduplicated`);
  console.log(`\n  Files:`);
  for (const f of fs.readdirSync(OUTPUT_DIR).sort()) {
    const size = fs.statSync(path.join(OUTPUT_DIR, f)).size;
    console.log(`    ${f} (${(size / 1024).toFixed(1)}KB)`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
