/**
 * Fabricated Claims Injector
 *
 * Inserts a false but plausible-sounding sentence into the content, attributed
 * to an existing citation that doesn't actually support it. This is the most
 * dangerous type of hallucination — it looks sourced but isn't.
 *
 * The deterministic mode uses pre-written fabricated claims appropriate for
 * different entity types. The LLM mode generates contextually appropriate ones.
 */

import type { InjectedError } from '../types.ts';
import { stripFrontmatter } from '../../lib/patterns.ts';

// ---------------------------------------------------------------------------
// Pre-written fabricated claims by page type
// ---------------------------------------------------------------------------

const FABRICATED_CLAIMS: Record<string, string[]> = {
  organization: [
    'The organization reportedly underwent a significant leadership restructuring in early 2024, with several senior researchers departing to form independent safety labs.',
    'Internal documents revealed that the organization allocated approximately 35% of its compute budget to alignment research during this period.',
    'A 2023 audit found that the organization had maintained a consistent 4:1 ratio of capabilities to safety researchers since its founding.',
  ],
  person: [
    'They co-authored a widely discussed paper on mesa-optimization risks that accumulated over 500 citations within its first year.',
    'In a 2024 interview, they stated that their views on AI timelines had shifted significantly, estimating transformative AI by 2028.',
    'Their doctoral thesis, completed in 18 months, was later described by supervisors as one of the most influential in the department\'s history.',
  ],
  risk: [
    'A 2024 red-teaming exercise by a major AI lab demonstrated this risk in a controlled setting, though results were not publicly released.',
    'The probability of this risk materializing was estimated at 15-25% by a panel of 50 AI safety researchers surveyed in late 2024.',
    'Historical analysis suggests that analogous risks in other technological domains typically manifested within 5-10 years of initial identification.',
  ],
  concept: [
    'The concept was first formalized in a 2019 workshop paper that received limited attention until being independently rediscovered by two separate research groups in 2023.',
    'Empirical testing on language models showed that this approach reduced alignment failures by approximately 60% in controlled benchmarks.',
    'Critics have noted that the concept relies on assumptions about goal stability that have been formally disproven in the multi-agent setting.',
  ],
  default: [
    'Recent analysis suggests this represents a more significant trend than initially reported, with implications extending beyond the immediate domain.',
    'Independent verification in 2024 confirmed the core findings, though with a larger margin of error than originally published.',
    'The underlying methodology has since been adopted by at least three major research institutions for their own assessments.',
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectPageType(content: string): string {
  const lower = content.toLowerCase();
  if (lower.includes('/people/') || lower.includes('researcher') || lower.includes('born in')) return 'person';
  if (lower.includes('/organizations/') || lower.includes('founded')) return 'organization';
  if (lower.includes('/risks/') || lower.includes('risk assessment')) return 'risk';
  if (lower.includes('/concepts/') || lower.includes('definition')) return 'concept';
  return 'default';
}

function findExistingFootnotes(content: string): number[] {
  const matches = content.matchAll(/\[\^(\d+)\]/g);
  const nums = new Set<number>();
  for (const m of matches) {
    nums.add(parseInt(m[1], 10));
  }
  return [...nums].sort((a, b) => a - b);
}

function findInsertionPoints(content: string): Array<{ index: number; paragraphIndex: number; sectionHeading?: string }> {
  const body = stripFrontmatter(content);
  const bodyStart = content.indexOf(body);
  const paragraphs = body.split(/\n\n+/);
  const points: Array<{ index: number; paragraphIndex: number; sectionHeading?: string }> = [];

  let searchFrom = 0;
  let currentHeading: string | undefined;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const trimmed = para.trim();
    // Find where this paragraph actually starts in the body
    const paraStart = body.indexOf(para, searchFrom);

    // Track current section heading
    const headingMatch = /^#{1,3}\s+(.+)/.exec(trimmed);
    if (headingMatch) {
      currentHeading = headingMatch[1];
    }

    // Good insertion points: after substantial paragraphs (not headings, not footnotes)
    if (trimmed.length > 100 && !trimmed.startsWith('#') && !trimmed.startsWith('[^') && !trimmed.startsWith('|')) {
      points.push({
        index: bodyStart + paraStart + para.length,
        paragraphIndex: i,
        sectionHeading: currentHeading,
      });
    }

    searchFrom = paraStart + para.length;
  }

  return points;
}

// ---------------------------------------------------------------------------
// Injector
// ---------------------------------------------------------------------------

/**
 * Insert fabricated claims that reference existing citations but aren't
 * actually supported by them.
 */
export async function injectFabricatedClaims(
  content: string,
  count: number,
  _useLlm: boolean,
): Promise<{ content: string; errors: InjectedError[] }> {
  const pageType = detectPageType(content);
  const claims = FABRICATED_CLAIMS[pageType] || FABRICATED_CLAIMS.default;
  const footnotes = findExistingFootnotes(content);
  const insertionPoints = findInsertionPoints(content);

  if (insertionPoints.length === 0 || footnotes.length === 0) {
    return { content, errors: [] };
  }

  // Select claims and insertion points
  const shuffledClaims = [...claims].sort(() => Math.random() - 0.5);
  const shuffledPoints = [...insertionPoints].sort(() => Math.random() - 0.5);

  let corrupted = content;
  const errors: InjectedError[] = [];
  // Process insertion points from end to start to preserve indices
  const selectedPairs: Array<{ claim: string; point: typeof insertionPoints[0]; footnote: number }> = [];

  for (let i = 0; i < Math.min(count, shuffledClaims.length, shuffledPoints.length); i++) {
    selectedPairs.push({
      claim: shuffledClaims[i],
      point: shuffledPoints[i],
      footnote: footnotes[Math.floor(Math.random() * footnotes.length)],
    });
  }

  // Sort by index descending for safe insertion
  selectedPairs.sort((a, b) => b.point.index - a.point.index);

  for (const { claim, point, footnote } of selectedPairs) {
    const fabricatedSentence = ` ${claim}[^${footnote}]`;

    // Insert after the paragraph
    corrupted = corrupted.slice(0, point.index) + fabricatedSentence + corrupted.slice(point.index);

    errors.push({
      id: `fabricated-claim-${errors.length}`,
      category: 'fabricated-claim',
      description: `Inserted fabricated claim after paragraph ${point.paragraphIndex}, attributed to footnote [^${footnote}]`,
      originalText: '',
      corruptedText: fabricatedSentence.trim(),
      paragraphIndex: point.paragraphIndex,
      sectionHeading: point.sectionHeading,
      detectability: 'medium',
    });
  }

  return { content: corrupted, errors };
}
