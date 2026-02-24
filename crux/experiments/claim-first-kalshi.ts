/**
 * Claim-First Architecture Experiment — Kalshi Page Reconstruction
 *
 * Tests the full claim-first pipeline:
 *   1. Extract atomic claims from existing Kalshi page
 *   2. Verify each claim against citation archive sources
 *   3. Build structured assets (tables, timelines)
 *   4. Generate editorial direction
 *   5. Compose a fresh wiki page from only the claim store
 *   6. Compose a second view (executive briefing)
 *   7. Generate comparison report
 *
 * Usage:
 *   node --import tsx/esm crux/experiments/claim-first-kalshi.ts [--step=N] [--verbose]
 *
 * Steps can be run individually (--step=1 through --step=7) or all at once (default).
 * Intermediate results are saved to .claude/claim-first-experiment/ for inspection.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { citationContent as citationContentDb } from "../lib/knowledge-db.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../");

const OUTPUT_DIR = path.join(ROOT, ".claude/claim-first-experiment");
const KALSHI_PAGE = path.join(
  ROOT,
  "content/docs/knowledge-base/organizations/kalshi.mdx"
);
const KALSHI_ARCHIVE = path.join(ROOT, "data/citation-archive/kalshi.yaml");

// Ensure output directory exists
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── LLM Helper ────────────────────────────────────────────────────────────────
// Dynamic import — resolved during init() after env is loaded
let callOpenRouter: (system: string, user: string, opts?: { model?: string; maxTokens?: number }) => Promise<string>;

async function initLLM() {
  const mod = await import("../lib/quote-extractor.ts");
  callOpenRouter = mod.callOpenRouter;
}

const FAST_MODEL = "google/gemini-2.0-flash-001";
const STRONG_MODEL = "anthropic/claude-sonnet-4"; // for composition

interface CostTracker {
  calls: number;
  inputTokensEst: number;
  outputTokensEst: number;
}

const cost: CostTracker = { calls: 0, inputTokensEst: 0, outputTokensEst: 0 };

async function llm(
  system: string,
  user: string,
  opts?: { model?: string; maxTokens?: number }
): Promise<string> {
  cost.calls++;
  // Rough token estimate: 4 chars per token
  cost.inputTokensEst += Math.ceil((system.length + user.length) / 4);
  const result = await callOpenRouter(system, user, {
    model: opts?.model ?? FAST_MODEL,
    maxTokens: opts?.maxTokens ?? 4096,
  });
  cost.outputTokensEst += Math.ceil(result.length / 4);
  return result;
}

// ─── Types ──────────────────────────────────────────────────────────────────────

interface Claim {
  id: string;
  text: string;
  type: "factual" | "numeric" | "consensus" | "analytical" | "speculative" | "relational";
  section: string;
  footnoteRefs: number[];
  entityRefs: string[];
  temporal?: {
    type: "historical" | "point-in-time" | "ongoing" | "projection";
    date?: string;
  };
}

interface VerifiedClaim extends Claim {
  confidence: "verified" | "partial" | "unverified" | "no-source";
  verificationNote?: string;
  sourceQuote?: string;
  sourceUrl?: string;
}

interface Asset {
  id: string;
  type: "table" | "mermaid" | "timeline" | "squiggle";
  title: string;
  description: string;
  content: string; // rendered content (markdown table, mermaid chart, etc.)
  claimRefs: string[];
}

interface EditorialDirection {
  keyNarrative: string;
  importantAngles: string[];
  suggestedSections: { heading: string; claimIds: string[]; claimSections: string[]; assetIds: string[] }[];
  missingPerspectives: string[];
  audienceNote: string;
}

interface KnowledgeBundle {
  entity: string;
  createdAt: string;
  claims: VerifiedClaim[];
  assets: Asset[];
  editorial: EditorialDirection;
  stats: {
    totalClaims: number;
    verified: number;
    partial: number;
    unverified: number;
    noSource: number;
    byType: Record<string, number>;
  };
}

// ─── Utility ────────────────────────────────────────────────────────────────────

function save(filename: string, data: unknown): string {
  const filepath = path.join(OUTPUT_DIR, filename);
  if (typeof data === "string") {
    fs.writeFileSync(filepath, data);
  } else {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  }
  console.log(`  → Saved: ${path.relative(ROOT, filepath)}`);
  return filepath;
}

function load<T>(filename: string): T {
  const filepath = path.join(OUTPUT_DIR, filename);
  const content = fs.readFileSync(filepath, "utf-8");
  return JSON.parse(content) as T;
}

function loadPageContent(): string {
  return fs.readFileSync(KALSHI_PAGE, "utf-8");
}

function loadCitationArchive(): any {
  const content = fs.readFileSync(KALSHI_ARCHIVE, "utf-8");
  return yaml.load(content);
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content;
}

const verbose = process.argv.includes("--verbose");
function log(msg: string) {
  if (verbose) console.log(`  [debug] ${msg}`);
}

/**
 * Pre-process MDX content to remove formatting that causes LLM JSON parsing issues.
 * Strips: escaped dollar signs, EntityLink components, import statements, HTML comments.
 */
function cleanMdxForExtraction(content: string): string {
  return content
    .replace(/\\(\$)/g, "$1")                          // \$100 → $100
    .replace(/\\([<>])/g, "$1")                        // \<100 → <100
    .replace(/<EntityLink\s+id="([^"]+)">(.*?)<\/EntityLink>/g, "$2") // EntityLink → plain text
    .replace(/import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?\n?/g, "") // Remove import lines
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")              // Remove MDX comments
    .replace(/\n{3,}/g, "\n\n");                        // Collapse excessive newlines
}

/**
 * Split a long section into subsections (### headings) for more reliable extraction.
 * Returns [{heading, content}] where heading includes parent context.
 */
function splitSubsections(sectionHeading: string, sectionContent: string): Array<{heading: string; content: string}> {
  const subsections = sectionContent.split(/\n### /);
  if (subsections.length <= 1) {
    // No subsections, return as-is
    return [{ heading: sectionHeading, content: sectionContent }];
  }

  const result: Array<{heading: string; content: string}> = [];

  // First chunk is content before first ### heading
  if (subsections[0].trim().length > 50) {
    result.push({ heading: sectionHeading, content: subsections[0] });
  }

  // Each subsequent chunk starts with a ### heading
  for (let i = 1; i < subsections.length; i++) {
    const subMatch = subsections[i].match(/^(.+?)(?:\n|$)/);
    const subHeading = subMatch ? subMatch[1].trim() : "Unknown";
    result.push({
      heading: `${sectionHeading} > ${subHeading}`,
      content: subsections[i],
    });
  }

  return result;
}

/**
 * Robust JSON parsing with multiple fallback strategies.
 * Returns null if all strategies fail.
 */
function parseJsonRobust(raw: string): any[] | null {
  // Strategy 1: Find JSON array directly
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;
  let text = jsonMatch[0];

  // Strategy 2: Direct parse
  try { return JSON.parse(text); } catch {}

  // Strategy 3: Clean common LLM JSON issues
  const cleaned = text
    .replace(/[\x00-\x1f]/g, " ")     // Replace control chars
    .replace(/,\s*([}\]])/g, "$1")     // Remove trailing commas
    .replace(/\\'/g, "'")              // Fix escaped single quotes
    .replace(/\\\$/g, "$")             // Fix escaped dollar signs in JSON strings
    .replace(/\\</g, "<")              // Fix escaped angle brackets
    .replace(/\\>/g, ">")             // Fix escaped angle brackets
    .replace(/\n\s*\/\/[^\n]*/g, ""); // Remove JS-style comments
  try { return JSON.parse(cleaned); } catch {}

  // Strategy 4: More aggressive — fix unescaped newlines in string values
  const aggressive = cleaned
    .replace(/(?<="[^"]*)\n(?=[^"]*")/g, " ")  // Newlines inside strings → spaces
    .replace(/(?<=:\s*")([^"]*?)(?=")/g, (_, val: string) =>
      val.replace(/"/g, '\\"')                   // Escape inner quotes
    );
  try { return JSON.parse(aggressive); } catch {}

  // Strategy 5: Extract individual objects and rebuild array
  try {
    const objects: any[] = [];
    const objRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
    let match;
    while ((match = objRegex.exec(cleaned)) !== null) {
      try {
        const obj = JSON.parse(match[0]);
        if (obj.text) objects.push(obj);
      } catch {
        // Try cleaning this individual object
        const cleanObj = match[0]
          .replace(/[\x00-\x1f]/g, " ")
          .replace(/,\s*\}/g, "}");
        try {
          const obj = JSON.parse(cleanObj);
          if (obj.text) objects.push(obj);
        } catch {}
      }
    }
    if (objects.length > 0) return objects;
  } catch {}

  return null;
}

// ─── Step 1: Extract Claims ────────────────────────────────────────────────────

async function step1_extractClaims(): Promise<Claim[]> {
  console.log("\n━━━ Step 1: Extract Atomic Claims ━━━\n");

  const pageContent = loadPageContent();
  const body = stripFrontmatter(pageContent);

  // Pre-process MDX content to avoid JSON parsing issues
  const cleanBody = cleanMdxForExtraction(body);

  // Split into sections for focused extraction
  const sections = cleanBody.split(/\n## /).filter(Boolean);
  const allClaims: Claim[] = [];
  let claimCounter = 0;

  for (const section of sections) {
    const headingMatch = section.match(/^(.+?)(?:\n|$)/);
    const heading = headingMatch ? headingMatch[1].trim() : "Unknown";

    // Skip import lines and very short sections
    if (heading.startsWith("import ") || section.length < 100) continue;

    // Split long sections with subsections for more reliable extraction
    const chunks = splitSubsections(heading, section);

    for (const chunk of chunks) {
      console.log(`  Extracting claims from: ${chunk.heading}`);

      const prompt = `Extract every factual claim from this wiki section. For each claim, output a JSON array of objects with these fields:
- "text": the atomic claim as plain text (one verifiable fact per claim, NO special characters or markdown)
- "type": one of "factual", "numeric", "consensus", "analytical", "speculative", "relational"
- "footnoteRefs": array of footnote numbers cited (integers, e.g. [1, 2]). Extract these from [^N] references in the text.
- "entityRefs": array of entity IDs mentioned (lowercase-hyphenated, e.g. "kalshi", "cftc", "polymarket")
- "temporal": object with "type" (historical/point-in-time/ongoing/projection) and optional "date" (YYYY or YYYY-MM)

Rules:
- One claim per verifiable fact. "Founded in 2018 by Tarek Mansour" is TWO claims: founding date + founders.
- Numeric values get type "numeric". Opinions/assessments get "analytical". Industry-wide views get "consensus".
- Include footnote refs as integers (e.g. [1, 2] not ["1", "2"]).
- Do NOT include claims that are just section headers or formatting.
- Keep claim text as simple plain text — no dollar signs, markdown, or special formatting.

Output ONLY a valid JSON array, no markdown fences, no comments, no other text.

Section heading: ${chunk.heading}
Section content:
${chunk.content.slice(0, 6000)}`;

      try {
        const response = await llm(
          "You extract atomic factual claims from wiki content. Output only valid JSON arrays. Keep all string values as simple plain text.",
          prompt,
          { maxTokens: 8192 }
        );

        const parsed = parseJsonRobust(response);
        if (!parsed || parsed.length === 0) {
          console.log(`    ⚠ JSON parse failed for: ${chunk.heading}`);

          // Retry once with a simpler prompt
          log("Retrying with simplified prompt...");
          const retryResponse = await llm(
            "Output only a JSON array. No markdown. No comments.",
            `Extract factual claims from this text as a JSON array. Each object needs: "text" (string), "type" (string), "footnoteRefs" (number array).

Text:
${chunk.content.slice(0, 4000)}

Output ONLY the JSON array:`,
            { maxTokens: 4096 }
          );

          const retryParsed = parseJsonRobust(retryResponse);
          if (!retryParsed || retryParsed.length === 0) {
            console.log(`    ⚠ Retry also failed for: ${chunk.heading}`);
            continue;
          }

          for (const raw of retryParsed) {
            if (!raw.text) continue;
            claimCounter++;
            allClaims.push({
              id: `c-kalshi-${String(claimCounter).padStart(3, "0")}`,
              text: raw.text,
              type: raw.type ?? "factual",
              section: chunk.heading,
              footnoteRefs: (raw.footnoteRefs ?? []).map((fn: any) => typeof fn === "string" ? parseInt(fn, 10) : fn),
              entityRefs: raw.entityRefs ?? [],
              temporal: raw.temporal,
            });
          }
          console.log(`    ✓ Extracted ${retryParsed.length} claims (retry)`);
          continue;
        }

        for (const raw of parsed) {
          if (!raw.text) continue;
          claimCounter++;
          allClaims.push({
            id: `c-kalshi-${String(claimCounter).padStart(3, "0")}`,
            text: raw.text,
            type: raw.type ?? "factual",
            section: chunk.heading,
            footnoteRefs: (raw.footnoteRefs ?? []).map((fn: any) => typeof fn === "string" ? parseInt(fn, 10) : fn),
            entityRefs: raw.entityRefs ?? [],
            temporal: raw.temporal,
          });
        }
        console.log(`    ✓ Extracted ${parsed.length} claims`);
      } catch (err: any) {
        console.log(`    ⚠ Error extracting from ${chunk.heading}: ${err.message}`);
      }
    }
  }

  console.log(`\n  Total claims extracted: ${allClaims.length}`);

  // ─── Deduplication pass ───
  const deduplicated = deduplicateClaims(allClaims);
  console.log(`  After deduplication: ${deduplicated.length} claims (removed ${allClaims.length - deduplicated.length} duplicates)`);

  save("step1-claims.json", deduplicated);

  // Print type breakdown
  const byType: Record<string, number> = {};
  for (const c of deduplicated) {
    byType[c.type] = (byType[c.type] ?? 0) + 1;
  }
  console.log("  Type breakdown:", byType);

  return deduplicated;
}

/**
 * Deduplicate claims by detecting near-identical text.
 * When two claims have >80% word overlap, keep the one with more footnote references.
 */
function deduplicateClaims(claims: Claim[]): Claim[] {
  // Normalize text for comparison
  function normalize(text: string): Set<string> {
    return new Set(
      text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  }

  function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    const intersection = new Set([...a].filter((x) => b.has(x)));
    const union = new Set([...a, ...b]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  const normalized = claims.map((c) => ({ claim: c, words: normalize(c.text ?? "") }));
  const kept: Claim[] = [];
  const removed = new Set<number>();

  for (let i = 0; i < normalized.length; i++) {
    if (removed.has(i)) continue;

    let bestIdx = i;
    let bestRefs = normalized[i].claim.footnoteRefs.length;

    // Check against remaining claims for duplicates
    for (let j = i + 1; j < normalized.length; j++) {
      if (removed.has(j)) continue;

      const sim = jaccardSimilarity(normalized[i].words, normalized[j].words);
      if (sim >= 0.8) {
        // Near-duplicate found — keep the one with more footnote refs
        const jRefs = normalized[j].claim.footnoteRefs.length;
        if (jRefs > bestRefs) {
          removed.add(bestIdx);
          bestIdx = j;
          bestRefs = jRefs;
        } else {
          removed.add(j);
        }
        log(`  Dedup: "${normalized[j].claim.text?.slice(0, 60)}" ≈ "${normalized[i].claim.text?.slice(0, 60)}" (sim=${sim.toFixed(2)})`);
      }
    }

    if (!removed.has(bestIdx)) {
      kept.push(normalized[bestIdx].claim);
    }
  }

  return kept;
}

// ─── Step 2: Verify Claims ─────────────────────────────────────────────────────

async function step2_verifyClaims(claims: Claim[]): Promise<VerifiedClaim[]> {
  console.log("\n━━━ Step 2: Verify Claims Against Sources ━━━\n");

  const archive = loadCitationArchive();
  const citations = archive.citations ?? archive ?? [];

  // Build footnote → source mapping
  const footnoteMap = new Map<number, any>();
  for (const cit of citations) {
    footnoteMap.set(cit.footnote, cit);
  }

  // Load full source text from SQLite citation_content cache
  const sourceTextCache = new Map<string, string>();
  const uniqueUrls = new Set(citations.map((c: any) => c.url).filter(Boolean));
  let fullTextCount = 0;
  for (const url of uniqueUrls) {
    const cached = citationContentDb.getByUrl(url);
    if (cached?.full_text && cached.full_text.length > 100) {
      sourceTextCache.set(url, cached.full_text);
      fullTextCount++;
    }
  }

  console.log(`  Citation archive: ${citations.length} sources loaded`);
  console.log(`  Full source text available: ${fullTextCount}/${uniqueUrls.size} URLs`);
  console.log(`  Claims to verify: ${claims.length}`);

  const verified: VerifiedClaim[] = [];
  let verifiedCount = 0;
  let partialCount = 0;
  let unverifiedCount = 0;
  let noSourceCount = 0;

  // Batch claims by their footnote references for efficient verification
  // Process in batches of 8 claims (slightly smaller for better source context per claim)
  const BATCH_SIZE = 8;
  for (let i = 0; i < claims.length; i += BATCH_SIZE) {
    const batch = claims.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(claims.length / BATCH_SIZE);
    console.log(`  Verifying batch ${batchNum}/${totalBatches} (${batch.length} claims)...`);

    // For each claim, gather source context — prefer full text from SQLite cache
    const claimsWithContext = batch.map((claim) => {
      const sources = claim.footnoteRefs
        .map((fn) => footnoteMap.get(typeof fn === "string" ? parseInt(fn, 10) : fn))
        .filter(Boolean)
        .map((cit: any) => {
          // Priority: full text from SQLite cache > archive fields > snippet
          const cachedFullText = sourceTextCache.get(cit.url);
          const archiveContent = cit.pageContent ?? cit.extractedContent ?? "";
          const snippet = cit.contentSnippet ?? "";

          let sourceText: string;
          if (cachedFullText) {
            // Full source available — use up to 2000 chars for good verification context
            sourceText = cachedFullText.slice(0, 2000);
          } else if (archiveContent.length > snippet.length) {
            sourceText = archiveContent.slice(0, 800);
          } else {
            sourceText = snippet.slice(0, 800);
          }

          return {
            footnote: cit.footnote,
            url: cit.url,
            title: cit.pageTitle ?? cit.linkText,
            sourceText,
            hasFullText: !!cachedFullText,
            status: cit.status,
            quotes: cit.supportingQuotes ?? [],
          };
        });

      return { claim, sources };
    });

    // Build verification prompt
    const prompt = `Verify each claim against its cited sources. For each claim, determine:
- "confidence": "verified" (source clearly supports), "partial" (source partially supports), "unverified" (source doesn't support this specific claim), "no-source" (no source cited)
- "verificationNote": brief explanation of the verdict
- "sourceQuote": the most relevant quote from the source (if any)

Claims to verify:
${claimsWithContext
  .map(
    ({ claim, sources }) => `
CLAIM [${claim.id}]: "${claim.text}"
TYPE: ${claim.type}
SOURCES: ${sources.length === 0 ? "NONE" : sources.map((s) => {
      const quoteInfo = s.quotes.length > 0
        ? `\n    SUPPORTING QUOTES: ${s.quotes.slice(0, 2).map((q: any) => `"${typeof q === 'string' ? q.slice(0, 200) : (q.quote ?? '').slice(0, 200)}"`).join("; ")}`
        : "";
      return `[^${s.footnote}] ${s.title} (${s.status}): "${s.sourceText}"${quoteInfo}`;
    }).join("\n  ")}`
  )
  .join("\n")}

Output a JSON array with objects: { "id": "c-kalshi-XXX", "confidence": "...", "verificationNote": "...", "sourceQuote": "..." }
Output ONLY the JSON array.`;

    try {
      const response = await llm(
        "You verify factual claims against source material. Be strict: if the source doesn't explicitly state what the claim says, mark as partial or unverified. Output only valid JSON.",
        prompt,
        { maxTokens: 4096 }
      );

      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        // Fallback: mark all as unverified
        for (const { claim, sources } of claimsWithContext) {
          verified.push({
            ...claim,
            confidence: sources.length === 0 ? "no-source" : "unverified",
            verificationNote: "Verification failed to parse",
          });
          if (sources.length === 0) noSourceCount++;
          else unverifiedCount++;
        }
        continue;
      }

      let results: any[];
      try {
        results = JSON.parse(jsonMatch[0]);
      } catch {
        const cleaned = jsonMatch[0]
          .replace(/[\x00-\x1f]/g, " ")
          .replace(/,\s*([}\]])/g, "$1");
        try {
          results = JSON.parse(cleaned);
        } catch {
          results = [];
        }
      }

      // Build map by ID, also try index-based fallback
      const resultMap = new Map(results.map((r: any) => [r.id, r]));

      for (let j = 0; j < claimsWithContext.length; j++) {
        const { claim, sources } = claimsWithContext[j];
        // Try ID match first, then index fallback
        const result = resultMap.get(claim.id) ?? results[j];
        if (result && result.confidence) {
          const conf = result.confidence;
          verified.push({
            ...claim,
            confidence: conf,
            verificationNote: result.verificationNote ?? "",
            sourceQuote: result.sourceQuote ?? "",
            sourceUrl: sources[0]?.url,
          });
          if (conf === "verified") verifiedCount++;
          else if (conf === "partial") partialCount++;
          else if (conf === "no-source") noSourceCount++;
          else unverifiedCount++;
        } else {
          verified.push({
            ...claim,
            confidence: sources.length === 0 ? "no-source" : "unverified",
            verificationNote: "Not in verification results",
          });
          if (sources.length === 0) noSourceCount++;
          else unverifiedCount++;
        }
      }
    } catch (err: any) {
      console.log(`    ⚠ Batch ${batchNum} error: ${err.message}`);
      for (const { claim, sources } of claimsWithContext) {
        verified.push({
          ...claim,
          confidence: sources.length === 0 ? "no-source" : "unverified",
          verificationNote: `Error: ${err.message}`,
        });
        if (sources.length === 0) noSourceCount++;
        else unverifiedCount++;
      }
    }
  }

  console.log(`\n  Verification results:`);
  console.log(`    Verified:   ${verifiedCount}`);
  console.log(`    Partial:    ${partialCount}`);
  console.log(`    Unverified: ${unverifiedCount}`);
  console.log(`    No source:  ${noSourceCount}`);

  save("step2-verified-claims.json", verified);
  return verified;
}

// ─── Step 3: Build Assets ───────────────────────────────────────────────────────

async function step3_buildAssets(claims: VerifiedClaim[]): Promise<Asset[]> {
  console.log("\n━━━ Step 3: Build Structured Assets ━━━\n");

  const assets: Asset[] = [];

  // Filter out claims with missing text
  const validClaims = claims.filter((c) => c.text);

  // Find numeric/funding claims for the funding table
  const fundingClaims = validClaims.filter(
    (c) =>
      (c.section?.includes("Funding") || c.section?.includes("Growth") || c.section?.includes("Milestones")) &&
      (c.type === "numeric" || c.text.toLowerCase().includes("series") || c.text.toLowerCase().includes("raised") || c.text.toLowerCase().includes("valuation") || c.text.toLowerCase().includes("funding"))
  );

  if (fundingClaims.length > 0) {
    console.log(`  Building funding table from ${fundingClaims.length} claims...`);

    const tablePrompt = `Given these verified claims about Kalshi's funding, create a markdown table of funding rounds.

Claims:
${fundingClaims.map((c) => `- [${c.id}] ${c.text} (confidence: ${c.confidence})`).join("\n")}

Create a markdown table with columns: Round | Date | Amount | Valuation | Lead Investors
Only include information that appears in the claims above. Use "—" for unknown values.
Output ONLY the markdown table.`;

    const tableContent = await llm(
      "You create structured data tables from verified claims. Only include information present in the claims.",
      tablePrompt,
      { maxTokens: 2048 }
    );

    assets.push({
      id: "asset-kalshi-funding",
      type: "table",
      title: "Kalshi Funding History",
      description:
        "For LLM: chronological funding rounds with amounts and valuations. Use when discussing Kalshi's growth trajectory, investor base, or financial position.",
      content: tableContent.trim(),
      claimRefs: fundingClaims.map((c) => c.id),
    });
    console.log(`  ✓ Funding table created`);
  }

  // Build regulatory timeline
  const regulatoryClaims = validClaims.filter(
    (c) =>
      c.section?.includes("Regulatory") ||
      c.section?.includes("Legal") ||
      c.section?.includes("Milestones") ||
      c.text.toLowerCase().includes("cftc") ||
      c.text.toLowerCase().includes("regulatory") ||
      c.text.toLowerCase().includes("court")
  );

  if (regulatoryClaims.length > 0) {
    console.log(`  Building regulatory timeline from ${regulatoryClaims.length} claims...`);

    const timelinePrompt = `Given these verified claims about Kalshi's regulatory journey, create a Mermaid flowchart timeline.

Claims:
${regulatoryClaims.map((c) => `- [${c.id}] ${c.text} (confidence: ${c.confidence})`).join("\n")}

Create a Mermaid flowchart TD (top-down) showing the regulatory milestones in chronological order.
Rules:
- Max 10-12 nodes
- Include dates in node labels
- Use clear, concise labels
- Only include events from the claims above

Output ONLY the mermaid code starting with "flowchart TD", no fences.`;

    const mermaidContent = await llm(
      "You create Mermaid diagrams from verified claims. Only include information present in the claims.",
      timelinePrompt,
      { maxTokens: 2048 }
    );

    assets.push({
      id: "asset-kalshi-regulatory-timeline",
      type: "mermaid",
      title: "Kalshi Regulatory Journey",
      description:
        "For LLM: key regulatory and legal milestones from founding to present. Use when discussing Kalshi's regulatory story, legal challenges, or CFTC relationship.",
      content: mermaidContent.trim(),
      claimRefs: regulatoryClaims.map((c) => c.id),
    });
    console.log(`  ✓ Regulatory timeline created`);
  }

  // Build partnership list
  const partnershipClaims = validClaims.filter(
    (c) =>
      c.section?.includes("Partnership") ||
      c.text.toLowerCase().includes("partner") ||
      c.text.toLowerCase().includes("collaboration") ||
      c.text.toLowerCase().includes("integration")
  );

  if (partnershipClaims.length > 3) {
    console.log(`  Building partnership table from ${partnershipClaims.length} claims...`);

    const partnerPrompt = `Given these verified claims about Kalshi's partnerships, create a markdown table.

Claims:
${partnershipClaims.map((c) => `- [${c.id}] ${c.text} (confidence: ${c.confidence})`).join("\n")}

Create a markdown table with columns: Partner | Type | Description
Group by partnership type (sports, data, technology, financial, media).
Output ONLY the markdown table.`;

    const partnerContent = await llm(
      "You create structured data tables from verified claims.",
      partnerPrompt,
      { maxTokens: 2048 }
    );

    assets.push({
      id: "asset-kalshi-partnerships",
      type: "table",
      title: "Kalshi Strategic Partnerships",
      description:
        "For LLM: categorized list of Kalshi's key partnerships. Use when discussing business development, market expansion, or sports market strategy.",
      content: partnerContent.trim(),
      claimRefs: partnershipClaims.map((c) => c.id),
    });
    console.log(`  ✓ Partnership table created`);
  }

  console.log(`\n  Total assets built: ${assets.length}`);
  save("step3-assets.json", assets);
  return assets;
}

// ─── Step 4: Editorial Direction ────────────────────────────────────────────────

async function step4_editorial(claims: VerifiedClaim[], assets: Asset[]): Promise<EditorialDirection> {
  console.log("\n━━━ Step 4: Generate Editorial Direction ━━━\n");

  // Summarize claim store for the editorial analyst
  const bySection: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  for (const c of claims) {
    bySection[c.section] = (bySection[c.section] ?? 0) + 1;
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    byConfidence[c.confidence] = (byConfidence[c.confidence] ?? 0) + 1;
  }

  const prompt = `You are an editorial analyst for a wiki about AI safety, forecasting, and related topics. Analyze this claim store for Kalshi and produce editorial direction for a wiki page.

CLAIM STORE SUMMARY:
- Total claims: ${claims.length}
- By confidence: ${JSON.stringify(byConfidence)}
- By type: ${JSON.stringify(byType)}
- By section: ${JSON.stringify(bySection)}

SAMPLE HIGH-CONFIDENCE CLAIMS (first 30):
${claims
  .filter((c) => c.confidence === "verified")
  .slice(0, 30)
  .map((c) => `- [${c.type}] ${c.text}`)
  .join("\n")}

AVAILABLE ASSETS:
${assets.map((a) => `- ${a.title} (${a.type}): ${a.description}`).join("\n")}

GAPS (unverified/no-source claims):
${claims
  .filter((c) => c.confidence === "unverified" || c.confidence === "no-source")
  .slice(0, 15)
  .map((c) => `- ${c.text}`)
  .join("\n")}

CLAIM SECTIONS (source sections from which claims were extracted):
${Object.entries(bySection).map(([s, n]) => `- "${s}": ${n} claims`).join("\n")}

This wiki focuses on AI safety. Kalshi is a prediction market with LIMITED AI safety relevance (a few contracts on AI regulation pauses). The page should be a balanced corporate profile.

IMPORTANT CONSTRAINTS:
1. You MUST include a dedicated "AI Safety Markets" section (this wiki's primary audience cares about this).
2. Each suggestedSection MUST include "claimSections" — a list of source claim section names that map to that section. This is how the composer knows which claims belong to which section.
3. Aim for 8-12 sections for comprehensive coverage. Don't merge too many topics into one section.
4. Cover the founding story, funding/growth, platform operations, partnerships, regulatory challenges, AI safety markets, competition, community reception, and operational concerns as separate sections.

Output a JSON object with:
{
  "keyNarrative": "one sentence describing the page's central story",
  "importantAngles": ["3-5 most important angles to cover"],
  "suggestedSections": [
    {
      "heading": "Section Title",
      "claimSections": ["source section names that map here"],
      "assetIds": ["asset IDs to include"]
    }
  ],
  "missingPerspectives": ["gaps or perspectives that need more research"],
  "audienceNote": "who this page serves and what they need"
}

Output ONLY the JSON object.`;

  const response = await llm(
    "You are a senior editorial analyst. Produce strategic direction for wiki page composition.",
    prompt,
    { model: STRONG_MODEL, maxTokens: 4096 }
  );

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Failed to parse editorial direction");
  }

  const raw = JSON.parse(jsonMatch[0]);

  const editorial: EditorialDirection = {
    keyNarrative: raw.keyNarrative ?? "Kalshi corporate profile",
    importantAngles: raw.importantAngles ?? [],
    suggestedSections: (raw.suggestedSections ?? []).map((s: any) => ({
      heading: s.heading,
      claimIds: [], // Will be populated during composition
      claimSections: s.claimSections ?? [],
      assetIds: s.assetIds ?? [],
    })),
    missingPerspectives: raw.missingPerspectives ?? [],
    audienceNote: raw.audienceNote ?? "AI safety researchers and forecasting community",
  };

  console.log(`  Key narrative: ${editorial.keyNarrative}`);
  console.log(`  Suggested sections: ${editorial.suggestedSections.length}`);
  console.log(`  Missing perspectives: ${editorial.missingPerspectives.length}`);

  save("step4-editorial.json", editorial);
  return editorial;
}

// ─── Step 5: Compose Wiki Page ──────────────────────────────────────────────────

async function step5_composePage(
  claims: VerifiedClaim[],
  assets: Asset[],
  editorial: EditorialDirection
): Promise<string> {
  console.log("\n━━━ Step 5: Compose Wiki Page from Claims ━━━\n");

  // Group claims by section
  const claimsBySection = new Map<string, VerifiedClaim[]>();
  for (const claim of claims) {
    const existing = claimsBySection.get(claim.section) ?? [];
    existing.push(claim);
    claimsBySection.set(claim.section, existing);
  }

  // Build a keyword index of claim sections for better matching
  const allSectionNames = [...new Set(claims.map((c) => c.section))];
  log(`Claim sections: ${allSectionNames.join(", ")}`);

  // Use editorial direction to determine section order, or fall back to claim sections
  const sectionOrder =
    editorial.suggestedSections.length > 0
      ? editorial.suggestedSections.map((s) => s.heading)
      : [...claimsBySection.keys()];

  const composedSections: string[] = [];
  let footnoteCounter = 0;
  const footnotes: string[] = [];
  const usedClaimIds = new Set<string>();

  /**
   * Improved section-to-claim matching using keyword overlap scoring.
   */
  function findClaimsForSection(sectionHeading: string): VerifiedClaim[] {
    const sWords = new Set(
      sectionHeading.toLowerCase().split(/[\s>]+/).filter((w) => w.length > 2)
    );

    // Score each claim by relevance to this section heading
    const scored = claims.map((claim) => {
      const cLower = claim.section.toLowerCase();
      const sLower = sectionHeading.toLowerCase();

      // Exact or substring match: high score
      if (cLower === sLower || cLower.includes(sLower) || sLower.includes(cLower)) {
        return { claim, score: 10 };
      }

      // Subsection match (e.g. "History and Development > Founding Story" matches "History")
      const claimParts = cLower.split(" > ");
      for (const part of claimParts) {
        if (part.includes(sLower) || sLower.includes(part)) {
          return { claim, score: 8 };
        }
      }

      // Keyword overlap: count shared significant words
      const cWords = new Set(cLower.split(/[\s>]+/).filter((w) => w.length > 2));
      let overlap = 0;
      for (const w of sWords) {
        if (cWords.has(w)) overlap++;
      }

      // Also check claim text for section-relevant keywords
      const textWords = new Set(
        (claim.text ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 3)
      );
      for (const w of sWords) {
        if (textWords.has(w)) overlap += 0.3;
      }

      return { claim, score: overlap };
    });

    return scored
      .filter((s) => s.score >= 1)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.claim);
  }

  // ─── Claim Budget: pre-assign claims to sections ───
  // Each claim can only appear in ONE section (the best-scoring match).
  // This prevents the composer from reusing the same high-confidence claims across sections.
  const claimSectionAssignment = new Map<string, string>(); // claimId → sectionHeading

  // First pass: use editorial direction's claimSections for explicit mapping
  for (const section of editorial.suggestedSections) {
    if (section.claimSections && section.claimSections.length > 0) {
      for (const claim of claims) {
        if (claimSectionAssignment.has(claim.id)) continue; // Already assigned

        const cLower = claim.section.toLowerCase();
        for (const mappedSection of section.claimSections) {
          const mLower = mappedSection.toLowerCase();
          if (cLower === mLower || cLower.includes(mLower) || mLower.includes(cLower)) {
            claimSectionAssignment.set(claim.id, section.heading);
            break;
          }
          // Also match subsection patterns like "History > Founding Story"
          const claimParts = cLower.split(" > ");
          if (claimParts.some((p) => p.includes(mLower) || mLower.includes(p))) {
            claimSectionAssignment.set(claim.id, section.heading);
            break;
          }
        }
      }
    }
  }

  // Second pass: for unassigned claims, use keyword scoring
  for (const claim of claims) {
    if (claimSectionAssignment.has(claim.id)) continue;

    let bestSection = "";
    let bestScore = 0;

    for (const sectionHeading of sectionOrder) {
      const sWords = new Set(
        sectionHeading.toLowerCase().split(/[\s>]+/).filter((w) => w.length > 2)
      );
      const cLower = claim.section.toLowerCase();
      const sLower = sectionHeading.toLowerCase();

      let score = 0;
      if (cLower === sLower || cLower.includes(sLower) || sLower.includes(cLower)) {
        score = 10;
      } else {
        const claimParts = cLower.split(" > ");
        for (const part of claimParts) {
          if (part.includes(sLower) || sLower.includes(part)) { score = Math.max(score, 8); }
        }
        const cWords = new Set(cLower.split(/[\s>]+/).filter((w) => w.length > 2));
        for (const w of sWords) {
          if (cWords.has(w)) score += 1;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestSection = sectionHeading;
      }
    }

    if (bestScore >= 1 && bestSection) {
      claimSectionAssignment.set(claim.id, bestSection);
    }
  }

  // Report claim budget stats
  const budgetStats: Record<string, number> = {};
  for (const [_, section] of claimSectionAssignment) {
    budgetStats[section] = (budgetStats[section] ?? 0) + 1;
  }
  log(`Claim budget: ${claimSectionAssignment.size} of ${claims.length} claims assigned to sections`);
  for (const [section, count] of Object.entries(budgetStats).sort((a, b) => b[1] - a[1])) {
    log(`  ${section}: ${count} claims`);
  }

  for (const sectionHeading of sectionOrder) {
    // Use claim budget: only claims assigned to THIS section
    const sectionClaims = claims.filter(
      (c) => claimSectionAssignment.get(c.id) === sectionHeading
    );

    if (sectionClaims.length === 0) {
      log(`Skipping empty section: ${sectionHeading}`);
      continue;
    }

    // Filter to verified/partial claims, and also allow unverified if they have sources
    const usableClaims = sectionClaims.filter(
      (c) => c.confidence === "verified" || c.confidence === "partial"
    );

    // If very few verified claims, also include unverified-with-source claims as "reportedly" material
    const supplementalClaims = usableClaims.length < 3
      ? sectionClaims.filter(
          (c) => c.confidence === "unverified" && c.sourceUrl
        ).slice(0, 8)
      : [];

    const allUsable = [...usableClaims, ...supplementalClaims];

    if (allUsable.length === 0) {
      log(`Skipping section with no usable claims: ${sectionHeading}`);
      continue;
    }

    // Track which claims are used
    for (const c of allUsable) usedClaimIds.add(c.id);

    // Find assets for this section — match by editorial direction OR by keyword overlap
    const sectionAssets = assets.filter((a) => {
      const editorial_section = editorial.suggestedSections.find(
        (s) => s.heading === sectionHeading
      );
      if (editorial_section?.assetIds?.includes(a.id)) return true;

      // Keyword-based asset matching
      const aWords = (a.title + " " + a.description).toLowerCase();
      const sWords = sectionHeading.toLowerCase().split(/\s+/);
      return sWords.filter((w) => w.length > 3).some((w) => aWords.includes(w));
    });

    console.log(
      `  Composing section: ${sectionHeading} (${allUsable.length} claims, ${sectionAssets.length} assets)`
    );

    const sectionPrompt = `You are composing a wiki section from ONLY verified claims. Do not invent facts.

SECTION: ${sectionHeading}
NARRATIVE CONTEXT: ${editorial.keyNarrative}

VERIFIED CLAIMS (use these and ONLY these for factual content):
${allUsable.map((c) => `- [${c.id}] (${c.confidence}) ${c.text}`).join("\n")}

${
  sectionAssets.length > 0
    ? `AVAILABLE ASSETS (embed where appropriate):
${sectionAssets.map((a) => `- ${a.title}: ${a.description}\nContent:\n${a.content}`).join("\n\n")}`
    : ""
}

RULES:
1. Write 150-400 words of coherent prose incorporating the claims above
2. Add transitions between claims for narrative flow
3. You may add framing sentences ("This represents...", "Notably...") but NO new factual claims
4. For claims with confidence "partial" or "unverified", use hedging language ("reportedly", "approximately")
5. CRITICAL: After each factual sentence, add a footnote reference [^N] for the source.
   Group the claim IDs used in that sentence as a comment: {/* claims: c-kalshi-XXX, c-kalshi-YYY */}
6. If an asset is provided, embed it naturally in the prose with a brief introduction

Output ONLY the section content (no heading — I'll add that). Use markdown formatting.`;

    try {
      const sectionContent = await llm(
        "You compose wiki sections from verified claims. Never invent factual content. Write engaging, well-structured prose. Always trace facts to claim IDs.",
        sectionPrompt,
        { model: STRONG_MODEL, maxTokens: 2048 }
      );

      composedSections.push(`## ${sectionHeading}\n\n${sectionContent.trim()}`);

      // Collect footnotes from claims used
      for (const claim of allUsable) {
        if (claim.sourceUrl) {
          footnoteCounter++;
          footnotes.push(
            `[^${footnoteCounter}]: [${(claim.text ?? "").slice(0, 60)}...](${claim.sourceUrl})`
          );
        }
      }
    } catch (err: any) {
      console.log(`    ⚠ Error composing ${sectionHeading}: ${err.message}`);
    }
  }

  // Report on unused claims
  const unusedClaims = claims.filter((c) => !usedClaimIds.has(c.id));
  const unusedVerified = unusedClaims.filter((c) => c.confidence === "verified");
  if (unusedVerified.length > 0) {
    console.log(`\n  ⚠ ${unusedVerified.length} verified claims were not used in any section:`);
    for (const c of unusedVerified.slice(0, 10)) {
      console.log(`    [${c.id}] (${c.section}) ${c.text?.slice(0, 80)}`);
    }
  }

  // Assemble the full page
  const frontmatter = `---
title: "Kalshi (Prediction Market)"
description: First CFTC-regulated US prediction market exchange for trading event contracts
entityType: organization
subcategory: epistemic-orgs
quality: 25
lastEdited: "${new Date().toISOString().slice(0, 10)}"
---`;

  const fullPage = [
    frontmatter,
    "",
    `{/* This page was composed from ${claims.length} atomic claims using the claim-first architecture experiment. */}`,
    "",
    ...composedSections,
    "",
    "## Sources",
    "",
    ...footnotes,
  ].join("\n");

  console.log(`\n  Composed page: ${composedSections.length} sections, ${fullPage.split("\n").length} lines`);
  save("step5-composed-page.mdx", fullPage);
  return fullPage;
}

// ─── Step 6: Compare ────────────────────────────────────────────────────────────

async function step6_compare(
  composedPage: string,
  claims: VerifiedClaim[]
): Promise<void> {
  console.log("\n━━━ Step 6: Compare Original vs. Composed ━━━\n");

  const original = loadPageContent();
  const originalBody = stripFrontmatter(original);
  const composedBody = stripFrontmatter(composedPage);

  const originalLines = originalBody.split("\n").length;
  const composedLines = composedBody.split("\n").length;
  const originalWords = originalBody.split(/\s+/).length;
  const composedWords = composedBody.split(/\s+/).length;

  // Count sections
  const originalSections = (originalBody.match(/\n## /g) ?? []).length;
  const composedSections = (composedBody.match(/\n## /g) ?? []).length;

  // Count footnotes
  const originalFootnotes = (originalBody.match(/\[\^(\d+)\]/g) ?? []).length;
  const composedFootnotes = (composedBody.match(/\[\^(\d+)\]/g) ?? []).length;

  // Claim verification stats
  const byConfidence: Record<string, number> = {};
  for (const c of claims) {
    byConfidence[c.confidence] = (byConfidence[c.confidence] ?? 0) + 1;
  }

  // Count claim references in composed page
  const claimRefMatches = composedBody.match(/c-kalshi-\d{3}/g) ?? [];
  const uniqueClaimsReferenced = new Set(claimRefMatches).size;

  const report = {
    original: {
      lines: originalLines,
      words: originalWords,
      sections: originalSections,
      footnotes: originalFootnotes,
    },
    composed: {
      lines: composedLines,
      words: composedWords,
      sections: composedSections,
      footnotes: composedFootnotes,
    },
    claimStore: {
      totalClaims: claims.length,
      byConfidence,
      byType: Object.fromEntries(
        Object.entries(
          claims.reduce(
            (acc, c) => ({ ...acc, [c.type]: (acc[c.type] ?? 0) + 1 }),
            {} as Record<string, number>
          )
        )
      ),
    },
    traceability: {
      claimRefsInComposedPage: claimRefMatches.length,
      uniqueClaimsReferenced,
      claimCoverage: `${((uniqueClaimsReferenced / claims.length) * 100).toFixed(1)}%`,
    },
    costEstimate: {
      llmCalls: cost.calls,
      estimatedInputTokens: cost.inputTokensEst,
      estimatedOutputTokens: cost.outputTokensEst,
    },
  };

  console.log("  Comparison:");
  console.log(`    Original: ${originalWords} words, ${originalSections} sections, ${originalFootnotes} footnote refs`);
  console.log(`    Composed: ${composedWords} words, ${composedSections} sections, ${composedFootnotes} footnote refs`);
  console.log(`    Claims: ${claims.length} total (${byConfidence.verified ?? 0} verified, ${byConfidence.partial ?? 0} partial, ${byConfidence.unverified ?? 0} unverified)`);
  console.log(`    LLM calls: ${cost.calls}`);

  save("step6-comparison.json", report);

  // Also save a human-readable report
  const readableReport = `# Claim-First Experiment: Kalshi Page Reconstruction

## Comparison: Original vs. Composed

| Metric | Original | Composed |
|--------|----------|----------|
| Words | ${originalWords} | ${composedWords} |
| Lines | ${originalLines} | ${composedLines} |
| Sections | ${originalSections} | ${composedSections} |
| Footnote refs | ${originalFootnotes} | ${composedFootnotes} |

## Claim Store Statistics

- **Total claims extracted**: ${claims.length}
- **Verified**: ${byConfidence.verified ?? 0} (${((byConfidence.verified ?? 0) / claims.length * 100).toFixed(1)}%)
- **Partial**: ${byConfidence.partial ?? 0}
- **Unverified**: ${byConfidence.unverified ?? 0}
- **No source**: ${byConfidence["no-source"] ?? 0}

### Claims by Type
${Object.entries(report.claimStore.byType).map(([t, n]) => `- ${t}: ${n}`).join("\n")}

## Traceability

- **Claim refs in composed page**: ${claimRefMatches.length}
- **Unique claims referenced**: ${uniqueClaimsReferenced}
- **Claim coverage**: ${report.traceability.claimCoverage}

## Cost
- LLM calls: ${cost.calls}
- Estimated input tokens: ~${cost.inputTokensEst.toLocaleString()}
- Estimated output tokens: ~${cost.outputTokensEst.toLocaleString()}

## Key Observations

*(Review the composed page at .claude/claim-first-experiment/step5-composed-page.mdx)*

### What worked well
- [ ] Claims extracted completely
- [ ] Verification caught real issues
- [ ] Assets built from claims are accurate
- [ ] Composed prose reads naturally
- [ ] Every factual sentence traceable to a claim

### What needs improvement
- [ ] Claims too granular / too coarse
- [ ] Verification too strict / too lenient
- [ ] Composed prose is choppy
- [ ] Missing important content from original
- [ ] Editorial direction unhelpful
`;

  save("step6-report.md", readableReport);
}

// ─── Step 7: Second View (Executive Briefing) ──────────────────────────────────

async function step7_briefing(
  claims: VerifiedClaim[],
  assets: Asset[],
  editorial: EditorialDirection
): Promise<string> {
  console.log("\n━━━ Step 7: Compose Second View (Executive Briefing) ━━━\n");

  // Select only high-confidence, high-importance claims
  const topClaims = claims
    .filter((c) => c.confidence === "verified" || c.confidence === "partial")
    .slice(0, 40); // Take top 40 claims

  const prompt = `You are composing a 500-word executive briefing about Kalshi from verified claims.

NARRATIVE: ${editorial.keyNarrative}
AUDIENCE: Senior decision-makers who need a quick overview of Kalshi's relevance to AI forecasting and safety.

VERIFIED CLAIMS (use these and ONLY these):
${topClaims.map((c) => `- [${c.type}] ${c.text}`).join("\n")}

KEY ANGLES:
${editorial.importantAngles.map((a) => `- ${a}`).join("\n")}

MISSING PERSPECTIVES (flag these as gaps):
${editorial.missingPerspectives.map((p) => `- ${p}`).join("\n")}

Write a concise, structured briefing (~500 words) with:
1. **Bottom Line Up Front** (2-3 sentences)
2. **Key Facts** (bullet points, the most important verified claims)
3. **Strategic Context** (1-2 paragraphs on why this matters for AI safety)
4. **Watch Items** (gaps and uncertainties)

Rules:
- Do NOT invent facts beyond the claims provided
- Use direct, telegraphic style appropriate for busy executives
- Highlight the LIMITED AI safety relevance — this is mostly a sports/politics prediction market

Output ONLY the briefing content (markdown).`;

  const briefing = await llm(
    "You compose concise executive briefings from verified claims. Never invent facts.",
    prompt,
    { model: STRONG_MODEL, maxTokens: 2048 }
  );

  console.log(`  Briefing composed: ${briefing.split(/\s+/).length} words`);
  save("step7-briefing.md", briefing);

  return briefing;
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Load .env before initializing LLM (reads API keys at module level)
  const dotenv = await import("dotenv");
  dotenv.config({ path: path.join(ROOT, ".env") });
  await initLLM();

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  Claim-First Architecture Experiment: Kalshi        ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`Output: ${path.relative(ROOT, OUTPUT_DIR)}/`);

  const stepArg = process.argv.find((a) => a.startsWith("--step="));
  const targetStep = stepArg ? parseInt(stepArg.split("=")[1]) : 0; // 0 = all

  const startTime = Date.now();

  let claims: Claim[];
  let verifiedClaims: VerifiedClaim[];
  let assets: Asset[];
  let editorial: EditorialDirection;
  let composedPage: string;

  // Step 1: Extract claims
  if (targetStep === 0 || targetStep === 1) {
    claims = await step1_extractClaims();
  } else {
    claims = load<Claim[]>("step1-claims.json");
    console.log(`  Loaded ${claims.length} claims from step 1`);
  }

  // Step 2: Verify claims
  if (targetStep === 0 || targetStep === 2) {
    verifiedClaims = await step2_verifyClaims(claims);
  } else {
    verifiedClaims = load<VerifiedClaim[]>("step2-verified-claims.json");
    console.log(`  Loaded ${verifiedClaims.length} verified claims from step 2`);
  }

  // Step 3: Build assets
  if (targetStep === 0 || targetStep === 3) {
    assets = await step3_buildAssets(verifiedClaims);
  } else {
    assets = load<Asset[]>("step3-assets.json");
    console.log(`  Loaded ${assets.length} assets from step 3`);
  }

  // Step 4: Editorial direction
  if (targetStep === 0 || targetStep === 4) {
    editorial = await step4_editorial(verifiedClaims, assets);
  } else {
    editorial = load<EditorialDirection>("step4-editorial.json");
    console.log(`  Loaded editorial direction from step 4`);
  }

  // Step 5: Compose wiki page
  if (targetStep === 0 || targetStep === 5) {
    composedPage = await step5_composePage(verifiedClaims, assets, editorial);
  } else {
    composedPage = fs.readFileSync(path.join(OUTPUT_DIR, "step5-composed-page.mdx"), "utf-8");
    console.log(`  Loaded composed page from step 5`);
  }

  // Step 6: Compare
  if (targetStep === 0 || targetStep === 6) {
    await step6_compare(composedPage, verifiedClaims);
  }

  // Step 7: Second view
  if (targetStep === 0 || targetStep === 7) {
    await step7_briefing(verifiedClaims, assets, editorial);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n━━━ Experiment Complete ━━━`);
  console.log(`  Duration: ${elapsed}s`);
  console.log(`  LLM calls: ${cost.calls}`);
  console.log(`  Output: ${path.relative(ROOT, OUTPUT_DIR)}/`);
  console.log(`\n  Files:`);
  for (const f of fs.readdirSync(OUTPUT_DIR).sort()) {
    const size = fs.statSync(path.join(OUTPUT_DIR, f)).size;
    console.log(`    ${f} (${(size / 1024).toFixed(1)}KB)`);
  }

  // Save final knowledge bundle
  const bundle: KnowledgeBundle = {
    entity: "kalshi",
    createdAt: new Date().toISOString(),
    claims: verifiedClaims,
    assets,
    editorial,
    stats: {
      totalClaims: verifiedClaims.length,
      verified: verifiedClaims.filter((c) => c.confidence === "verified").length,
      partial: verifiedClaims.filter((c) => c.confidence === "partial").length,
      unverified: verifiedClaims.filter((c) => c.confidence === "unverified").length,
      noSource: verifiedClaims.filter((c) => c.confidence === "no-source").length,
      byType: verifiedClaims.reduce(
        (acc, c) => ({ ...acc, [c.type]: (acc[c.type] ?? 0) + 1 }),
        {} as Record<string, number>
      ),
    },
  };
  save("knowledge-bundle-kalshi.json", bundle);
  console.log(`\n  Knowledge bundle saved.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
