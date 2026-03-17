/**
 * Triage Phase
 *
 * Performs a cheap news check AND a quality/citation health check to
 * auto-select the appropriate improvement tier.
 *
 * ## Tier selection logic
 *
 * Two signals are combined; the more intensive tier wins:
 *
 * ### News signal (LLM-based)
 * - skip     → no meaningful new developments found
 * - polish   → minor updates only
 * - standard → notable new developments
 * - deep     → major developments requiring thorough research
 *
 * ### Quality signal (rule-based, no LLM)
 * Based on the page's numeric quality score (0–100) and footnote citation count:
 *
 *   - Grade >= B (quality >= 70) AND citations >= 10 → polish
 *     The page is already good and well-cited; only minor touch-ups needed.
 *   - Grade < B  (quality < 70)                     → standard
 *     The page has notable quality gaps; a standard improvement pass is warranted.
 *   - Grade < C  (quality < 60)                     → deep
 *     The page has significant quality deficits; a deep research pass is needed.
 *   - No quality score in frontmatter               → no quality signal (news signal used)
 *
 * Grade–to–score mapping (0–100 numeric quality field):
 *   A  ≥ 80   (high-quality, well-researched)
 *   B  ≥ 70   (good, solid content)
 *   C  ≥ 60   (adequate, some gaps)
 *   D  ≥ 40   (draft-quality, significant gaps)
 *   F  < 40   (stub or very low quality)
 *
 * ### Combining signals
 * The TIER_ORDER ranking (skip < polish < standard < deep) is used to take
 * the more intensive of the two signals. "skip" from news is only preserved
 * if there is no quality signal or the quality signal also says skip/polish
 * with strong citations.
 *
 * Exception: if news says "skip" and quality says "polish", the final result
 * is "polish" because the page quality warrants improvement even without
 * breaking news.
 */

import fs from 'fs';
import { MODELS } from '../../../lib/anthropic.ts';
import { stripFrontmatter } from '../../../lib/patterns.ts';
import { countFootnoteRefs } from '../../../lib/metrics-extractor.ts';
import type { PageData, TriageResult } from '../types.ts';
import { log, getFilePath, writeTemp } from '../utils.ts';
import { runAgent, executeWebSearch, executeScrySearch } from '../api.ts';
import { parseJsonFromLlm } from './json-parsing.ts';

// ── Tier ordering ─────────────────────────────────────────────────────────────

/**
 * Numeric order for tiers — higher = more intensive improvement.
 * Used to take the max of two signals.
 */
const TIER_ORDER: Record<string, number> = {
  skip: 0,
  polish: 1,
  standard: 2,
  deep: 3,
};

type Tier = 'skip' | 'polish' | 'standard' | 'deep';

/** Return the more intensive of two tiers. */
function maxTier(a: Tier, b: Tier): Tier {
  return (TIER_ORDER[a] >= TIER_ORDER[b] ? a : b) as Tier;
}

// ── Quality signal ────────────────────────────────────────────────────────────

/**
 * Map a numeric quality score (0–100) to a letter grade.
 *
 * Thresholds are aligned with the quality distribution ranges used in the
 * grading pipeline:
 *   A ≥ 80   (Comprehensive / high-quality)
 *   B ≥ 70   (Good)
 *   C ≥ 60   (Adequate)
 *   D ≥ 40   (Draft)
 *   F < 40   (Stub)
 */
export function qualityScoreToGrade(score: number): string {
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Determine the improvement tier based on page quality score and citation count.
 *
 * Returns null when quality data is unavailable (so the caller falls back to
 * the news signal alone).
 *
 * Logic (documented in module docblock above):
 *   - Grade >= B (quality >= 70) AND citations >= 10 → polish
 *   - Grade < B  (quality < 70)                     → standard
 *   - Grade < C  (quality < 60)                     → deep
 */
export function qualityBasedTier(
  qualityScore: number | null | undefined,
  citationCount: number,
): { tier: Tier; grade: string; reason: string } | null {
  if (qualityScore == null) {
    return null; // No quality signal available
  }

  const grade = qualityScoreToGrade(qualityScore);

  // Grade >= B AND well-cited → page is already good, polish is sufficient
  if (qualityScore >= 70 && citationCount >= 10) {
    return {
      tier: 'polish',
      grade,
      reason: `Grade ${grade} (quality ${qualityScore}) with ${citationCount} citations — page is solid and well-cited; polish tier sufficient`,
    };
  }

  // Grade < C → significant quality deficits; deep pass needed
  if (qualityScore < 60) {
    return {
      tier: 'deep',
      grade,
      reason: `Grade ${grade} (quality ${qualityScore}) — significant quality gaps; deep research pass warranted`,
    };
  }

  // Grade < B (70 > quality >= 60) OR Grade >= B but low citations → standard
  const citationNote = qualityScore >= 70 && citationCount < 10
    ? ` (only ${citationCount} citations; needs more sourcing)`
    : '';
  return {
    tier: 'standard',
    grade,
    reason: `Grade ${grade} (quality ${qualityScore})${citationNote} — standard improvement pass warranted`,
  };
}

// ── Main triage phase ────────────────────────────────────────────────────────

export async function triagePhase(page: PageData, lastEdited: string): Promise<TriageResult> {
  log('triage', `Checking for news since ${lastEdited}: "${page.title}"`);

  const filePath = getFilePath(page.path);
  const currentContent = fs.readFileSync(filePath, 'utf-8');

  const contentAfterFm = stripFrontmatter(currentContent);
  const contentPreview = contentAfterFm.slice(0, 500);

  // ── Quality signal (rule-based, free) ─────────────────────────────────────
  const citationCount = countFootnoteRefs(contentAfterFm);
  const qualityResult = qualityBasedTier(page.quality, citationCount);

  if (qualityResult) {
    log('triage', `Quality signal: ${qualityResult.tier} — ${qualityResult.reason}`);
  } else {
    log('triage', 'No quality score in frontmatter — quality signal skipped');
  }

  // ── News signal (LLM-based, ~$0.08) ──────────────────────────────────────
  const searchQuery = `${page.title} developments news ${lastEdited} to ${new Date().toISOString().slice(0, 10)}`;
  const scryQuery = page.title;

  const [webResults, scryResults] = await Promise.all([
    executeWebSearch(searchQuery).catch(err => `Web search failed: ${err.message}`),
    executeScrySearch(scryQuery).catch(err => `SCRY search failed: ${err.message}`),
  ]);

  const classificationPrompt = `You are triaging whether a wiki page needs updating.

## Page
- Title: ${page.title}
- ID: ${page.id}
- Last edited: ${lastEdited}
- Content preview: ${contentPreview}

## Recent Web Results
${webResults}

## Recent EA Forum / LessWrong Results (SCRY)
${scryResults}

## Task

Based on the search results, determine if there are significant new developments since ${lastEdited} that warrant updating this page.

Classify into one of these tiers:

- **skip**: No meaningful new developments found. Page content is still current.
- **polish**: Minor updates only — small corrections, formatting, or very minor new info. (~$2-3)
- **standard**: Notable new developments that should be added — new papers, policy changes, funding rounds, etc. (~$5-8)
- **deep**: Major developments requiring thorough research — new organizations, paradigm shifts, major incidents, etc. (~$10-15)

Output ONLY a JSON object:
{
  "recommendedTier": "skip|polish|standard|deep",
  "reason": "1-2 sentence explanation of why this tier",
  "newDevelopments": ["list", "of", "specific", "new", "developments", "found"]
}`;

  const result = await runAgent(classificationPrompt, {
    model: MODELS.haiku,
    maxTokens: 1000,
  });

  const parsed = parseJsonFromLlm<{ recommendedTier: string; reason: string; newDevelopments: string[] }>(
    result,
    'triage',
    () => ({ recommendedTier: 'standard', reason: 'Triage parsing failed, using default', newDevelopments: [] }),
  );

  const validTiers: string[] = ['skip', 'polish', 'standard', 'deep'];
  const newsTier = (validTiers.includes(parsed.recommendedTier)
    ? parsed.recommendedTier
    : 'standard') as Tier;

  // ── Combine signals ────────────────────────────────────────────────────────
  //
  // Take the more intensive tier from news and quality signals.
  // This means:
  //   - If news is "deep" and quality is "polish", result is "deep" (news urgency wins)
  //   - If news is "skip" and quality is "standard", result is "standard" (quality gaps win)
  //   - If news is "skip" and no quality signal, result is "skip"
  //
  // Rationale: quality deficits are independent of news freshness. A page that
  // is outdated AND low-quality needs at least as much work as the higher signal demands.

  const qualityTier = qualityResult?.tier ?? null;
  let finalTier: Tier;
  let finalReason: string;

  if (qualityTier === null) {
    // No quality signal — use news signal alone
    finalTier = newsTier;
    finalReason = parsed.reason || '';
  } else {
    finalTier = maxTier(newsTier, qualityTier);
    if (finalTier === newsTier && finalTier !== qualityTier) {
      // News signal was dominant
      finalReason = `${parsed.reason || ''} (quality signal: ${qualityResult!.reason})`;
    } else if (finalTier === qualityTier && finalTier !== newsTier) {
      // Quality signal was dominant
      finalReason = `${qualityResult!.reason} (news signal: ${parsed.reason || 'no significant developments'})`;
    } else {
      // Both signals agree
      finalReason = `${parsed.reason || ''} | ${qualityResult!.reason}`;
    }
  }

  const costMap = { skip: '$0', polish: '$2-3', standard: '$5-8', deep: '$10-15' };

  const triageResult: TriageResult = {
    pageId: page.id,
    title: page.title,
    lastEdited,
    recommendedTier: finalTier,
    reason: finalReason,
    newDevelopments: parsed.newDevelopments || [],
    estimatedCost: costMap[finalTier],
    triageCost: '~$0.08',
    ...(qualityResult !== null && {
      qualitySignal: {
        qualityScore: page.quality!,
        qualityGrade: qualityResult.grade,
        citationCount,
        qualityRecommendedTier: qualityResult.tier,
        qualityReason: qualityResult.reason,
      },
    }),
  };

  writeTemp(page.id, 'triage.json', triageResult);
  log('triage', `Result: ${finalTier} — ${finalReason}`);
  return triageResult;
}
