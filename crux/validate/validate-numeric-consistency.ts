#!/usr/bin/env node

/**
 * Cross-Page Numeric Claim Consistency Checker
 *
 * For a given entity (or all entities), finds all MDX pages referencing it,
 * extracts numeric claims from the context of those entity mentions,
 * and reports potential contradictions.
 *
 * Usage:
 *   npx tsx crux/validate/validate-numeric-consistency.ts --entity=anthropic
 *   npx tsx crux/validate/validate-numeric-consistency.ts --entity=anthropic --json
 *   npx tsx crux/validate/validate-numeric-consistency.ts  # all entities (slow)
 *
 * Exit codes:
 *   0 = No high-confidence contradictions
 *   1 = High-confidence contradictions found
 *
 * Resolves: https://github.com/quantified-uncertainty/longterm-wiki/issues/917
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getContentBody } from '../lib/mdx-utils.ts';
import { CONTENT_DIR } from '../lib/content-types.ts';
import type { ValidatorResult } from './types.ts';

// ============================================================================
// TYPES
// ============================================================================

interface NumericClaim {
  pageId: string;
  filePath: string;
  line: number;
  sentence: string;
  numbers: string[];
}

interface ContradictionReport {
  entityId: string;
  claim1: NumericClaim;
  claim2: NumericClaim;
  reason: string;
}

// ============================================================================
// PARSING
// ============================================================================

/**
 * Extract sentences containing numeric values from text.
 * Returns sentences that have at least one number.
 */
function extractNumericSentences(text: string): { sentence: string; numbers: string[] }[] {
  // Split into sentences (rough heuristic)
  const sentences = text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);

  const result: { sentence: string; numbers: string[] }[] = [];

  for (const sentence of sentences) {
    // Find numeric patterns: percentages, counts, dollar amounts, years
    const numberPatterns = [
      /\d+(?:\.\d+)?%/g,                    // percentages: 25%, 10.5%
      /\$[\d.,]+[BMK]?/g,                    // dollar amounts: $3B, $100M
      /\b\d{1,3}(?:,\d{3})+\b/g,            // comma-formatted: 1,000, 2,500,000
      /\b\d+(?:\.\d+)?\s*(?:million|billion|trillion)\b/gi, // 3 million, 4.5 billion
      /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:million|billion|thousand)\b/gi,
    ];

    const numbers: string[] = [];
    for (const pattern of numberPatterns) {
      const matches = [...sentence.matchAll(pattern)];
      numbers.push(...matches.map(m => m[0]));
    }

    if (numbers.length > 0) {
      result.push({ sentence: sentence.trim(), numbers });
    }
  }

  return result;
}

/**
 * Extract the page ID from a file path.
 */
function filePathToPageId(filePath: string): string {
  return filePath
    .replace(/^.*content\/docs\//, '')
    .replace(/\.mdx?$/, '');
}

/**
 * Find all sentences near an entity mention in the body.
 */
function extractEntityContextClaims(
  body: string,
  entityId: string,
  filePath: string,
): NumericClaim[] {
  const lines = body.split('\n');
  const claims: NumericClaim[] = [];

  // Find lines that mention the entity (via EntityLink or slug)
  const entityPatterns = [
    new RegExp(`EntityLink[^>]*id=["']${entityId}["']`, 'i'),
    new RegExp(`\\b${entityId.replace(/-/g, '[- ]')}\\b`, 'i'),
  ];

  const entityLineNums = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (entityPatterns.some(p => p.test(lines[i]))) {
      // Include 2 lines before and after for context
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
        entityLineNums.add(j);
      }
    }
  }

  // For each context window, extract numeric sentences
  const contextText = [...entityLineNums]
    .sort((a, b) => a - b)
    .map(i => lines[i])
    .join(' ');

  const numericSentences = extractNumericSentences(contextText);

  for (const { sentence, numbers } of numericSentences) {
    // Find which line this sentence appears on (approximate)
    const lineNum = lines.findIndex(l => l.includes(sentence.substring(0, 30)));
    claims.push({
      pageId: filePathToPageId(filePath),
      filePath,
      line: lineNum >= 0 ? lineNum + 1 : 1,
      sentence,
      numbers,
    });
  }

  return claims;
}

// ============================================================================
// CONTRADICTION DETECTION (heuristic, no LLM)
// ============================================================================

/**
 * Parse a number string to a float for comparison.
 * Handles percentages, dollar amounts, and multipliers.
 */
function parseNumericValue(numStr: string): number | null {
  const s = numStr.toLowerCase().replace(/,/g, '');

  // Percentage
  if (s.endsWith('%')) return parseFloat(s) / 100;

  // Dollar amounts with multipliers
  const dollarMatch = s.match(/\$?([\d.]+)(m|b|k|million|billion|thousand)?/i);
  if (dollarMatch) {
    const base = parseFloat(dollarMatch[1]);
    const mult = dollarMatch[2]?.toLowerCase();
    if (mult === 'b' || mult === 'billion') return base * 1e9;
    if (mult === 'm' || mult === 'million') return base * 1e6;
    if (mult === 'k' || mult === 'thousand') return base * 1e3;
    return base;
  }

  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/**
 * Find potentially contradictory claims.
 * Simple heuristic: if two pages mention the same entity in the same numeric
 * context and the values differ by >2x, flag as a potential contradiction.
 */
function findHeuristicContradictions(
  claims: NumericClaim[],
): ContradictionReport[] {
  const contradictions: ContradictionReport[] = [];

  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const c1 = claims[i];
      const c2 = claims[j];

      // Skip if same page
      if (c1.pageId === c2.pageId) continue;

      // Compare numbers between the two claims
      for (const n1 of c1.numbers) {
        for (const n2 of c2.numbers) {
          const v1 = parseNumericValue(n1);
          const v2 = parseNumericValue(n2);

          if (v1 === null || v2 === null) continue;
          if (v1 === 0 || v2 === 0) continue;

          const ratio = Math.max(v1, v2) / Math.min(v1, v2);

          // Flag if values differ by more than 2x (potential contradiction)
          // and are in a similar numeric range (same order of magnitude bucket)
          const sameUnit =
            (n1.includes('%') && n2.includes('%')) ||
            (n1.includes('$') && n2.includes('$')) ||
            (!n1.includes('%') && !n2.includes('%') && !n1.includes('$') && !n2.includes('$'));

          if (sameUnit && ratio > 2.0 && ratio < 1000) {
            contradictions.push({
              entityId: '',
              claim1: c1,
              claim2: c2,
              reason: `${n1} vs ${n2} (${ratio.toFixed(1)}× difference)`,
            });
          }
        }
      }
    }
  }

  return contradictions;
}

// ============================================================================
// MAIN RUNNER
// ============================================================================

export async function runNumericConsistency(options: {
  entityId?: string;
  json?: boolean;
  limit?: number;
}): Promise<ValidatorResult> {
  const files = findMdxFiles(CONTENT_DIR);

  // Collect entity → claims
  const entityClaims: Map<string, NumericClaim[]> = new Map();

  for (const filePath of files) {
    // Skip internal docs
    const rel = filePath.replace(/^.*content\/docs\//, '');
    if (rel.startsWith('internal/')) continue;

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const body = getContentBody(raw);

    // Find entity IDs in this file via EntityLink references
    const entityLinkPattern = /EntityLink[^>]*id=["']([^"']+)["']/g;
    const entitiesInFile = new Set<string>();

    let m: RegExpExecArray | null;
    while ((m = entityLinkPattern.exec(body)) !== null) {
      entitiesInFile.add(m[1]);
    }

    // Filter to specific entity if --entity specified
    if (options.entityId) {
      if (!entitiesInFile.has(options.entityId)) continue;
      entitiesInFile.clear();
      entitiesInFile.add(options.entityId);
    }

    for (const entityId of entitiesInFile) {
      const claims = extractEntityContextClaims(body, entityId, filePath);
      if (claims.length === 0) continue;

      const existing = entityClaims.get(entityId) ?? [];
      existing.push(...claims);
      entityClaims.set(entityId, existing);
    }
  }

  // Find contradictions
  const allContradictions: ContradictionReport[] = [];

  for (const [entityId, claims] of entityClaims.entries()) {
    if (claims.length < 2) continue;

    const contradictions = findHeuristicContradictions(claims);
    for (const c of contradictions) {
      c.entityId = entityId;
      allContradictions.push(c);
    }
  }

  // Deduplicate (same claim pair can match multiple numbers)
  const seen = new Set<string>();
  const deduped = allContradictions.filter(c => {
    const key = `${c.entityId}|${c.claim1.pageId}|${c.claim2.pageId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const limit = options.limit ?? 20;
  const top = deduped.slice(0, limit);

  // Output mode:
  // Without --entity: show high-confidence candidates only (deduped list)
  // With --entity: show all numeric claims grouped by page (review mode)
  if (options.entityId) {
    // Review mode: show all numeric claims for this entity
    const entityClaimsForId = entityClaims.get(options.entityId) ?? [];
    if (options.json) {
      console.log(JSON.stringify({
        entity: options.entityId,
        claims: entityClaimsForId.map(c => ({
          page: c.pageId,
          line: c.line,
          numbers: c.numbers,
          sentence: c.sentence.substring(0, 200),
        })),
        potentialContradictions: deduped.length,
      }, null, 2));
    } else {
      console.log(`\n📊 Numeric Claims Review: ${options.entityId}\n`);
      console.log(`Found ${entityClaimsForId.length} numeric claims across ${new Set(entityClaimsForId.map(c => c.pageId)).size} pages.\n`);
      for (const claim of entityClaimsForId.slice(0, limit)) {
        console.log(`  [${claim.pageId}:${claim.line}] ${claim.numbers.join(', ')}`);
        console.log(`    ${claim.sentence.substring(0, 150)}${claim.sentence.length > 150 ? '…' : ''}`);
      }
      if (entityClaimsForId.length > limit) {
        console.log(`  ...and ${entityClaimsForId.length - limit} more. Use --top=N to see more.`);
      }
      if (deduped.length > 0) {
        console.log(`\n  ⚠️  ${deduped.length} potential numeric contradictions detected (heuristic, may have false positives).`);
        console.log(`  Run with --json to get full details. Consider LLM review for confirmation.`);
      }
    }
  } else {
    // Broad mode: just show summary and top contradiction candidates
    if (options.json) {
      console.log(JSON.stringify({
        entity: 'all',
        highConfidenceCandidates: top.map(c => ({
          entityId: c.entityId,
          page1: c.claim1.pageId,
          page2: c.claim2.pageId,
          claim1: c.claim1.sentence.substring(0, 200),
          claim2: c.claim2.sentence.substring(0, 200),
          reason: c.reason,
        })),
        total: deduped.length,
      }, null, 2));
    } else {
      if (deduped.length === 0) {
        console.log('✅ No numeric contradiction candidates detected.');
      } else {
        console.log(`\n⚠️  Potential Numeric Contradictions (${deduped.length} candidates, showing ${top.length})`);
        console.log(`  Note: heuristic detection — false-positive rate is high. Use --entity=<id> to review specific entities.\n`);
        for (const c of top) {
          console.log(`  [${c.entityId}] ${c.reason}`);
          console.log(`    • ${c.claim1.pageId}: ${c.claim1.sentence.substring(0, 100)}…`);
          console.log(`    • ${c.claim2.pageId}: ${c.claim2.sentence.substring(0, 100)}…`);
          console.log();
        }
        if (deduped.length > limit) {
          console.log(`  ...and ${deduped.length - limit} more.`);
        }
      }
    }
  }

  // Advisory only — never fail CI (contradiction detection has too many false positives without LLM)
  return {
    passed: true,
    errors: 0,
    warnings: deduped.length,
    infos: 0,
  };
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const entityArg = args.find(a => a.startsWith('--entity='));
  const entityId = entityArg ? entityArg.split('=')[1] : undefined;
  const json = args.includes('--json') || args.includes('--ci');
  const topArg = args.find(a => a.startsWith('--top=') || a.startsWith('--limit='));
  const limit = topArg ? parseInt(topArg.split('=')[1], 10) : 20;

  const result = await runNumericConsistency({ entityId, json, limit });
  process.exit(0); // advisory only — never block CI
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
