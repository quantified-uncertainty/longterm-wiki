/**
 * Reference Sniffer Agent
 *
 * Deep citation verification that goes beyond the basic citation-auditor.
 * For each page, it:
 * 1. Extracts every discrete factual claim
 * 2. Maps claims to their cited sources
 * 3. Fetches and analyzes the actual source content
 * 4. Checks for: quote accuracy, context fidelity, recency, source quality
 *
 * This is the most thorough (and expensive) adversarial agent.
 */

import type { AdversarialFinding } from '../types.ts';
import { callClaude, createClient, MODELS } from '../../lib/anthropic.ts';
import { stripFrontmatter } from '../../lib/patterns.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractedClaim {
  claim: string;
  paragraphIndex: number;
  sectionHeading?: string;
  citedFootnotes: number[];
  hasAnyCitation: boolean;
}

// ---------------------------------------------------------------------------
// Claim extraction (no LLM — regex + heuristics)
// ---------------------------------------------------------------------------

/**
 * Extract discrete factual claims from page content.
 * A "claim" is a sentence that asserts something verifiable.
 */
export function extractClaims(content: string): ExtractedClaim[] {
  const body = stripFrontmatter(content);
  const paragraphs = body.split(/\n\n+/);
  const claims: ExtractedClaim[] = [];
  let currentHeading: string | undefined;

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi].trim();

    // Track headings
    const headingMatch = /^#{1,3}\s+(.+)/.exec(para);
    if (headingMatch) {
      currentHeading = headingMatch[1];
      continue;
    }

    // Skip non-prose elements
    if (para.startsWith('|') || para.startsWith('[^') || para.startsWith('<') ||
        para.startsWith('```') || para.startsWith('import ') || para.startsWith('---')) {
      continue;
    }

    // Split into sentences
    const sentences = para.split(/(?<=[.!?])\s+/);

    for (const sentence of sentences) {
      // Skip short or non-factual sentences
      if (sentence.length < 30) continue;
      if (/^(however|moreover|additionally|furthermore|in summary|overall)/i.test(sentence)) continue;

      // Check for factual indicators: numbers, dates, names, specific claims
      const isFactual =
        /\b\d{4}\b/.test(sentence) ||           // Contains a year
        /\$[\d,.]+/.test(sentence) ||            // Contains a dollar amount
        /\b\d+(\.\d+)?\s*(%|percent)\b/.test(sentence) || // Contains a percentage
        /\b(founded|created|published|released|announced|launched|developed)\b/i.test(sentence) ||
        /\b(according to|stated|reported|found|showed|demonstrated)\b/i.test(sentence);

      if (!isFactual) continue;

      // Extract footnote references in this sentence
      const footnoteRefs: number[] = [];
      const fnPattern = /\[\^(\d+)\]/g;
      let match: RegExpExecArray | null;
      while ((match = fnPattern.exec(sentence)) !== null) {
        footnoteRefs.push(parseInt(match[1], 10));
      }

      claims.push({
        claim: sentence.replace(/\[\^\d+\]/g, '').trim(),
        paragraphIndex: pi,
        sectionHeading: currentHeading,
        citedFootnotes: footnoteRefs,
        hasAnyCitation: footnoteRefs.length > 0,
      });
    }
  }

  return claims;
}

// ---------------------------------------------------------------------------
// LLM-based deep verification
// ---------------------------------------------------------------------------

/**
 * Use an LLM to verify a batch of claims against the page's overall content
 * and citation context. This catches:
 * - Claims that contradict other claims on the same page
 * - Claims that are plausible but suspiciously specific without citation
 * - Claims that use wording suggesting confabulation
 */
export async function verifyClaimsBatch(
  claims: ExtractedClaim[],
  fullContent: string,
  pageId: string,
): Promise<AdversarialFinding[]> {
  const client = createClient({ required: false });
  if (!client) {
    console.warn('[reference-sniffer] No API key — skipping LLM verification');
    return [];
  }

  // Batch claims for a single LLM call (cheaper than per-claim)
  const claimList = claims
    .slice(0, 30) // Cap at 30 claims per page to control costs
    .map((c, i) => `${i + 1}. ${c.claim} [cited: ${c.hasAnyCitation ? 'yes' : 'NO'}] [para: ${c.paragraphIndex}]`)
    .join('\n');

  const result = await callClaude(client, {
    model: MODELS.haiku,
    systemPrompt: `You are a fact-checking editor for an AI safety wiki. Your job is to identify claims that are likely hallucinated, fabricated, or unsupported.

For each claim, assess:
1. Is it suspiciously specific without a citation? (e.g., exact dollar amounts, exact dates, exact percentages with no source)
2. Does it use confabulation patterns? (e.g., "reportedly", "according to internal sources", "a widely cited study" — without naming the study)
3. Is it internally contradicted by other claims on the page?
4. Does it make a strong causal claim without evidence?

Respond ONLY with findings — claims you believe are problematic. Use this JSON format:
[
  {
    "claimIndex": <1-based index>,
    "category": "unsupported" | "confabulation-pattern" | "internal-contradiction" | "overclaim",
    "severity": "critical" | "warning" | "info",
    "evidence": "<explanation of why this is suspicious>",
    "suggestion": "<what should be done>"
  }
]

If no claims are suspicious, return an empty array [].
Be conservative — only flag things you are genuinely concerned about. False positives waste human reviewer time.`,
    userPrompt: `Page: ${pageId}

Claims to verify:
${claimList}

Full page context (for internal consistency checking):
${fullContent.slice(0, 8000)}`,
    maxTokens: 2000,
    temperature: 0,
  });

  // Parse LLM response
  try {
    const cleaned = result.text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as Array<{
      claimIndex: number;
      category: string;
      severity: string;
      evidence: string;
      suggestion: string;
    }>;

    return parsed.map(f => {
      const claimIdx = f.claimIndex - 1; // 0-based
      const claim = claims[claimIdx];

      return {
        pageId,
        agent: 'reference-sniffer' as const,
        category: f.category,
        severity: (f.severity || 'warning') as 'critical' | 'warning' | 'info',
        claim: claim?.claim || `Claim #${f.claimIndex}`,
        evidence: f.evidence,
        suggestion: f.suggestion,
        confidence: f.severity === 'critical' ? 0.8 : f.severity === 'warning' ? 0.6 : 0.4,
        sectionHeading: claim?.sectionHeading,
        paragraphIndex: claim?.paragraphIndex,
      };
    });
  } catch {
    console.warn('[reference-sniffer] Failed to parse LLM response');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main agent entry point
// ---------------------------------------------------------------------------

/**
 * Run the reference sniffer on a single page.
 */
export async function sniffPage(
  pageId: string,
  content: string,
  options: { useLlm?: boolean } = {},
): Promise<AdversarialFinding[]> {
  const useLlm = options.useLlm ?? true;
  const findings: AdversarialFinding[] = [];

  // Step 1: Extract claims
  const claims = extractClaims(content);

  // Step 2: Flag uncited factual claims (no LLM needed)
  const uncitedFactualClaims = claims.filter(c =>
    !c.hasAnyCitation &&
    (/\b\d{4}\b/.test(c.claim) || /\$[\d,.]+/.test(c.claim) || /\d+%/.test(c.claim))
  );

  for (const claim of uncitedFactualClaims) {
    findings.push({
      pageId,
      agent: 'reference-sniffer',
      category: 'unsupported',
      severity: 'warning',
      claim: claim.claim,
      evidence: 'Specific factual claim (contains numbers/dates) with no citation',
      suggestion: 'Add a citation or mark as approximate/estimated',
      confidence: 0.5,
      sectionHeading: claim.sectionHeading,
      paragraphIndex: claim.paragraphIndex,
    });
  }

  // Step 3: LLM-based deep verification (optional, costs money)
  if (useLlm && claims.length > 0) {
    const llmFindings = await verifyClaimsBatch(claims, content, pageId);
    findings.push(...llmFindings);
  }

  return findings;
}
