/**
 * Fix Contradicted FactBase Facts
 *
 * Reads contradicted fact verdicts from the wiki-server, extracts the correct
 * value from the verdict reasoning using Haiku, and updates the YAML files
 * in packages/factbase/data/things/ automatically.
 *
 * Many contradictions are rounding issues (stored $116M when source says
 * $115,576,357). We store exact values and let the display layer handle
 * formatting.
 *
 * Usage:
 *   WIKI_SERVER_ENV=prod node --import tsx/esm crux/scripts/fix-contradicted-facts.ts [--apply] [--entity=<slug>]
 *
 * Flags:
 *   --apply          Actually write changes to YAML files (default: dry-run)
 *   --entity=<slug>  Only process facts for a specific entity (by YAML filename)
 *   --limit=<n>      Max number of contradicted verdicts to fetch (default: 200)
 *   --skip-llm       Skip LLM extraction, just report contradictions
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLlmClient, callLlm, MODELS } from "../lib/llm.ts";
import { getFailures, type FailuresResponse } from "../lib/wiki-server/sourcing.ts";
import { escapeXml } from "../lib/prompt-utils.ts";
import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, "../..");
const THINGS_DIR = join(ROOT, "packages/factbase/data/things");

const args = process.argv.slice(2);
const applyMode = args.includes("--apply");
const skipLlm = args.includes("--skip-llm");
const entityFilter = args.find((a) => a.startsWith("--entity="))?.split("=")[1];
const limitArg = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
const fetchLimit = limitArg ? parseInt(limitArg, 10) : 200;
if (!Number.isFinite(fetchLimit) || fetchLimit < 1) {
  console.error(`Invalid --limit value: "${limitArg}" — must be a positive integer`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type VerdictItem = FailuresResponse["items"][number];

export interface FactLocation {
  filePath: string;
  /** The entity slug (filename without .yaml) */
  entitySlug: string;
  /** Line number where "  - id: <factId>" appears (0-based) */
  idLineIndex: number;
  /** Line number where "    value:" appears (0-based) */
  valueLineIndex: number;
  /** The current raw value string from YAML */
  currentValueRaw: string;
  /** The parsed numeric value, or null if non-numeric */
  currentNumericValue: number | null;
  /** Whether the value spans multiple lines */
  isMultiLineValue: boolean;
  /** Property name for the fact */
  property: string;
}

export interface Extraction {
  /** The correct value from the source, as reported in the verdict reasoning */
  correctValue: number | null;
  /** Human-readable description of the correction */
  description: string;
  /** Whether this is a numeric correction */
  isNumeric: boolean;
  /** The raw string the LLM extracted */
  rawExtraction: string;
}

interface FixResult {
  factId: string;
  entitySlug: string;
  property: string;
  currentValue: string;
  correctValue: string;
  reasoning: string;
  applied: boolean;
  skipped: boolean;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Step 1: Build a fact-ID → file index
// ---------------------------------------------------------------------------

/**
 * Build an index mapping fact IDs to their YAML file location.
 * This avoids loading the entire FactBase graph just to locate facts.
 */
export function buildFactIndex(
  thingsDir: string,
  filter?: string,
): Map<string, FactLocation> {
  const index = new Map<string, FactLocation>();
  const files = readdirSync(thingsDir).filter((f) => f.endsWith(".yaml"));

  for (const filename of files) {
    const entitySlug = filename.replace(/\.yaml$/, "");
    if (filter && entitySlug !== filter) continue;

    const filePath = join(thingsDir, filename);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const idMatch = lines[i].match(/^(\s{2,4})-\s+id:\s+(.+)/);
      if (!idMatch) continue;

      const factId = idMatch[2].trim().replace(/^["']|["']$/g, "");

      // Look ahead for the value and property lines (within next 10 lines)
      let valueLineIndex = -1;
      let currentValueRaw = "";
      let isMultiLineValue = false;
      let property = "";

      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        // Stop if we hit another fact block
        if (/^\s{2,4}-\s+id:/.test(lines[j])) break;

        const valueMatch = lines[j].match(/^\s+value:\s*(.*)/);
        if (valueMatch) {
          valueLineIndex = j;
          currentValueRaw = valueMatch[1].trim();

          // Check for multi-line values (>, |, >-, |-)
          if (/^[>|][-+]?\s*$/.test(currentValueRaw) || currentValueRaw === "") {
            isMultiLineValue = true;
            // Collect continuation lines
            const continuationLines: string[] = [];
            for (let k = j + 1; k < lines.length; k++) {
              const line = lines[k];
              // Continuation lines are more indented than the value: line
              if (/^\s{6,}/.test(line) && line.trim() !== "") {
                continuationLines.push(line.trim());
              } else {
                break;
              }
            }
            currentValueRaw =
              currentValueRaw + " " + continuationLines.join(" ");
          }
        }

        const propMatch = lines[j].match(/^\s+property:\s+(.*)/);
        if (propMatch) {
          property = propMatch[1].trim().replace(/^["']|["']$/g, "");
        }
      }

      if (valueLineIndex === -1) continue;

      // Parse numeric value
      let currentNumericValue: number | null = null;
      const cleanedVal = currentValueRaw.replace(/^["']|["']$/g, "");
      const numStr = cleanedVal.replace(/,/g, "");
      const parsed = Number(numStr);
      if (!isNaN(parsed) && numStr !== "" && numStr !== "true" && numStr !== "false") {
        currentNumericValue = parsed;
      }

      index.set(factId, {
        filePath,
        entitySlug,
        idLineIndex: i,
        valueLineIndex,
        currentValueRaw,
        currentNumericValue,
        isMultiLineValue,
        property,
      });
    }
  }

  return index;
}

// ---------------------------------------------------------------------------
// Step 2: LLM extraction — get the correct value from reasoning
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You are a data extraction assistant. Given a sourcing verdict reasoning about a factual claim, extract the CORRECT value according to the source.

Rules:
- For monetary values, return the EXACT number without currency symbols or abbreviations. Example: if the source says "$115,576,357", return "115576357".
- For counts (employees, headcount), return the exact integer. Example: "25,500 employees" → "25500".
- For percentages, return the decimal. Example: "45%" → "0.45".
- For non-numeric corrections (text changes, date corrections, role descriptions), set is_numeric to false and return the correct text.
- If the reasoning describes multiple possible correct values or is ambiguous, return "AMBIGUOUS" as the value.
- If you cannot determine a single correct value, return "UNCLEAR" as the value.

Respond with ONLY a JSON object in this exact format:
{"value": "<the correct value>", "is_numeric": true, "description": "<brief explanation>"}`;

export async function extractCorrectValue(
  client: Anthropic,
  reasoning: string,
  currentValue: string,
): Promise<Extraction> {
  const result = await callLlm(client, {
    system: EXTRACTION_SYSTEM_PROMPT,
    user: `<verdict_reasoning>${escapeXml(reasoning)}</verdict_reasoning>

<current_value>${escapeXml(currentValue)}</current_value>

Extract the correct value according to the source.`,
  }, {
    model: MODELS.haiku,
    maxTokens: 500,
    temperature: 0,
    retryLabel: "extract-correct-value",
  });

  return parseExtractionResponse(result.text);
}

/**
 * Parse the LLM extraction response into a structured Extraction.
 * Exported for testing.
 */
export function parseExtractionResponse(text: string): Extraction {
  try {
    // Extract JSON from the response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        correctValue: null,
        description: "Failed to parse LLM response",
        isNumeric: false,
        rawExtraction: text,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      value: string;
      is_numeric: boolean;
      description: string;
    };

    if (parsed.value === "AMBIGUOUS" || parsed.value === "UNCLEAR") {
      return {
        correctValue: null,
        description: parsed.description || parsed.value,
        isNumeric: false,
        rawExtraction: parsed.value,
      };
    }

    if (parsed.is_numeric) {
      const numericValue = Number(parsed.value);
      // Reject NaN, Infinity, -Infinity — malformed model output must not be
      // written back to authoritative YAML as a "numeric" fact.
      if (!Number.isFinite(numericValue)) {
        return {
          correctValue: null,
          description: `LLM said numeric but value "${parsed.value}" is not a valid finite number`,
          isNumeric: false,
          rawExtraction: parsed.value,
        };
      }
      return {
        correctValue: numericValue,
        description: parsed.description,
        isNumeric: true,
        rawExtraction: parsed.value,
      };
    }

    return {
      correctValue: null,
      description: parsed.description,
      isNumeric: false,
      rawExtraction: parsed.value,
    };
  } catch (e: unknown) {
    return {
      correctValue: null,
      description: `JSON parse error: ${e instanceof Error ? e.message : String(e)}`,
      isNumeric: false,
      rawExtraction: text,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 3: Apply the fix to the YAML file
// ---------------------------------------------------------------------------

/**
 * Update a fact's value in the YAML file. Uses line-level surgery to
 * preserve formatting (like strip-career-facts.ts).
 *
 * Only handles simple single-line numeric values. Multi-line values
 * and non-numeric values are skipped.
 */
export function applyFix(location: FactLocation, newValue: number): boolean {
  const content = readFileSync(location.filePath, "utf-8");
  const lines = content.split("\n");

  const valueLine = lines[location.valueLineIndex];
  if (!valueLine) return false;

  // Match the value line pattern, preserving leading whitespace
  const match = valueLine.match(/^(\s+value:\s*).+$/);
  if (!match) return false;

  // Format the new value
  const formatted = formatNumericValue(newValue);
  lines[location.valueLineIndex] = `${match[1]}${formatted}`;

  writeFileSync(location.filePath, lines.join("\n"));
  return true;
}

/**
 * Format a numeric value for YAML storage.
 * - Exact integers stay as integers: 115576357
 * - Large round numbers use scientific notation: 1e+9
 * - Decimals stay as decimals: 0.45
 */
export function formatNumericValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);

  // If it's an integer and a "round" number (ends in many zeros), use scientific notation
  if (Number.isInteger(value) && value !== 0) {
    const abs = Math.abs(value);
    const str = String(abs);
    const trailingZeros = str.match(/0+$/)?.[0]?.length ?? 0;
    // Use scientific notation only for values like 1e+9, 5e+8
    // (at most 1 significant digit before trailing zeros, and at least 6 trailing zeros)
    if (trailingZeros >= 6 && str.replace(/0+$/, "").length <= 1) {
      // Build scientific notation manually to avoid "1.2e+7" for 12000000
      const significand = abs / Math.pow(10, trailingZeros + str.replace(/0+$/, "").length - 1);
      const exponent = str.length - 1;
      const sign = value < 0 ? "-" : "";
      return `${sign}${significand}e+${exponent}`;
    }
  }

  return String(value);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Fix Contradicted FactBase Facts ===\n");
  console.log(`Mode: ${applyMode ? "APPLY" : "DRY RUN"}`);
  if (entityFilter) console.log(`Entity filter: ${entityFilter}`);
  if (skipLlm) console.log("LLM extraction: SKIPPED");
  console.log();

  // 1. Build fact index from YAML files
  console.log("Building fact index from YAML files...");
  const factIndex = buildFactIndex(THINGS_DIR, entityFilter);
  console.log(`  Indexed ${factIndex.size} facts from YAML files\n`);

  // 2. Fetch contradicted verdicts from wiki-server
  console.log("Fetching contradicted fact verdicts from wiki-server...");
  const result = await getFailures({
    error_type: "contradicted",
    record_type: "fact",
    limit: fetchLimit,
  });

  if (!result.ok) {
    console.error(
      `Failed to fetch contradicted verdicts: ${result.message}`,
    );
    console.error(
      "Make sure WIKI_SERVER_ENV=prod is set and the wiki-server is reachable.",
    );
    process.exit(1);
  }

  const verdicts = result.data.items;
  console.log(
    `  Found ${verdicts.length} contradicted fact verdicts (of ${result.data.total} total)\n`,
  );

  if (verdicts.length === 0) {
    console.log("No contradicted facts to fix.");
    return;
  }

  // 3. Match verdicts to YAML facts
  const matched: Array<{ verdict: VerdictItem; location: FactLocation }> = [];
  const unmatched: string[] = [];

  for (const verdict of verdicts) {
    const location = factIndex.get(verdict.recordId);
    if (location) {
      matched.push({ verdict, location });
    } else {
      unmatched.push(verdict.recordId);
    }
  }

  console.log(`  Matched: ${matched.length} facts in YAML`);
  if (unmatched.length > 0) {
    console.log(
      `  Unmatched: ${unmatched.length} fact IDs not found in YAML${entityFilter ? " (may be filtered out)" : ""}`,
    );
  }
  console.log();

  if (matched.length === 0) {
    console.log("No matching facts to process.");
    return;
  }

  // 4. Process each matched fact
  const client = skipLlm ? null : createLlmClient();
  const results: FixResult[] = [];
  let applied = 0;
  let skipped = 0;
  let alreadyCorrect = 0;

  for (const { verdict, location } of matched) {
    console.log(
      `Processing ${verdict.recordId} (${location.entitySlug}/${location.property})...`,
    );

    // Skip verdicts with no reasoning — in --apply mode, sending an empty
    // string to the LLM could produce a fabricated numeric extraction that
    // gets written back to authoritative YAML without any source basis.
    if (!verdict.reasoning?.trim()) {
      console.log("  SKIP: no reasoning in verdict (manual review needed)");
      results.push({
        factId: verdict.recordId,
        entitySlug: location.entitySlug,
        property: location.property,
        currentValue: location.currentValueRaw,
        correctValue: "N/A",
        reasoning: "",
        applied: false,
        skipped: true,
        skipReason: "no reasoning in verdict",
      });
      skipped++;
      continue;
    }

    // Skip multi-line values
    if (location.isMultiLineValue) {
      console.log("  SKIP: multi-line value (manual review needed)");
      results.push({
        factId: verdict.recordId,
        entitySlug: location.entitySlug,
        property: location.property,
        currentValue: location.currentValueRaw,
        correctValue: "N/A",
        reasoning: verdict.reasoning || "",
        applied: false,
        skipped: true,
        skipReason: "multi-line value",
      });
      skipped++;
      continue;
    }

    // Skip non-numeric current values (text corrections are too risky to auto-fix)
    if (location.currentNumericValue === null) {
      console.log("  SKIP: non-numeric value (manual review needed)");
      results.push({
        factId: verdict.recordId,
        entitySlug: location.entitySlug,
        property: location.property,
        currentValue: location.currentValueRaw,
        correctValue: "N/A",
        reasoning: verdict.reasoning || "",
        applied: false,
        skipped: true,
        skipReason: "non-numeric value",
      });
      skipped++;
      continue;
    }

    if (skipLlm) {
      console.log(
        `  Current: ${location.currentValueRaw} (reasoning available but LLM skipped)`,
      );
      results.push({
        factId: verdict.recordId,
        entitySlug: location.entitySlug,
        property: location.property,
        currentValue: location.currentValueRaw,
        correctValue: "LLM skipped",
        reasoning: verdict.reasoning || "",
        applied: false,
        skipped: true,
        skipReason: "LLM skipped",
      });
      skipped++;
      continue;
    }

    // Extract correct value using Haiku
    const extraction = await extractCorrectValue(
      client!,
      verdict.reasoning || "",
      location.currentValueRaw,
    );

    if (!extraction.isNumeric || extraction.correctValue === null) {
      console.log(
        `  SKIP: ${extraction.description} (raw: ${extraction.rawExtraction})`,
      );
      results.push({
        factId: verdict.recordId,
        entitySlug: location.entitySlug,
        property: location.property,
        currentValue: location.currentValueRaw,
        correctValue: extraction.rawExtraction,
        reasoning: verdict.reasoning || "",
        applied: false,
        skipped: true,
        skipReason: extraction.description,
      });
      skipped++;
      continue;
    }

    // Check if the value actually needs changing
    if (location.currentNumericValue === extraction.correctValue) {
      console.log(
        `  ALREADY CORRECT: ${location.currentValueRaw} === ${extraction.correctValue}`,
      );
      alreadyCorrect++;
      results.push({
        factId: verdict.recordId,
        entitySlug: location.entitySlug,
        property: location.property,
        currentValue: location.currentValueRaw,
        correctValue: String(extraction.correctValue),
        reasoning: verdict.reasoning || "",
        applied: false,
        skipped: true,
        skipReason: "already correct",
      });
      continue;
    }

    // Apply or report
    const formatted = formatNumericValue(extraction.correctValue);
    console.log(
      `  ${location.currentValueRaw} → ${formatted} (${extraction.description})`,
    );

    if (applyMode) {
      const success = applyFix(location, extraction.correctValue);
      if (success) {
        console.log("  APPLIED");
        applied++;
      } else {
        console.log("  FAILED to apply");
        skipped++;
      }
      results.push({
        factId: verdict.recordId,
        entitySlug: location.entitySlug,
        property: location.property,
        currentValue: location.currentValueRaw,
        correctValue: formatted,
        reasoning: verdict.reasoning || "",
        applied: success,
        skipped: !success,
        skipReason: success ? undefined : "failed to apply",
      });
    } else {
      results.push({
        factId: verdict.recordId,
        entitySlug: location.entitySlug,
        property: location.property,
        currentValue: location.currentValueRaw,
        correctValue: formatted,
        reasoning: verdict.reasoning || "",
        applied: false,
        skipped: false,
      });
    }
  }

  // 5. Summary
  console.log("\n=== Summary ===");
  console.log(`Total contradicted verdicts: ${verdicts.length}`);
  console.log(`Matched to YAML: ${matched.length}`);
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`Skipped: ${skipped}`);
  if (applyMode) {
    console.log(`Applied: ${applied}`);
  } else {
    const wouldApply = results.filter(
      (r) => !r.skipped && !r.applied,
    ).length;
    console.log(`Would apply: ${wouldApply}`);
    if (wouldApply > 0) {
      console.log("\nRun with --apply to write changes.");
    }
  }

  // Show changes that would be or were applied
  const changes = results.filter((r) => !r.skipped);
  if (changes.length > 0) {
    console.log("\n=== Changes ===");
    for (const r of changes) {
      console.log(
        `  ${r.entitySlug}/${r.property} (${r.factId}): ${r.currentValue} → ${r.correctValue}${r.applied ? " [APPLIED]" : ""}`,
      );
    }
  }

  // Show skipped items that need manual review
  const manualReview = results.filter(
    (r) =>
      r.skipped &&
      r.skipReason !== "already correct" &&
      r.skipReason !== "LLM skipped",
  );
  if (manualReview.length > 0) {
    console.log("\n=== Needs Manual Review ===");
    for (const r of manualReview) {
      console.log(
        `  ${r.entitySlug}/${r.property} (${r.factId}): ${r.skipReason}`,
      );
      console.log(`    Current: ${r.currentValue}`);
      if (r.correctValue !== "N/A") {
        console.log(`    Suggested: ${r.correctValue}`);
      }
    }
  }
}

// Only run main() when executed directly (not when imported by tests)
const isDirectExecution =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].includes("fix-contradicted-facts") ||
    process.argv[1].endsWith("/tsx"));

if (isDirectExecution && !process.env.VITEST) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
